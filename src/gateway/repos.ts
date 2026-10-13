// Each user's recent data repos (docs/deployment-railway.md "Datastore"):
// the app keeps them in its settings file in the user's folder on the
// volume, which a redeploy without the volume loses — and then the next
// sign-in asks for a repo url again. So the gateway copies the list into
// app.db, which the datastore mirrors into GitHub, and writes it back into
// a settings file that is missing when it starts the user's worker.
//
// Only GitHub urls are kept: hosted mode has no local folders, and a path
// on a lost volume would name nothing. The settings file is the user's, so
// it is read and written as untrusted: no symlinks followed, no file of
// theirs overwritten, and nothing taken from it but repo urls.

import type { Database } from "bun:sqlite";
import { chown, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_KEY } from "../plugins/profile";
import { parseGitHubUrl } from "../server/repo";
import { MAX_RECENT_DATA_REPOS, STATE_DIR, STATE_FILE } from "../server/state";

/** Larger than any settings file the app writes; anything bigger is not read. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Canonical GitHub urls, deduplicated and capped, from a stored or read list. */
export function cleanRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const url = parseGitHubUrl(entry)?.url;
    if (!url || out.includes(url)) continue;
    out.push(url);
    if (out.length === MAX_RECENT_DATA_REPOS) break;
  }
  return out;
}

/** The users' remembered repos in app.db, most recent first. */
export class RecentRepos {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}

  get(userId: string): string[] {
    const row = this.db.query("SELECT repos FROM user_repos WHERE user_id = ?").get(userId) as
      | { repos: string }
      | null;
    if (!row) return [];
    try {
      return cleanRepos(JSON.parse(row.repos));
    } catch {
      return [];
    }
  }

  /** Store the list; true when it changed. An empty list forgets the user's. */
  set(userId: string, repos: string[]): boolean {
    const clean = cleanRepos(repos);
    if (JSON.stringify(clean) === JSON.stringify(this.get(userId))) return false;
    if (clean.length === 0) {
      this.db.query("DELETE FROM user_repos WHERE user_id = ?").run(userId);
    } else {
      this.db
        .query(
          `INSERT INTO user_repos (user_id, repos, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET repos = excluded.repos, updated_at = excluded.updated_at`,
        )
        .run(userId, JSON.stringify(clean), this.now());
    }
    return true;
  }
}

function settingsPaths(root: string) {
  const dir = join(root, STATE_DIR);
  return { dir, file: join(dir, STATE_FILE) };
}

/**
 * The repos a worker's settings file names, the open one first; null when
 * there is no settings file to read (nothing to learn, so nothing to forget).
 */
export async function readWorkerRepos(root: string): Promise<string[] | null> {
  const { dir, file } = settingsPaths(root);
  const [dirStat, fileStat] = await Promise.all([lstat(dir).catch(() => null), lstat(file).catch(() => null)]);
  if (!dirStat?.isDirectory() || !fileStat?.isFile() || fileStat.size > MAX_SETTINGS_BYTES) return null;
  let state: unknown;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null) return [];
  const { dataRepo, recentDataRepos } = state as { dataRepo?: unknown; recentDataRepos?: unknown };
  return cleanRepos([dataRepo, ...(Array.isArray(recentDataRepos) ? recentDataRepos : [])]);
}

/**
 * Give a worker with no settings file the remembered repos: the most recent
 * one open, the rest on its recent list. A file already there is the user's
 * and stays as it is. True when a file was written.
 */
export async function seedWorkerRepos(root: string, repos: string[], uid: number | null): Promise<boolean> {
  const clean = cleanRepos(repos);
  if (clean.length === 0) return false;
  const { dir, file } = settingsPaths(root);
  const dirStat = await lstat(dir).catch(() => null);
  if (!dirStat) {
    await mkdir(dir, { mode: 0o700 });
    if (uid !== null) await chown(dir, uid, uid);
  } else if (!dirStat.isDirectory()) {
    return false;
  }
  const state = {
    dataRepo: clean[0],
    recentDataRepos: clean,
    // Per-folder plugin lists from the start, as when the app records a
    // folder itself (src/plugins/profile.ts startFolderLists), so the file is
    // not read as one from before them.
    [PROFILE_KEY]: { repos: {} },
  };
  try {
    // "wx" fails on anything already at the path, a symlink included.
    await writeFile(file, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  if (uid !== null) await chown(file, uid, uid);
  return true;
}
