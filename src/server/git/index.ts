// Git engine facade (specs/git-operations.spec.md). Callers keep one
// function surface; behind it, the Git engine setting picks which engine
// carries the operation out and who supplies the GitHub credentials. Two
// engines run the system `git` binary — the GitHub CLI engine adds gh's
// credential helper and `gh repo clone` on top — and the third is git
// implemented in JavaScript, bundled with the app and always available.

import type { Attributes } from "@opentelemetry/api";
import { isHostedMode } from "../hostedMode";
import { getLogger, withSpan } from "../telemetry";
import type { GitBackend, PathMove, PullResult, SyncResult } from "./backend";
import { cliBackend, cliGitAvailable } from "./cli";
import { ghAvailable, ghBackend, resetGhCache } from "./gh";
import { jsBackend } from "./js";

export type { PathMove, PullResult, SyncResult } from "./backend";
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
  // A hosted worker (src/server/hostedMode.ts) never uses gh: its
  // credentials would be the container's, not the signed-in user's.
  if (isHostedMode()) return chosen === "js" || !cliGitAvailable() ? "js" : "cli";
  if (chosen) return chosen;
  if (ghAvailable()) return "gh";
  return cliGitAvailable() ? "cli" : "js";
}

// A stand-in backend a test installs in place of every engine, for tests
// whose subject is not git (tests/helpers/fakeGit.ts). Never set by the app.
let substitute: GitBackend | null = null;

/** Route every git operation to `standIn` until called with null. For tests only. */
export function substituteGitBackend(standIn: GitBackend | null): void {
  substitute = standIn;
}

/**
 * The backend every operation runs on. An engine explicitly chosen in
 * Settings but no longer installed is an error, not a silent swap to
 * another one.
 */
function backend(): GitBackend {
  if (substitute) return substitute;
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

const log = getLogger("git");

function gitAttrs(repoDir: string): Attributes {
  return { "git.engine": currentEngine(), "specdriven.dir": repoDir };
}

/**
 * Span + logs around one git operation that commits or talks to the remote —
 * the whole sync surface funnels through here. Read-only helpers (stage
 * versions, diffs, …) stay untraced; they run inside these spans anyway.
 */
async function traced<T>(
  op: string,
  repoDir: string,
  run: () => Promise<T>,
  outcome: (result: T) => Attributes,
): Promise<T> {
  return withSpan(`git.${op}`, gitAttrs(repoDir), async (span) => {
    const result = await run();
    const attrs = outcome(result);
    span.setAttributes(attrs);
    log.debug(op, { "specdriven.dir": repoDir, ...attrs });
    return result;
  });
}

const syncOutcome = (result: SyncResult): Attributes => ({
  "git.pushed": result.pushed,
  "git.message": result.message,
});

export async function pull(repoDir: string): Promise<PullResult> {
  return traced("pull", repoDir, () => backend().pull(repoDir), (result) => ({
    "git.pull.ok": result.ok,
    "git.pull.conflicted_files": result.conflictedFiles.length,
    "git.message": result.message,
  }));
}

export async function push(repoDir: string): Promise<SyncResult> {
  return traced("push", repoDir, () => backend().push(repoDir), syncOutcome);
}

export async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  return backend().theirsVersion(repoDir, relPath);
}

export async function conflictedFiles(repoDir: string): Promise<string[]> {
  return backend().conflictedFiles(repoDir);
}

export async function stageVersion(
  repoDir: string,
  relPath: string,
  stage: 1 | 2 | 3,
): Promise<string | null> {
  return backend().stageVersion(repoDir, relPath, stage);
}

export async function diffNames(
  repoDir: string,
  from: string,
  to: string,
  pathspec: string,
): Promise<string[]> {
  return backend().diffNames(repoDir, from, to, pathspec);
}

export async function existsIn(repoDir: string, ref: string, relPath: string): Promise<boolean> {
  return backend().existsIn(repoDir, ref, relPath);
}

export async function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
  alsoAdd?: string[],
): Promise<SyncResult> {
  return withSpan(
    "git.resolve_conflict",
    { ...gitAttrs(repoDir), "specdriven.file": relPath },
    async (span) => {
      const result = await backend().resolveConflict(repoDir, relPath, content, alsoAdd);
      span.setAttributes(syncOutcome(result));
      log.info(`resolved conflict on ${relPath}`, { "git.pushed": result.pushed });
      return result;
    },
  );
}

export async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  return traced("sync_saved_changes", repoDir, () => backend().syncSavedChanges(repoDir), syncOutcome);
}

export async function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
  extraMoves?: PathMove[],
): Promise<SyncResult> {
  return traced(
    "move_and_push",
    repoDir,
    () => backend().moveAndPush(repoDir, fromPath, toPath, message, extraMoves),
    (result) => ({ ...syncOutcome(result), "git.from": fromPath, "git.to": toPath }),
  );
}

export async function removeAndPush(
  repoDir: string,
  paths: string | string[],
  message: string,
): Promise<SyncResult> {
  return traced("remove_and_push", repoDir, () => backend().removeAndPush(repoDir, paths, message), syncOutcome);
}

export async function commitAndPush(
  repoDir: string,
  paths: string | string[],
  message: string,
): Promise<SyncResult> {
  return traced("commit_and_push", repoDir, () => backend().commitAndPush(repoDir, paths, message), syncOutcome);
}

export async function hasUpstream(repoDir: string): Promise<boolean> {
  return backend().hasUpstream(repoDir);
}

export async function checkoutRef(repoDir: string, ref: string): Promise<string> {
  return traced("checkout_ref", repoDir, () => backend().checkoutRef(repoDir, ref), (commit) => ({
    "git.ref": ref,
    "git.commit": commit,
  }));
}

export async function headCommit(repoDir: string): Promise<string> {
  return backend().headCommit(repoDir);
}

export async function clone(url: string, dir: string): Promise<void> {
  return withSpan("git.clone", { ...gitAttrs(dir), "git.url": url }, async () => {
    log.info(`cloning ${url}`, { "specdriven.dir": dir });
    await backend().clone(url, dir);
  });
}
