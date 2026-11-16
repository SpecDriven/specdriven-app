// Sign-in sessions (docs/deployment-railway.md "Sessions"): the browser
// holds a random 32-byte id in an HttpOnly cookie; the database keeps only
// its SHA-256, so a leaked database cannot be replayed. A session slides 14
// days past its last use, never beyond 30 days from sign-in, and every
// session of a user goes when their password changes or is reset.
//
// Where the account pages have a host of their own
// (docs/hosted-tenant-isolation.md "Step 2") there are two kinds. The
// account session is the sign-in: its cookie belongs to the account host
// and is what can change secrets and roles. The app session is made from
// it for the app's host, where a worker's answers are shown: its cookie
// reaches that person's worker and nothing else. It ends with the sign-in
// it came from. The way from one to the other is a code that works once
// (handover).

import type { Database } from "bun:sqlite";
import { hashToken, randomToken } from "./crypto";

export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60 * 1000;

export interface SessionUser {
  userId: string;
  email: string;
}

export interface CookieOptions {
  /** Over https: the __Host- prefixed, Secure cookie. Plain http in development. */
  secure: boolean;
}

/** The gateway's cookies: the sign-in, the app's session, and a hand-over under way. */
export const SESSION_COOKIE = "sd_session";
export const APP_COOKIE = "sd_app";
export const HANDOVER_COOKIE = "sd_handover";
const GATEWAY_COOKIES = [SESSION_COOKIE, APP_COOKIE, HANDOVER_COOKIE];

export type SessionKind = "account" | "app";

/** A hand-over code works for this long: one redirect's worth. */
export const HANDOVER_CODE_MS = 60 * 1000;
/** The browser's half of a hand-over is kept this long, for every tab that starts one. */
export const HANDOVER_STATE_MS = 10 * 60 * 1000;

export function cookieName(opts: CookieOptions, name: string = SESSION_COOKIE): string {
  return opts.secure ? `__Host-${name}` : name;
}

export function sessionCookie(
  token: string,
  opts: CookieOptions,
  maxAgeMs = SESSION_MAX_MS,
  name: string = SESSION_COOKIE,
): string {
  const parts = [
    `${cookieName(opts, name)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(opts: CookieOptions, name: string = SESSION_COOKIE): string {
  return sessionCookie("", opts, 0, name);
}

/** The value of one of the gateway's cookies on a request, or null. */
export function readCookie(req: Request, opts: CookieOptions, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const wanted = cookieName(opts, name);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === wanted) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** The session token a request carries, or null. */
export function readSessionToken(req: Request, opts: CookieOptions): string | null {
  return readCookie(req, opts, SESSION_COOKIE);
}

/** The request's Cookie header with the gateway's own cookies taken out, or null when nothing is left. */
export function cookiesWithout(header: string | null, opts: CookieOptions): string | null {
  if (!header) return null;
  const names = GATEWAY_COOKIES.map((name) => cookieName(opts, name));
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !names.includes(p.slice(0, p.indexOf("=")).trim()));
  return kept.length ? kept.join("; ") : null;
}

export class Sessions {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}

  /** Start a session; the raw token goes in the cookie and nowhere else. */
  create(userId: string, meta: { ip?: string | null; userAgent?: string | null } = {}): string {
    const token = randomToken();
    const now = this.now();
    this.db
      .query(
        `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, now, now + SESSION_IDLE_MS, now, meta.ip ?? null, meta.userAgent?.slice(0, 256) ?? null);
    return token;
  }

  /**
   * The signed-in user for a token of this kind, sliding its expiry; null
   * when unknown or expired. An app session is only as good as the sign-in
   * it came from, and using it keeps that sign-in alive too: someone who
   * works in the app every day never visits the account host.
   */
  lookup(token: string | null, kind: SessionKind = "account"): SessionUser | null {
    if (!token) return null;
    const idHash = hashToken(token);
    const row = this.live(idHash, kind);
    if (!row) return null;
    if (kind === "app" && (!row.parentHash || !this.live(row.parentHash, "account"))) {
      this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
      return null;
    }
    const now = this.now();
    if (now - row.lastSeenAt >= TOUCH_EVERY_MS) {
      for (const hash of [idHash, row.parentHash]) {
        if (!hash) continue;
        this.db
          .query("UPDATE sessions SET last_seen_at = ?, expires_at = MIN(?, created_at + ?) WHERE id_hash = ?")
          .run(now, now + SESSION_IDLE_MS, SESSION_MAX_MS, hash);
      }
    }
    return { userId: row.userId, email: row.email };
  }

  /** The session with this hash and kind, when it has not expired; an expired one is removed. */
  private live(idHash: string, kind: SessionKind) {
    const row = this.db
      .query(
        `SELECT s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
                s.last_seen_at AS lastSeenAt, s.parent_hash AS parentHash, u.email AS email
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.kind = ?`,
      )
      .get(idHash, kind) as
      | { userId: string; createdAt: number; expiresAt: number; lastSeenAt: number; parentHash: string | null; email: string }
      | null;
    if (!row) return null;
    const now = this.now();
    if (now >= row.expiresAt || now >= row.createdAt + SESSION_MAX_MS) {
      this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
      return null;
    }
    return row;
  }

  /** End a session; an app session made from it ends with it. */
  revoke(token: string | null): void {
    if (token) this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(hashToken(token));
  }

  /** End an app session together with the sign-in it came from: signing out in the app signs out. */
  revokeWithSignIn(appToken: string | null): void {
    if (!appToken) return;
    const idHash = hashToken(appToken);
    const row = this.db.query("SELECT parent_hash AS parentHash FROM sessions WHERE id_hash = ? AND kind = 'app'").get(idHash) as
      | { parentHash: string | null }
      | null;
    this.db.query("DELETE FROM sessions WHERE id_hash IN (?, ?)").run(idHash, row?.parentHash ?? idHash);
  }

  revokeAll(userId: string): void {
    this.db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  /**
   * A code that lets the app's host start a session of its own for the
   * signed-in browser: it works once, for a minute, and only together with
   * `state` — the secret the app's host put in that browser's cookie before
   * sending it here. Without the state a code made for one browser could be
   * fed to another, signing it in as someone else. Null when not signed in.
   */
  issueHandover(accountToken: string | null, state: string): string | null {
    if (!accountToken || !this.lookup(accountToken, "account")) return null;
    const code = randomToken();
    const now = this.now();
    this.db
      .query("INSERT INTO handover_codes (code_hash, session_hash, state_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(code), hashToken(accountToken), hashToken(state), now, now + HANDOVER_CODE_MS);
    return code;
  }

  /** Use a hand-over code: the app session's token, or null when the code or the state is not right. */
  redeemHandover(code: string | null, state: string | null, meta: { ip?: string | null; userAgent?: string | null } = {}): string | null {
    if (!code || !state) return null;
    const now = this.now();
    // Taken out as it is read: of two uses, one finds it.
    const row = this.db
      .query("DELETE FROM handover_codes WHERE code_hash = ? RETURNING session_hash AS sessionHash, state_hash AS stateHash, expires_at AS expiresAt")
      .get(hashToken(code)) as { sessionHash: string; stateHash: string; expiresAt: number } | null;
    if (!row || now >= row.expiresAt || row.stateHash !== hashToken(state)) return null;
    const signIn = this.live(row.sessionHash, "account");
    if (!signIn) return null;
    const token = randomToken();
    this.db
      .query(
        `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent, kind, parent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?)`,
      )
      .run(hashToken(token), signIn.userId, now, now + SESSION_IDLE_MS, now, meta.ip ?? null, meta.userAgent?.slice(0, 256) ?? null, row.sessionHash);
    return token;
  }

  /** Drop expired rows; run now and then. */
  sweep(): void {
    const now = this.now();
    this.db
      .query("DELETE FROM sessions WHERE expires_at <= ? OR created_at + ? <= ?")
      .run(now, SESSION_MAX_MS, now);
    this.db.query("DELETE FROM handover_codes WHERE expires_at <= ?").run(now);
  }
}
