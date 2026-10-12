// Accounts (docs/deployment-railway.md "Password recovery flow"): email and
// password, hashed with argon2id (Bun.password). Signing up and resetting a
// password share one mechanism — a single-use emailed link, stored as its
// SHA-256 — so an account gets its first password only from someone who can
// read the inbox, and nobody can sign up in another person's name.
//
// The methods that send mail answer the same way whether or not the address
// has an account; the HTTP layer (server.ts) does not wait for them, so the
// response time does not tell either.

import type { Database } from "bun:sqlite";
import { hashToken, randomToken } from "./crypto";
import { templates, type Mailer } from "./mail";
import type { Sessions } from "./sessions";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
/** Workers run as uids from here up — clear of any account the image has. */
export const OS_UID_BASE = 200_000;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "password1234",
  "password12345",
  "passwordpassword",
  "qwertyuiopas",
  "qwerty123456",
  "iloveyou1234",
  "aaaaaaaaaaaa",
  "letmein12345",
  "welcome12345",
  "specdriven123",
]);

export interface AccountsOptions {
  /** The address email links point at, e.g. https://specs.example.com. */
  baseUrl: () => string;
  now?: () => number;
}

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
}

/** Normalized email, or null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Why a password is refused, or null when it is fine. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string") return "A password is required";
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) return "That password is too common";
  if (email && lower.includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) {
    return "Don't use your email address in your password";
  }
  return null;
}

// A real argon2id hash to verify against when the email is unknown, so a
// failed sign-in takes as long whether or not the account exists.
let dummyHash: Promise<string> | null = null;
function timingDummy(): Promise<string> {
  dummyHash ??= Bun.password.hash(randomToken());
  return dummyHash;
}

export class Accounts {
  private now: () => number;

  constructor(
    private db: Database,
    private sessions: Sessions,
    private mailer: Mailer,
    private opts: AccountsOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  private findUser(email: string): UserRow | null {
    return this.db
      .query("SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?")
      .get(email) as UserRow | null;
  }

  emailOf(userId: string): string | null {
    const row = this.db.query("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | null;
    return row?.email ?? null;
  }

  /**
   * The Linux uid this user's worker runs as (workers.ts): handed out once,
   * counting up from OS_UID_BASE, and kept for good.
   */
  osUid(userId: string): number {
    this.db
      .query(
        `UPDATE users SET os_uid = (SELECT COALESCE(MAX(os_uid), ?) + 1 FROM users)
         WHERE id = ? AND os_uid IS NULL`,
      )
      .run(OS_UID_BASE - 1, userId);
    const row = this.db.query("SELECT os_uid AS uid FROM users WHERE id = ?").get(userId) as { uid: number } | null;
    if (!row) throw new Error(`No user ${userId}`);
    return row.uid;
  }

  /** Whether this address may create an account: it or its @domain is on the admins' list (admin.ts). */
  mayJoin(email: string): boolean {
    const domain = email.slice(email.lastIndexOf("@"));
    return this.db.query("SELECT 1 FROM allowed_emails WHERE email IN (?, ?)").get(email, domain) !== null;
  }

  /** A fresh single-use link token for a user, retiring the older ones of that purpose. */
  private issueToken(userId: string, purpose: "verify" | "reset"): string {
    const token = randomToken();
    const now = this.now();
    const ttl = purpose === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS;
    this.db.transaction(() => {
      this.db
        .query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL")
        .run(now, userId, purpose);
      this.db
        .query(
          "INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(hashToken(token), userId, purpose, now, now + ttl);
    })();
    return token;
  }

  private link(token: string): string {
    return `${this.opts.baseUrl()}/set-password#token=${encodeURIComponent(token)}`;
  }

  /**
   * Sign up: email a link to choose the first password. An address that
   * already has an account gets a reset link instead; one that may not join
   * gets nothing. The caller answers "check your email" in every case.
   */
  async signup(email: string): Promise<void> {
    const user = this.findUser(email);
    if (user?.passwordHash) return this.forgot(email);
    if (!this.mayJoin(email)) return;
    const id = user?.id ?? crypto.randomUUID();
    if (!user) {
      this.db.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(id, email, this.now());
    }
    const token = this.issueToken(id, "verify");
    await this.mailer.send({ to: email, ...templates.setPassword(this.link(token)) });
  }

  /**
   * Forgotten password: email a reset link when the account exists. An
   * account that never chose a password gets its sign-up link again.
   */
  async forgot(email: string): Promise<void> {
    const user = this.findUser(email);
    if (!user) return;
    if (!user.passwordHash) {
      if (!this.mayJoin(email)) return;
      const token = this.issueToken(user.id, "verify");
      await this.mailer.send({ to: email, ...templates.setPassword(this.link(token)) });
      return;
    }
    const token = this.issueToken(user.id, "reset");
    await this.mailer.send({ to: email, ...templates.reset(this.link(token)) });
  }

  /**
   * Use an emailed link: set the password, confirm the address, retire every
   * other link and end every session. Returns the user's id, or an error
   * the page can show.
   */
  async setPassword(token: unknown, password: unknown): Promise<{ userId: string } | { error: string }> {
    if (typeof token !== "string" || !token) return { error: "This link is invalid or has expired" };
    const tokenHash = hashToken(token);
    const row = this.db
      .query(
        `SELECT t.user_id AS userId, t.purpose AS purpose, u.email AS email FROM email_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?`,
      )
      .get(tokenHash, this.now()) as { userId: string; purpose: "verify" | "reset"; email: string } | null;
    if (!row) return { error: "This link is invalid or has expired — ask for a new one" };
    // A weak password does not use the link up: the person tries another.
    const problem = passwordProblem(password, row.email);
    if (problem) return { error: problem };
    const hash = await Bun.password.hash(password as string, { algorithm: "argon2id" });
    const now = this.now();
    const claimed = this.db.transaction(() => {
      // Claim the link atomically: of two concurrent uses, one wins.
      const used = this.db
        .query("UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
        .run(now, tokenHash);
      if (used.changes !== 1) return false;
      this.db.query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, row.userId);
      this.db
        .query(
          `UPDATE users SET password_hash = ?, password_changed_at = ?,
             email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
        )
        .run(hash, now, now, row.userId);
      return true;
    })();
    if (!claimed) return { error: "This link was already used — ask for a new one" };
    this.sessions.revokeAll(row.userId);
    if (row.purpose === "reset") this.notifyChanged(row.email);
    return { userId: row.userId };
  }

  /** The user a correct email and password belong to, or null. */
  async login(email: string, password: unknown): Promise<string | null> {
    if (typeof password !== "string" || password.length > PASSWORD_MAX) return null;
    const user = this.findUser(email);
    if (!user?.passwordHash) {
      await Bun.password.verify(password, await timingDummy());
      return null;
    }
    return (await Bun.password.verify(password, user.passwordHash)) ? user.id : null;
  }

  /** Change the password while signed in: the current one first. Ends every other session. */
  async changePassword(userId: string, current: unknown, next: unknown): Promise<{ ok: true } | { error: string }> {
    const row = this.db
      .query("SELECT email, password_hash AS passwordHash FROM users WHERE id = ?")
      .get(userId) as { email: string; passwordHash: string | null } | null;
    if (!row?.passwordHash || typeof current !== "string") return { error: "The current password is wrong" };
    if (!(await Bun.password.verify(current, row.passwordHash))) return { error: "The current password is wrong" };
    const problem = passwordProblem(next, row.email);
    if (problem) return { error: problem };
    const hash = await Bun.password.hash(next as string, { algorithm: "argon2id" });
    this.db.query("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(hash, this.now(), userId);
    this.db.query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(this.now(), userId);
    this.sessions.revokeAll(userId);
    this.notifyChanged(row.email);
    return { ok: true };
  }

  private notifyChanged(email: string): void {
    this.mailer.send({ to: email, ...templates.passwordChanged() }).catch((e) => {
      console.error(`password change notice to ${email} failed: ${(e as Error).message}`);
    });
  }
}
