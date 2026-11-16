// The gateway's database (bun:sqlite on the Railway volume): accounts and
// their roles, sessions and hand-over codes, email links, the allowed emails, the users'
// encrypted secrets, GitHub accounts and recent data repos, and the rate
// limiter's counters.
// Tokens of every kind are stored as SHA-256 hashes only, so a copy of the
// file cannot be replayed; secrets are AES-GCM ciphertext under a key that
// never touches the volume (crypto.ts).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MIGRATIONS: string[] = [
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
  // Roles (admin.ts): admins keep the list of who may sign up, which
  // replaces SPECDRIVEN_SIGNUP_ALLOWLIST and the invites any user could send.
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'));
  -- An email (a@b.c) or a whole domain (@b.c).
  ALTER TABLE invites RENAME TO allowed_emails;
  ALTER TABLE allowed_emails RENAME COLUMN invited_by TO added_by;
  `,
  // Recent data repos (repos.ts): what each user last opened, kept here so
  // the datastore carries it past a redeploy that loses their folder.
  `
  CREATE TABLE user_repos (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- A JSON array of GitHub urls, most recent first.
    repos TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // A host of its own for the account pages (sessions.ts): the app's host
  // gets a session of its own kind, made from the sign-in through a code
  // that works once, and gone when that sign-in ends.
  `
  ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'app'));
  ALTER TABLE sessions ADD COLUMN parent_hash TEXT REFERENCES sessions(id_hash) ON DELETE CASCADE;
  CREATE INDEX sessions_parent ON sessions(parent_hash);
  CREATE TABLE handover_codes (
    code_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
    state_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // Each person's GitHub account (githubLinks.ts), as they proved it on the
  // account page: who they are there, and no secret. The tokens their worker
  // uses are made for an hour and never stored.
  `
  CREATE TABLE github_links (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- One GitHub account, one person here: a GitHub account that is someone's
    -- already cannot be made another's (server.ts).
    github_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL,
    name TEXT,
    email TEXT NOT NULL,
    linked_at INTEGER NOT NULL
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
