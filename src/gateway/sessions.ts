// Sign-in sessions (docs/deployment-railway.md "Sessions"): the browser
// holds a random 32-byte id in an HttpOnly cookie; the database keeps only
// its SHA-256, so a leaked database cannot be replayed. A session slides 14
// days past its last use, never beyond 30 days from sign-in, and every
// session of a user goes when their password changes or is reset.

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

export function cookieName(opts: CookieOptions): string {
  return opts.secure ? "__Host-sd_session" : "sd_session";
}

export function sessionCookie(token: string, opts: CookieOptions, maxAgeMs = SESSION_MAX_MS): string {
  const parts = [
    `${cookieName(opts)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(opts: CookieOptions): string {
  return sessionCookie("", opts, 0);
}

/** The session token a request carries, or null. */
export function readSessionToken(req: Request, opts: CookieOptions): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = cookieName(opts);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** The request's Cookie header with the gateway's own cookie taken out, or null when nothing is left. */
export function cookiesWithout(header: string | null, opts: CookieOptions): string | null {
  if (!header) return null;
  const name = cookieName(opts);
  const kept = header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && p.slice(0, p.indexOf("=")).trim() !== name);
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

  /** The signed-in user for a token, sliding its expiry; null when unknown or expired. */
  lookup(token: string | null): SessionUser | null {
    if (!token) return null;
    const idHash = hashToken(token);
    const row = this.db
      .query(
        `SELECT s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
                s.last_seen_at AS lastSeenAt, u.email AS email
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .get(idHash) as
      | { userId: string; createdAt: number; expiresAt: number; lastSeenAt: number; email: string }
      | null;
    if (!row) return null;
    const now = this.now();
    if (now >= row.expiresAt || now >= row.createdAt + SESSION_MAX_MS) {
      this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
      return null;
    }
    if (now - row.lastSeenAt >= TOUCH_EVERY_MS) {
      const expiresAt = Math.min(now + SESSION_IDLE_MS, row.createdAt + SESSION_MAX_MS);
      this.db
        .query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
        .run(now, expiresAt, idHash);
    }
    return { userId: row.userId, email: row.email };
  }

  revoke(token: string | null): void {
    if (token) this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(hashToken(token));
  }

  revokeAll(userId: string): void {
    this.db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  /** Drop expired rows; run now and then. */
  sweep(): void {
    const now = this.now();
    this.db
      .query("DELETE FROM sessions WHERE expires_at <= ? OR created_at + ? <= ?")
      .run(now, SESSION_MAX_MS, now);
  }
}
