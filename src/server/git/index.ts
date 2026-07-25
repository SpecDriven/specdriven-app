// Git engine facade (specs/git-operations.spec.md). Callers keep one
// function surface; behind it, the Git engine setting picks which engine
// carries the operation out and who supplies the GitHub credentials. Two
// engines run the system `git` binary — the GitHub CLI engine adds gh's
// credential helper and `gh repo clone` on top — and the third is git
// implemented in JavaScript, bundled with the app and always available.

import type { GitBackend, PullResult, SyncResult } from "./backend";
import { cliBackend, cliGitAvailable } from "./cli";
import { ghAvailable, ghBackend, resetGhCache } from "./gh";
import { jsBackend } from "./js";

export type { PullResult, SyncResult } from "./backend";
export { cliGitAvailable } from "./cli";
export { ghAccount, ghAvailable, ghSignedIn } from "./gh";
export type { GhAccount } from "./gh";
export { jsGitAvailable } from "./js";
export { isRepoRoot } from "./repoRoot";

export type GitEngine = "cli" | "gh" | "js";

/** The engine a stored or posted value names; null for anything else. */
export function normalizeGitEngine(value: unknown): GitEngine | null {
  return value === "cli" || value === "gh" || value === "js" ? value : null;
}

// The engine chosen in Settings; null means "decide from what is installed".
let chosen: GitEngine | null = null;

/** Apply the engine chosen in Settings; null returns to the default. */
export function setGitEngine(engine: GitEngine | null): void {
  chosen = engine;
  // Settings is also where a mid-session `gh auth login` gets noticed.
  resetGhCache();
}

/**
 * The engine in effect: the Settings choice, else the best of what this
 * machine has — the GitHub CLI, then the system git it builds on, and
 * failing both the bundled engine, which needs neither.
 */
export function currentEngine(): GitEngine {
  if (chosen) return chosen;
  if (ghAvailable()) return "gh";
  return cliGitAvailable() ? "cli" : "js";
}

/**
 * The backend every operation runs on. An engine explicitly chosen in
 * Settings but no longer installed is an error, not a silent swap to
 * another one.
 */
function backend(): GitBackend {
  switch (currentEngine()) {
    case "js":
      return jsBackend;
    case "gh":
      if (!ghAvailable()) {
        throw new Error(
          "GitHub CLI selected but no gh found — switch Git engine in Settings",
        );
      }
      if (!cliGitAvailable()) {
        throw new Error(
          "GitHub CLI selected but no git found — switch Git engine to Built-in in Settings",
        );
      }
      return ghBackend;
    default:
      if (!cliGitAvailable()) {
        throw new Error(
          "System git selected but no git found — switch Git engine to Built-in in Settings",
        );
      }
      return cliBackend;
  }
}

export async function pull(repoDir: string): Promise<PullResult> {
  return backend().pull(repoDir);
}

export async function push(repoDir: string): Promise<SyncResult> {
  return backend().push(repoDir);
}

export async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  return backend().theirsVersion(repoDir, relPath);
}

export async function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
): Promise<SyncResult> {
  return backend().resolveConflict(repoDir, relPath, content);
}

export async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  return backend().syncSavedChanges(repoDir);
}

export async function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
): Promise<SyncResult> {
  return backend().moveAndPush(repoDir, fromPath, toPath, message);
}

export async function removeAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  return backend().removeAndPush(repoDir, relPath, message);
}

export async function commitAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  return backend().commitAndPush(repoDir, relPath, message);
}

export async function hasUpstream(repoDir: string): Promise<boolean> {
  return backend().hasUpstream(repoDir);
}

export async function clone(url: string, dir: string): Promise<void> {
  return backend().clone(url, dir);
}
