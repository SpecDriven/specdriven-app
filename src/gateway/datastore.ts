// The gateway's datastore (docs/deployment-railway.md "Datastore"): the
// accounts in app.db mirrored, as one JSON file per table, into a private
// GitHub repository, so a redeploy without the volume still knows everyone.
// On start an empty database is filled from the repo; while running, every
// change worth keeping is committed and pushed within a tick; on SIGTERM the
// rest goes before the gateway exits.
//
// What is copied is what app.db already holds in a form safe to copy:
// password hashes, session hashes (never the cookie), and secrets still
// sealed under SPECDRIVEN_MASTER_KEY, which never goes into the repo.
// Sessions lose their ip, user agent and last-seen time on the way; email
// links and rate-limit counters are short-lived and stay behind.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAuthFailure, subprocessRun, tokenContext, type GitRun } from "../server/git/cli";
import { hashToken } from "./crypto";
import { SESSION_MAX_MS } from "./sessions";

type Env = Record<string, string | undefined>;

export const DEFAULT_DATASTORE_REPO = "https://github.com/SpecDriven/hosted-app";
/** How often a changed snapshot is pushed. */
export const DATASTORE_SAVE_MS = 30_000;

export interface DatastoreConfig {
  /** A GitHub token that can read and write the repo's contents. */
  token: string;
  repo: string;
}

/** The datastore settings; null when no token is set and app.db stands alone. */
export function readDatastoreConfig(env: Env = process.env): DatastoreConfig | null {
  const token = env.SPECDRIVEN_DATASTORE_TOKEN?.trim();
  if (!token) return null;
  return { token, repo: env.SPECDRIVEN_DATASTORE_REPO?.trim() || DEFAULT_DATASTORE_REPO };
}

/** Git as the datastore's token, committing as the gateway. */
export function datastoreGit(token: string): GitRun {
  const context = tokenContext(token, "SpecDriven gateway", "gateway@specdriven.invalid");
  return subprocessRun(async () => context);
}

interface Table {
  file: string;
  name: string;
  columns: string[];
  orderBy: string;
  /** Columns holding bytes, written as base64. */
  blobs?: string[];
}

// In insert order: the rows below reference users.
const TABLES: Table[] = [
  {
    file: "users.json",
    name: "users",
    columns: ["id", "email", "password_hash", "email_verified_at", "created_at", "password_changed_at", "os_uid"],
    orderBy: "id",
  },
  { file: "invites.json", name: "invites", columns: ["email", "invited_by", "created_at"], orderBy: "email" },
  {
    file: "secrets.json",
    name: "secrets",
    columns: ["user_id", "name", "kind", "ciphertext", "iv", "key_id", "meta", "updated_at"],
    orderBy: "user_id, name",
    blobs: ["ciphertext", "iv"],
  },
  {
    file: "sessions.json",
    name: "sessions",
    columns: ["id_hash", "user_id", "created_at", "expires_at"],
    orderBy: "id_hash",
  },
];

export const DATASTORE_FILES = TABLES.map((t) => t.file);

type Row = Record<string, unknown>;

/** The tables as the repo's files: file name → content. */
export function exportSnapshot(db: Database): Record<string, string> {
  const files: Record<string, string> = {};
  for (const table of TABLES) {
    const rows = db.query(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy}`).all() as Row[];
    for (const row of rows) {
      for (const column of table.blobs ?? []) row[column] = Buffer.from(row[column] as Uint8Array).toString("base64");
    }
    files[table.file] = JSON.stringify(rows, null, 2) + "\n";
  }
  return files;
}

/**
 * What a snapshot says that is worth a commit. A session's sliding expiry
 * moves with every minute of use, so it is left out: sign-ins, sign-outs and
 * account changes are pushed as they happen, expiries on shutdown.
 */
export function snapshotFingerprint(files: Record<string, string>): string {
  const parts = DATASTORE_FILES.map((file) => {
    const content = files[file] ?? "";
    if (file !== "sessions.json" || !content) return content;
    const sessions = JSON.parse(content) as Row[];
    return JSON.stringify(sessions.map(({ expires_at: _, ...rest }) => rest));
  });
  return hashToken(parts.join("\0"));
}

/** Fill the tables from the repo's files, all or nothing; expired sessions are left out. */
export function importSnapshot(db: Database, files: Record<string, string>, now = Date.now()): void {
  db.transaction(() => {
    for (const table of TABLES) {
      const content = files[table.file];
      if (!content) continue;
      let rows = JSON.parse(content) as Row[];
      if (table.name === "sessions") {
        rows = rows.filter(
          (s) => (s.expires_at as number) > now && (s.created_at as number) + SESSION_MAX_MS > now,
        );
      }
      const columns = table.name === "sessions" ? [...table.columns, "last_seen_at"] : table.columns;
      const insert = db.query(
        `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        const values = columns.map((column) => {
          if (column === "last_seen_at") return now;
          const value = row[column] ?? null;
          return table.blobs?.includes(column) ? Buffer.from(value as string, "base64") : value;
        });
        insert.run(...(values as (string | number | null | Buffer)[]));
      }
    }
  })();
}

export interface DatastoreOptions {
  db: Database;
  /** The clone lives in <dataDir>/datastore, beside app.db and as private. */
  dataDir: string;
  repo: string;
  git: GitRun;
  now?: () => number;
}

export class Datastore {
  readonly dir: string;
  /** Fingerprint of what the repo holds; null until restore() has run. */
  private saved: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: DatastoreOptions) {
    this.dir = join(opts.dataDir, "datastore");
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async git(...args: string[]): Promise<string> {
    const res = await this.opts.git(this.dir, ...args);
    if (res.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr + res.stdout).trim()}`);
    return res.stdout.trim();
  }

  private async succeeds(...args: string[]): Promise<boolean> {
    return (await this.opts.git(this.dir, ...args)).exitCode === 0;
  }

  /** The clone, made exactly the remote's branch; the branch's name. */
  private async syncClone(): Promise<string> {
    if (!existsSync(join(this.dir, ".git"))) {
      await mkdir(dirname(this.dir), { recursive: true });
      const res = await this.opts.git(null, "clone", this.opts.repo, this.dir);
      if (res.exitCode !== 0) {
        const output = (res.stderr + res.stdout).trim();
        throw new Error(
          isAuthFailure(output) ? "SPECDRIVEN_DATASTORE_TOKEN cannot read the repository" : `git clone failed: ${output}`,
        );
      }
    } else {
      await this.git("fetch", "origin");
    }
    // symbolic-ref, not rev-parse: it also names the branch of an empty repo.
    const branch = await this.git("symbolic-ref", "--short", "HEAD");
    if (await this.succeeds("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) {
      await this.git("reset", "--hard", `origin/${branch}`);
      await this.git("clean", "-fd");
    }
    return branch;
  }

  private async readFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const file of DATASTORE_FILES) {
      const path = join(this.dir, file);
      if (existsSync(path)) files[file] = await readFile(path, "utf8");
    }
    return files;
  }

  /**
   * Clone or update the repo, and fill an empty database from it. A database
   * that already has accounts is newer than the repo (the volume survived)
   * and is pushed over it on the next save. Throws when the repo cannot be
   * read: starting with no accounts and pushing that would lose them all.
   */
  restore(): Promise<{ imported: number }> {
    return this.locked(async () => {
      await this.syncClone();
      const files = await this.readFiles();
      const { count } = this.opts.db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number };
      let imported = 0;
      if (count === 0 && files["users.json"]) {
        importSnapshot(this.opts.db, files, (this.opts.now ?? Date.now)());
        imported = (JSON.parse(files["users.json"]) as Row[]).length;
      }
      this.saved = snapshotFingerprint(files);
      return { imported };
    });
  }

  /**
   * Commit and push the tables if they changed since the last push; force
   * pushes even a changed session expiry. True when a commit was pushed.
   */
  save({ force = false }: { force?: boolean } = {}): Promise<boolean> {
    return this.locked(async () => {
      if (this.saved === null) throw new Error("The datastore was never restored; refusing to push over it");
      const files = exportSnapshot(this.opts.db);
      const fingerprint = snapshotFingerprint(files);
      if (!force && fingerprint === this.saved) return false;
      let failure = "";
      // A second try covers a push that lost a race: refetch and rewrite.
      for (let attempt = 0; attempt < 2; attempt++) {
        const branch = await this.syncClone();
        for (const [file, content] of Object.entries(files)) await writeFile(join(this.dir, file), content);
        await this.git("add", "-A");
        if (await this.succeeds("diff", "--cached", "--quiet")) {
          this.saved = fingerprint;
          return false;
        }
        await this.git("commit", "-m", "Save accounts");
        const push = await this.opts.git(this.dir, "push", "origin", `HEAD:${branch}`);
        if (push.exitCode === 0) {
          this.saved = fingerprint;
          return true;
        }
        failure = (push.stderr + push.stdout).trim();
      }
      throw new Error(`git push failed: ${failure}`);
    });
  }

  /** Push changes every interval until stop(). */
  start(intervalMs = DATASTORE_SAVE_MS): void {
    this.timer = setInterval(() => {
      this.save().catch((e: Error) => console.error(`datastore save failed: ${e.message}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
