// Git engine facade (specs/git-operations.spec.md). Callers keep one
// function surface; behind it, the Git engine setting picks who supplies the
// GitHub credentials. Both engines run the system `git` binary — the GitHub
// CLI engine adds gh's credential helper and `gh repo clone` on top — so git
// itself is required either way.

import type { GitBackend, PullResult, SyncResult } from "./backend";
import { cliBackend, cliGitAvailable } from "./cli";
import { ghAvailable, ghBackend, resetGhCache } from "./gh";

export type { PullResult, SyncResult } from "./backend";
export { cliGitAvailable } from "./cli";
export { ghAccount, ghAvailable, ghSignedIn } from "./gh";
export type { GhAccount } from "./gh";
export { isRepoRoot } from "./repoRoot";

export type GitEngine = "cli" | "gh";

/**
 * The engine a stored or posted value names; null for anything else — which
 * includes the retired `js` of the old built-in engine, so an existing
 * settings file simply reads as "no choice made".
 */
export function normalizeGitEngine(value: unknown): GitEngine | null {
  return value === "cli" || value === "gh" ? value : null;
}

// The engine chosen in Settings; null means "decide from what is installed".
let chosen: GitEngine | null = null;

/** Apply the engine chosen in Settings; null returns to the default. */
export function setGitEngine(engine: GitEngine | null): void {
  chosen = engine;
  // Settings is also where a mid-session `gh auth login` gets noticed.
  resetGhCache();
}

/** The engine in effect: the Settings choice, else gh when this machine has it. */
export function currentEngine(): GitEngine {
  return chosen ?? (ghAvailable() ? "gh" : "cli");
}

/**
 * The backend every operation runs on. Both engines shell out to git, so a
 * machine without git cannot do any of this — and an engine explicitly
 * chosen in Settings but no longer installed is an error, not a silent swap.
 */
function backend(): GitBackend {
  if (!cliGitAvailable()) {
    throw new Error("No git found — install git to work with repositories");
  }
  if (currentEngine() === "gh") {
    if (!ghAvailable()) {
      throw new Error(
        "GitHub CLI selected but no gh found — switch Git engine to System git in Settings",
      );
    }
    return ghBackend;
  }
  return cliBackend;
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
