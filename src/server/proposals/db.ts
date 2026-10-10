// The proposals service's database (bun:sqlite on the Railway volume): the
// GitHub accounts that signed in, their sessions, browser sign-ins in flight,
// the quota counters and an audit log of every proposal. No GitHub token of a
// visitor is ever stored — the one from the sign-in is used once to read who
// they are and dropped. Session ids and sign-in nonces are stored as SHA-256
// hashes only (src/gateway/crypto.ts hashToken).
//
// `sessions` and `auth_attempts` are the gateway's own tables, column for
// column, so its Sessions and RateLimiter classes work here unchanged; and
// `users` has the `id` and `email` columns Sessions joins on.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    -- The GitHub account id, as text: logins can be renamed, ids cannot.
    id TEXT PRIMARY KEY,
    -- The account's noreply address — what Sessions reports and what the
    -- visitor's commits are authored with, never their public email.
    email TEXT NOT NULL UNIQUE,
    login TEXT NOT NULL,
    name TEXT,
    -- 1 when the account can write to the spec repo (collaborator with
    -- write, maintain or admin), checked with the bot token now and then.
    contributor INTEGER NOT NULL DEFAULT 0,
    contributor_checked_at INTEGER,
    -- Set by an operator to stop an account from proposing.
    banned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE auth_attempts (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  CREATE TABLE oauth_flows (
    state_hash TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    file TEXT NOT NULL,
    scenario TEXT NOT NULL,
    new_feature INTEGER NOT NULL,
    commit_sha TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX proposals_user ON proposals(user_id, created_at);
  `,
];

/** Open (creating if needed) and migrate the database at path; ":memory:" for tests. */
export function openProposalsDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

/** A signed-in GitHub account as the service keeps it. */
export interface ProposerRow {
  id: string;
  email: string;
  login: string;
  name: string | null;
  contributor: boolean;
  contributorCheckedAt: number | null;
  bannedAt: number | null;
}

export function upsertProposer(
  db: Database,
  who: { id: string; email: string; login: string; name: string | null },
  now: number,
): void {
  db.query(
    `INSERT INTO users (id, email, login, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, login = excluded.login,
       name = excluded.name, last_seen_at = excluded.last_seen_at`,
  ).run(who.id, who.email, who.login, who.name, now, now);
}

export function getProposer(db: Database, id: string): ProposerRow | null {
  const row = db
    .query(
      `SELECT id, email, login, name, contributor, contributor_checked_at AS contributorCheckedAt,
              banned_at AS bannedAt FROM users WHERE id = ?`,
    )
    .get(id) as (Omit<ProposerRow, "contributor"> & { contributor: number }) | null;
  return row ? { ...row, contributor: row.contributor === 1 } : null;
}

export function setContributor(db: Database, id: string, contributor: boolean, now: number): void {
  db.query("UPDATE users SET contributor = ?, contributor_checked_at = ? WHERE id = ?").run(
    contributor ? 1 : 0,
    now,
    id,
  );
}

export function recordProposal(
  db: Database,
  row: { userId: string; file: string; scenario: string; newFeature: boolean; commit: string | null },
  now: number,
): void {
  db.query(
    `INSERT INTO proposals (user_id, file, scenario, new_feature, commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.userId, row.file, row.scenario, row.newFeature ? 1 : 0, row.commit, now);
}
