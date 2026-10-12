// Roles and the allowed emails (docs/deployment-railway.md "Admins and the
// allowed emails"): every account is an admin or a user. Admins keep the
// list of who may create an account — whole addresses (a@b.c) or domains
// (@b.c) — and give or take the admin role; users only use the app. The
// list decides sign-up only: taking an address off it closes no account.
//
// The first admin is written into the code: a database with no admin makes
// ORIGINAL_ADMIN one, with a password chosen for it and kept here only as
// its argon2id hash, when the gateway starts. The last admin can never lose
// the role, so that happens once.

import type { Database } from "bun:sqlite";
import { normalizeEmail } from "./accounts";
import { templates, type Mailer } from "./mail";

export type Role = "admin" | "user";

export const ORIGINAL_ADMIN = "david@vydra.net";
const ORIGINAL_ADMIN_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$2RwP+xvpxA8g21/GQ4uMkkVeHvQp5dW5I8wqwNDVFL8$9fCpAK5+Rx/RY58HpWgEp9WRR94XlyDzUu0SHa7sxGs";

export interface AllowedEmail {
  /** An address, or @ and a domain. */
  email: string;
  /** The admin who added it, by email; null when that account is gone. */
  addedBy: string | null;
  createdAt: number;
}

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  /** False until the emailed link sets the first password. */
  hasPassword: boolean;
}

export interface AdminOptions {
  /** The address email links point at, e.g. https://specs.example.com. */
  baseUrl: () => string;
  now?: () => number;
}

/** A normalized entry for the allowed list — an email or an @domain — or null. */
export function normalizeAllowedEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const entry = raw.trim().toLowerCase();
  if (!entry.startsWith("@")) return normalizeEmail(entry);
  return entry.length <= 254 && /^@[^\s@]+\.[^\s@]+$/.test(entry) ? entry : null;
}

/**
 * Give a database with no admin its first one: ORIGINAL_ADMIN, with the
 * password chosen for it, replacing any the account had and ending its
 * sessions and links. Run it after the datastore's restore, so a fresh
 * volume takes the repo's accounts, admins included, first. True when it
 * made the admin.
 */
export function ensureOriginalAdmin(db: Database, now = Date.now()): boolean {
  return db.transaction(() => {
    if (db.query("SELECT 1 FROM users WHERE role = 'admin'").get()) return false;
    const existing = db.query("SELECT id FROM users WHERE email = ?").get(ORIGINAL_ADMIN) as { id: string } | null;
    if (existing) {
      db.query(
        `UPDATE users SET role = 'admin', password_hash = ?, password_changed_at = ?,
           email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
      ).run(ORIGINAL_ADMIN_PASSWORD_HASH, now, now, existing.id);
      db.query("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
      db.query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, existing.id);
    } else {
      db.query(
        `INSERT INTO users (id, email, password_hash, email_verified_at, created_at, password_changed_at, role)
         VALUES (?, ?, ?, ?, ?, ?, 'admin')`,
      ).run(crypto.randomUUID(), ORIGINAL_ADMIN, ORIGINAL_ADMIN_PASSWORD_HASH, now, now, now);
    }
    return true;
  })();
}

export class Admin {
  private now: () => number;

  constructor(
    private db: Database,
    private mailer: Mailer,
    private opts: AdminOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** An account's role, read with every request so a change applies at once. */
  roleOf(userId: string): Role {
    const row = this.db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: Role } | null;
    return row?.role ?? "user";
  }

  /** The allowed list, each entry with the admin who added it. */
  allowed(): AllowedEmail[] {
    return this.db
      .query(
        `SELECT a.email AS email, u.email AS addedBy, a.created_at AS createdAt
         FROM allowed_emails a LEFT JOIN users u ON u.id = a.added_by ORDER BY a.email`,
      )
      .all() as AllowedEmail[];
  }

  /** Let an address or a domain sign up (a normalized entry: normalizeAllowedEntry). */
  allow(adminId: string, entry: string): void {
    this.db
      .query("INSERT INTO allowed_emails (email, added_by, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
      .run(entry, adminId, this.now());
  }

  /** Email an allowed address the way to the sign-up page, unless it has an account already. */
  async invite(adminId: string, email: string): Promise<void> {
    const account = this.db.query("SELECT password_hash AS passwordHash FROM users WHERE email = ?").get(email) as
      | { passwordHash: string | null }
      | null;
    if (account?.passwordHash) return;
    const inviter = this.emailOf(adminId) ?? "A SpecDriven admin";
    const link = `${this.opts.baseUrl()}/signup?email=${encodeURIComponent(email)}`;
    await this.mailer.send({ to: email, ...templates.invite(link, inviter) });
  }

  /** Take an entry off the list; false when it was not on it. Accounts already made stay. */
  disallow(entry: string): boolean {
    return this.db.query("DELETE FROM allowed_emails WHERE email = ?").run(entry).changes > 0;
  }

  users(): UserSummary[] {
    const rows = this.db
      .query(
        `SELECT id, email, role, created_at AS createdAt, password_hash IS NOT NULL AS hasPassword
         FROM users ORDER BY email`,
      )
      .all() as (Omit<UserSummary, "hasPassword"> & { hasPassword: number })[];
    return rows.map((row) => ({ ...row, hasPassword: row.hasPassword === 1 }));
  }

  /** Give or take the admin role. The last admin keeps it, so the list always has a keeper. */
  setRole(userId: string, role: Role): { ok: true } | { error: string } {
    return this.db.transaction((): { ok: true } | { error: string } => {
      const row = this.db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: Role } | null;
      if (!row) return { error: "There is no such account" };
      if (row.role === "admin" && role !== "admin") {
        const { count } = this.db.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as {
          count: number;
        };
        if (count <= 1) return { error: "Make someone else an admin first: there must always be one" };
      }
      this.db.query("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
      return { ok: true };
    })();
  }

  private emailOf(userId: string): string | null {
    const row = this.db.query("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | null;
    return row?.email ?? null;
  }
}
