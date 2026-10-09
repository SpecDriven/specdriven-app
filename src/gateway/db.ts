// The gateway's database (bun:sqlite on the Railway volume): accounts,
// sessions, email links, invites, the users' encrypted secrets and the rate
// limiter's counters. Tokens of every kind are stored as SHA-256 hashes
// only, so a copy of the file cannot be replayed; secrets are AES-GCM
// ciphertext under a key that never touches the volume (crypto.ts).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- NULL until the emailed link sets the first password: an address
    -- nobody has proven they own cannot sign in.
    password_hash TEXT,
    email_verified_at INTEGER,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER,
    -- The Linux uid the user's worker runs as (workers.ts), handed out on
    -- its first start and kept, so their folder stays theirs.
    os_uid INTEGER UNIQUE
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
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX email_tokens_user ON email_tokens(user_id);
  CREATE TABLE invites (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE secrets (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('github', 'agent_key')),
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    key_id TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  );
  CREATE TABLE auth_attempts (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  `,
];

/** Open (creating if needed) and migrate the database at path; ":memory:" for tests. */
export function openDatabase(path: string): Database {
  // 0711: the workers, each its own uid, pass through to their folders
  // under users/ but cannot list or read what else is here (workers.ts).
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o711 });
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
