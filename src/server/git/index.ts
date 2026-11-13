// Git engine facade (git-operations.md). Callers keep one
// function surface; behind it, the Git engine setting picks which engine
// carries the operation out and who supplies the GitHub credentials. Two
// engines run the system `git` binary — the GitHub CLI engine adds gh's
// credential helper and `gh repo clone` on top — and the third is git
// implemented in JavaScript, bundled with the app and always available.

import type { Attributes } from "@opentelemetry/api";
import { rm } from "node:fs/promises";
import { isHostedMode } from "../hostedMode";
import { getLogger, withSpan } from "../telemetry";
import type { GitBackend, PathMove, PullResult, SyncResult } from "./backend";
import { cliBackend, cliGitAvailable } from "./cli";
import { ghAvailable, ghBackend, resetGhCache } from "./gh";
import { jsBackend } from "./js";
import { registerEngineLookup } from "./access";

export type { PathMove, PullResult, SyncResult } from "./backend";
export { cliGitAvailable } from "./cli";
export { ghAccount, ghAccountInUse, ghAvailable, ghHosts, ghSignedIn } from "./gh";
export type { GhAccount } from "./gh";
export { jsGitAvailable } from "./js";
export { currentGitAccess, effectiveGitAccess, normalizeGitAccess, setAppSignIn } from "./access";
export type { GitAccess } from "./access";
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

registerEngineLookup(currentEngine);

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
          "GitHub CLI selected but no gh found — install it, or pick another Git access in Settings",
        );
      }
      if (!cliGitAvailable()) {
        throw new Error(
          "GitHub CLI selected but no git found — install git, or pick Personal Access Token as the Git access in Settings",
        );
      }
      return ghBackend;
    default:
      if (!cliGitAvailable()) {
        throw new Error(
          "System git selected but no git found — pick the Git access again in Settings to use the built-in engine",
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

// Why each data folder's saved changes are not reaching its remote, while
// they are not (git-operations.md "a push that fails is shown, and tried
// again"). A failed push leaves its commits on this computer, where nothing
// used to say so: the tick's result went to the log and nowhere else. Held
// in memory only — the first tick after a start finds the stranded commits
// and tries them again, which sets it afresh.
const pushProblems = new Map<string, string>();

/** Why a folder's saved changes are not reaching the remote; null while they are. */
export function pushProblem(repoDir: string): string | null {
  return pushProblems.get(repoDir) ?? null;
}

/**
 * Keep a folder's push problem in step with one operation's result: a push
 * that went through clears it, one that failed sets it — once, as a warning
 * in the log, rather than on every tick that finds the same thing — and a
 * result that tried no push leaves it be, unless `settles` says the
 * operation looked at everything there was to push (the tick's own sync).
 */
function notePush(repoDir: string, result: SyncResult, settles = false): SyncResult {
  if (result.failure) {
    if (pushProblems.get(repoDir) !== result.failure) {
      log.warn(`push failed: ${result.failure}`, { "specdriven.dir": repoDir });
    }
    pushProblems.set(repoDir, result.failure);
  } else if (result.pushed || settles) {
    if (pushProblems.delete(repoDir)) log.info("saved changes reach the remote again", { "specdriven.dir": repoDir });
  }
  return result;
}

export async function pull(repoDir: string): Promise<PullResult> {
  return traced("pull", repoDir, () => backend().pull(repoDir), (result) => ({
    "git.pull.ok": result.ok,
    "git.pull.conflicted_files": result.conflictedFiles.length,
    "git.message": result.message,
  }));
}

export async function push(repoDir: string): Promise<SyncResult> {
  return notePush(repoDir, await traced("push", repoDir, () => backend().push(repoDir), syncOutcome));
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
      const result = notePush(repoDir, await backend().resolveConflict(repoDir, relPath, content, alsoAdd));
      span.setAttributes(syncOutcome(result));
      log.info(`resolved conflict on ${relPath}`, { "git.pushed": result.pushed });
      return result;
    },
  );
}

export async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  // A conflict being resolved pushes nothing and says nothing about what is
  // waiting; any other answer has looked at everything there was to push.
  const result = await traced("sync_saved_changes", repoDir, () => backend().syncSavedChanges(repoDir), syncOutcome);
  return notePush(repoDir, result, !result.message.startsWith("merge conflict in progress"));
}

export async function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
  extraMoves?: PathMove[],
): Promise<SyncResult> {
  const result = await traced(
    "move_and_push",
    repoDir,
    () => backend().moveAndPush(repoDir, fromPath, toPath, message, extraMoves),
    (result) => ({ ...syncOutcome(result), "git.from": fromPath, "git.to": toPath }),
  );
  return notePush(repoDir, result);
}

export async function removeAndPush(
  repoDir: string,
  paths: string | string[],
  message: string,
  alsoAdd?: string[],
): Promise<SyncResult> {
  const result = await traced(
    "remove_and_push",
    repoDir,
    () => backend().removeAndPush(repoDir, paths, message, alsoAdd),
    syncOutcome,
  );
  return notePush(repoDir, result);
}

export async function commitAndPush(
  repoDir: string,
  paths: string | string[],
  message: string,
): Promise<SyncResult> {
  return notePush(
    repoDir,
    await traced("commit_and_push", repoDir, () => backend().commitAndPush(repoDir, paths, message), syncOutcome),
  );
}

/**
 * Commit the whole working tree and make the first push of `branch`, which
 * then tracks the remote's — what initializing a marketplace in an empty
 * repository does (specs/app/plugins.feature.md "An empty repository is
 * initialized as a marketplace").
 */
export async function commitAllAndPublish(repoDir: string, branch: string, message: string): Promise<SyncResult> {
  return traced(
    "commit_all_and_publish",
    repoDir,
    () => backend().commitAllAndPublish(repoDir, branch, message),
    (result) => ({ ...syncOutcome(result), "git.branch": branch }),
  );
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

/** One way of cloning, as the fallback chain names it in its errors. */
export interface CloneMethod {
  readonly label: string;
  clone(url: string, dir: string): Promise<void>;
}

/**
 * The ways a plugin repository is cloned, in the order they are tried
 * (specs/app/plugins.feature.md "A plugin repository is cloned by the first
 * way that works"): the system git, then the git bundled with the app, then
 * the GitHub CLI. Whichever this machine lacks is left out; the bundled one
 * is always there. A hosted worker never uses gh — its credentials would be
 * the container's, not the signed-in user's.
 */
export function cloneMethods(): CloneMethod[] {
  if (substitute) return [{ label: "git", clone: substitute.clone.bind(substitute) }];
  const methods: CloneMethod[] = [];
  if (cliGitAvailable()) methods.push({ label: "system git", clone: cliBackend.clone });
  methods.push({ label: "built-in git", clone: jsBackend.clone });
  if (!isHostedMode() && ghAvailable() && cliGitAvailable()) {
    methods.push({ label: "GitHub CLI", clone: ghBackend.clone });
  }
  return methods;
}

/**
 * Clone through each method in turn until one works. A failed attempt's
 * leftovers are removed before the next one starts, so `dir` must not exist
 * beforehand. When every method fails the error names each with its reason.
 */
export async function cloneThrough(methods: readonly CloneMethod[], url: string, dir: string): Promise<void> {
  const failures: string[] = [];
  for (const method of methods) {
    try {
      await method.clone(url, dir);
      if (failures.length) log.info(`cloned ${url} with ${method.label} after: ${failures.join("; ")}`);
      return;
    } catch (e) {
      const reason = (e as Error).message;
      log.warn(`cloning ${url} with ${method.label} failed: ${reason}`, { "specdriven.dir": dir });
      // Each engine opens with the same "Could not clone <url>: "; say it once.
      const prefix = `Could not clone ${url}: `;
      const why = reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
      failures.push(methods.length > 1 ? `${method.label}: ${why.trim()}` : reason);
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (methods.length === 1) throw new Error(failures[0]);
  throw new Error(`Could not clone ${url} — ${failures.join("; ") || "no git available"}`);
}

/**
 * Clone a plugin repository — a marketplace or a plugin's own — whatever the
 * Git access setting says: the system git, the bundled git, the GitHub CLI,
 * each tried when the one before it fails.
 */
export async function clonePluginRepo(url: string, dir: string): Promise<void> {
  return withSpan("git.clone_plugin_repo", { "specdriven.dir": dir, "git.url": url }, () =>
    cloneThrough(cloneMethods(), url, dir),
  );
}
