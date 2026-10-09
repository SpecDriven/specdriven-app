// Fixed-window rate limits for the sign-in, sign-up and reset endpoints,
// counted in the database so a restart does not reset them. Keys name what
// is limited: `login:email:<address>`, `forgot:ip:<ip>`, and so on.

import type { Database } from "bun:sqlite";

export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

export interface Limit {
  key: string;
  max: number;
  windowMs: number;
}

export class RateLimiter {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}

  /** Count one attempt against every limit; false when any of them is spent. */
  hit(...limits: Limit[]): boolean {
    let allowed = true;
    for (const limit of limits) {
      if (this.count(limit) > limit.max) allowed = false;
    }
    return allowed;
  }

  /** Whether the next attempt would be over any limit, without counting one. */
  blocked(...limits: Limit[]): boolean {
    const now = this.now();
    return limits.some((limit) => {
      const row = this.row(limit.key);
      return row !== null && now - row.windowStart < limit.windowMs && row.count >= limit.max;
    });
  }

  /** Forget a key — a successful sign-in clears its failures. */
  reset(key: string): void {
    this.db.query("DELETE FROM auth_attempts WHERE key = ?").run(key);
  }

  private row(key: string): { windowStart: number; count: number } | null {
    return this.db
      .query("SELECT window_start AS windowStart, count FROM auth_attempts WHERE key = ?")
      .get(key) as { windowStart: number; count: number } | null;
  }

  private count(limit: Limit): number {
    const now = this.now();
    const row = this.row(limit.key);
    if (!row || now - row.windowStart >= limit.windowMs) {
      this.db
        .query(
          `INSERT INTO auth_attempts (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        )
        .run(limit.key, now);
      return 1;
    }
    this.db.query("UPDATE auth_attempts SET count = count + 1 WHERE key = ?").run(limit.key);
    return row.count + 1;
  }

  /** Drop windows that ended long ago; run now and then. */
  sweep(olderThanMs = 24 * HOUR_MS): void {
    this.db.query("DELETE FROM auth_attempts WHERE window_start < ?").run(this.now() - olderThanMs);
  }
}
