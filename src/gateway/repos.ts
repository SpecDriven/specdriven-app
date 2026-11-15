// Each user's recent data repos (docs/deployment-railway.md "Datastore"):
// the app keeps them in its settings file in the user's folder on the
// volume, which a redeploy without the volume loses — and then the next
// sign-in asks for a repo url again. So the gateway copies the list into
// app.db, which the datastore mirrors into GitHub, and writes it back into
// a settings file that is missing when it starts the user's worker.
//
// Only GitHub urls are kept: hosted mode has no local folders, and a path
// on a lost volume would name nothing. The settings file is the user's, in
// a folder they can rearrange, so root never opens it
// (docs/hosted-tenant-isolation.md "Step 1"): where workers have uids of
// their own the gateway reads it as that uid, and the worker writes the
// remembered repos for itself as it starts (workerStart.ts). Either way no
// file of theirs is overwritten and nothing is taken from it but repo urls.

import type { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_KEY } from "../plugins/profile";
import { GITHUB_HOST } from "../server/github";
import { parseGitHubUrl } from "../server/repo";
import { parseSettingsText, serializeSettings } from "../server/settingsFormat";
import { runAs } from "./limits";
import {
  LEGACY_JSON_STATE_FILE,
  MAX_RECENT_DATA_REPOS,
  SETTINGS_VERSION,
  STATE_DIR,
  STATE_FILE,
} from "../server/state";

/** The remembered repos, as JSON, for a worker that starts with no settings file (workerStart.ts). */
export const HOSTED_REPOS_ENV = "SPECDRIVEN_HOSTED_REPOS";

/** Larger than any settings file the app writes; anything bigger is not read. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** Canonical GitHub urls, deduplicated and capped, from a stored or read list. */
export function cleanRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const repo = parseGitHubUrl(entry);
    // The hosted app opens github.com repositories only.
    const url = repo?.host === GITHUB_HOST ? repo.url : null;
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

/** The worker's settings folder, its settings.yaml, and the settings.json
    an app from before YAML left there (read until that worker converts it). */
function settingsPaths(root: string) {
  const dir = join(root, STATE_DIR);
  return { dir, file: join(dir, STATE_FILE), json: join(dir, LEGACY_JSON_STATE_FILE) };
}

/**
 * The settings file as the gateway's own user reads it: settings.yaml, and
 * settings.json only without one; nothing that is not a plain file in a
 * plain folder, and nothing over the size limit.
 */
async function settingsText(root: string): Promise<{ file: string; text: string } | null> {
  const { dir, file: yaml, json } = settingsPaths(root);
  const [dirStat, yamlStat, jsonStat] = await Promise.all(
    [dir, yaml, json].map((path) => lstat(path).catch(() => null)),
  );
  const [file, fileStat] = yamlStat ? [yaml, yamlStat] : [json, jsonStat];
  if (!dirStat?.isDirectory() || !fileStat?.isFile() || fileStat.size > MAX_SETTINGS_BYTES) return null;
  return { file, text: await readFile(file, "utf8") };
}

/**
 * The same file read as the worker's uid, so whatever the worker put at
 * that path — a link, a pipe — reaches nothing the worker could not read
 * itself, and a read that never ends is stopped.
 */
async function settingsTextAs(uid: number, root: string): Promise<{ file: string; text: string } | null> {
  const { file: yaml, json } = settingsPaths(root);
  for (const file of [yaml, json]) {
    const res = await runAs(uid, ["head", "-c", String(MAX_SETTINGS_BYTES + 1), file], 10_000);
    if (res.exitCode !== 0) continue;
    return res.stdout.length > MAX_SETTINGS_BYTES ? null : { file, text: res.stdout };
  }
  return null;
}

/**
 * The repos a worker's settings file names, the open one first; null when
 * there is no settings file to read (nothing to learn, so nothing to forget).
 * `uid` is the worker's own where workers have one (workers.ts).
 */
export async function readWorkerRepos(root: string, uid: number | null = null): Promise<string[] | null> {
  const found = uid === null ? await settingsText(root) : await settingsTextAs(uid, root);
  if (!found) return null;
  let state: unknown;
  try {
    state = parseSettingsText(found.text, found.file);
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null) return [];
  const { dataRepo, recentFolders, recentDataRepos } = state as {
    dataRepo?: unknown;
    recentFolders?: unknown;
    recentDataRepos?: unknown;
  };
  // The specifications folders on the one folder list; a file the worker's
  // app has not rewritten since may still keep them as `recentDataRepos`.
  const listed = (Array.isArray(recentFolders) ? recentFolders : []).flatMap((e: unknown) => {
    const { path, kind } = (e ?? {}) as { path?: unknown; kind?: unknown };
    return kind === "spec" ? [path] : [];
  });
  return cleanRepos([dataRepo, ...listed, ...(Array.isArray(recentDataRepos) ? recentDataRepos : [])]);
}

/**
 * Give a worker with no settings file the remembered repos: the most recent
 * one open, the rest on its recent list. A file already there is the user's
 * and stays as it is. True when a file was written. The worker runs this
 * for itself as it starts (workerStart.ts), so the file is its own.
 */
export async function seedWorkerRepos(root: string, repos: string[]): Promise<boolean> {
  const clean = cleanRepos(repos);
  if (clean.length === 0) return false;
  const { dir, file, json } = settingsPaths(root);
  const dirStat = await lstat(dir).catch(() => null);
  if (!dirStat) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } else if (!dirStat.isDirectory()) {
    return false;
  } else if (await lstat(json).catch(() => null)) {
    // Settings from before YAML: the user's too, read until converted.
    return false;
  }
  const state = {
    settingsVersion: SETTINGS_VERSION,
    dataRepo: clean[0],
    recentFolders: clean.map((path) => ({ path, kind: "spec" })),
    // Per-folder plugin lists from the start, as when the app records a
    // folder itself (src/plugins/profile.ts startFolderLists), so the file is
    // not read as one from before them.
    [PROFILE_KEY]: { repos: {} },
  };
  try {
    // "wx" fails on anything already at the path, a symlink included.
    await writeFile(file, serializeSettings(state), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  return true;
}
