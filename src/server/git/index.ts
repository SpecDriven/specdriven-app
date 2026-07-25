// Git engine facade (specs/git-operations.spec.md). Callers keep the same
// function surface the old subprocess module had; behind it, the Git
// engine setting picks a strategy — the built-in JavaScript engine (the
// default, no git installation needed) or the system git binary. When the
// built-in engine cannot handle an operation it falls back to system git,
// and the repo stays on system git for the rest of the server run.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitBackend, PullResult, SyncResult } from "./backend";
import { GitUnsupportedError } from "./backend";
import { cliBackend, cliGitAvailable } from "./cli";
import { jsBackend, readPendingMerge } from "./js";
import { isRepoRoot } from "./repoRoot";

export type { PullResult, SyncResult } from "./backend";
export { GitUnsupportedError } from "./backend";
export { cliGitAvailable } from "./cli";
export { rewriteSshOrigin } from "./js";
export { isRepoRoot } from "./repoRoot";

export type GitEngine = "js" | "cli";

export function normalizeGitEngine(value: unknown): GitEngine | null {
  return value === "js" || value === "cli" ? (value as GitEngine) : null;
}

// The engine chosen in Settings; null means the default (built-in).
let chosen: GitEngine | null = null;
// Repos the built-in engine handed to system git for this server run.
const pinned = new Map<string, GitEngine>();

/** Apply the engine chosen in Settings; null returns to the default. */
export function setGitEngine(engine: GitEngine | null): void {
  chosen = engine;
  pinned.clear();
}

/** The effective engine new repos start on. */
export function currentEngine(): GitEngine {
  return chosen ?? "js";
}

/** The engine that handled the repo last, for display/diagnostics. */
export function engineFor(repoDir: string): GitEngine {
  if (chosen === "cli") return "cli";
  return pinned.get(repoDir) ?? currentEngine();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function requireCli(): GitBackend {
  if (!cliGitAvailable()) {
    throw new Error(
      "System git selected but no git found — switch Git engine to Built-in in Settings",
    );
  }
  return cliBackend;
}

/**
 * The backend an operation on repoDir must use. A repo with an unfinished
 * merge belongs to the engine that started it — the pending-merge file for
 * the built-in engine, .git/MERGE_HEAD for system git — no matter what the
 * setting says, so a mid-conflict engine switch can't corrupt the merge.
 */
async function backendFor(repoDir: string): Promise<GitBackend> {
  if (await readPendingMerge(repoDir)) return jsBackend;
  if (await exists(join(repoDir, ".git", "MERGE_HEAD"))) return requireCli();
  if (chosen === "cli") return requireCli();
  if (pinned.get(repoDir) === "cli" && cliGitAvailable()) return cliBackend;
  return jsBackend;
}

/**
 * Run an operation on the repo's engine; when the built-in engine throws
 * GitUnsupportedError and a system git exists, retry there and pin the
 * repo to system git for the rest of the run.
 */
async function withEngine<T>(
  repoDir: string,
  op: (backend: GitBackend) => Promise<T>,
  annotate?: (result: T) => T,
): Promise<T> {
  const backend = await backendFor(repoDir);
  if (backend.name === "cli") return op(backend);
  try {
    return await op(backend);
  } catch (e) {
    if (!(e instanceof GitUnsupportedError) || !cliGitAvailable()) throw e;
    pinned.set(repoDir, "cli");
    const result = await op(cliBackend);
    return annotate ? annotate(result) : result;
  }
}

const notedSync = (r: SyncResult): SyncResult => ({ ...r, message: `${r.message} (used system git)` });
const notedPull = (r: PullResult): PullResult => ({ ...r, message: `${r.message} (used system git)` });

export function pull(repoDir: string): Promise<PullResult> {
  return withEngine(repoDir, (b) => b.pull(repoDir), notedPull);
}

export function push(repoDir: string): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.push(repoDir), notedSync);
}

export function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  return withEngine(repoDir, (b) => b.theirsVersion(repoDir, relPath));
}

export function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.resolveConflict(repoDir, relPath, content), notedSync);
}

export function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.syncSavedChanges(repoDir), notedSync);
}

export function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.moveAndPush(repoDir, fromPath, toPath, message), notedSync);
}

export function removeAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.removeAndPush(repoDir, relPath, message), notedSync);
}

export function commitAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  return withEngine(repoDir, (b) => b.commitAndPush(repoDir, relPath, message), notedSync);
}

export function hasUpstream(repoDir: string): Promise<boolean> {
  return withEngine(repoDir, (b) => b.hasUpstream(repoDir));
}

/** Clone url into dir on the effective engine (keyed by the target dir). */
export function clone(url: string, dir: string): Promise<void> {
  return withEngine(dir, (b) => b.clone(url, dir));
}
