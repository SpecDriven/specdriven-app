import { $ } from "bun";
import { rename } from "node:fs/promises";

export interface PullResult {
  ok: boolean;
  conflictedFiles: string[];
  message: string;
}

export interface SyncResult {
  pushed: boolean;
  message: string;
}

async function git(repoDir: string, ...args: string[]) {
  return $`git -C ${repoDir} ${args}`.quiet().nothrow();
}

export async function isGitRepo(repoDir: string): Promise<boolean> {
  const res = await git(repoDir, "rev-parse", "--is-inside-work-tree");
  return res.exitCode === 0 && res.stdout.toString().trim() === "true";
}

/**
 * True only when repoDir is itself the root of a git repo. The starter setup
 * (a data/ folder inside the app repo) must not trigger pulls or commits on
 * the containing repo as a side effect of saving specs.
 */
export async function isRepoRoot(repoDir: string): Promise<boolean> {
  const res = await git(repoDir, "rev-parse", "--show-toplevel");
  if (res.exitCode !== 0) return false;
  const toplevel = res.stdout.toString().trim();
  const real = await $`realpath ${repoDir}`.quiet().nothrow();
  return real.exitCode === 0 && real.stdout.toString().trim() === toplevel;
}

export async function hasUpstream(repoDir: string): Promise<boolean> {
  const res = await git(repoDir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  return res.exitCode === 0;
}

async function conflictedFiles(repoDir: string): Promise<string[]> {
  const res = await git(repoDir, "diff", "--name-only", "--diff-filter=U");
  if (res.exitCode !== 0) return [];
  return res.stdout.toString().split("\n").filter(Boolean);
}

/**
 * Per specs/crud-feature.spec.md: before saving, do a `git pull` and merge.
 * A repo with no upstream (e.g. the local-only starter setup) counts as ok.
 */
export async function pull(repoDir: string): Promise<PullResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "not a standalone git repository; skipped pull" };
  }
  if (!(await hasUpstream(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "no upstream configured; skipped pull" };
  }
  const res = await git(repoDir, "pull", "--no-rebase");
  if (res.exitCode === 0) {
    return { ok: true, conflictedFiles: [], message: res.stdout.toString().trim() };
  }
  const conflicts = await conflictedFiles(repoDir);
  return {
    ok: false,
    conflictedFiles: conflicts,
    message: (res.stderr.toString() + res.stdout.toString()).trim(),
  };
}

/** Content of a file on the other side of an in-progress merge (theirs). */
export async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  const res = await git(repoDir, "show", `MERGE_HEAD:${relPath}`);
  return res.exitCode === 0 ? res.stdout.toString() : null;
}

export async function push(repoDir: string): Promise<SyncResult> {
  if (!(await hasUpstream(repoDir))) {
    return { pushed: false, message: "no upstream configured; skipped push" };
  }
  const res = await git(repoDir, "push");
  if (res.exitCode === 0) return { pushed: true, message: "pushed" };
  return {
    pushed: false,
    message: `push failed: ${(res.stderr.toString() + res.stdout.toString()).trim()}`,
  };
}

/**
 * Mark a conflicted file resolved with the given content, complete the merge,
 * then commit and push (specs/crud-feature.spec.md, "save feature with merge
 * conflict").
 */
export async function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
): Promise<SyncResult> {
  await Bun.write(`${repoDir}/${relPath}`, content);
  await git(repoDir, "add", relPath);
  const remaining = await conflictedFiles(repoDir);
  if (remaining.length > 0) {
    return {
      pushed: false,
      message: `conflict resolved; ${remaining.length} conflicted file(s) remain`,
    };
  }
  await git(repoDir, "commit", "--no-edit");
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "conflict resolved; committed and pushed" : `conflict resolved; committed; ${res.message}`,
  };
}

/**
 * Per specs/crud-feature.spec.md ("Scenario is automatically saved locally and
 * pushed to GitHub"): after the cron git pull, commit and push any locally
 * saved scenarios so no data is lost. Skipped while a merge conflict is being
 * resolved so conflict markers are never auto-committed.
 */
export async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { pushed: false, message: "not a standalone git repository; skipped sync" };
  }
  if ((await conflictedFiles(repoDir)).length > 0) {
    return { pushed: false, message: "merge conflict in progress; skipped sync" };
  }
  const status = await git(repoDir, "status", "--porcelain");
  if (status.exitCode !== 0 || status.stdout.toString().trim() === "") {
    return { pushed: false, message: "no saved changes" };
  }
  await git(repoDir, "add", "-A");
  await git(repoDir, "commit", "-m", "Auto-save scenarios");
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed
      ? "saved scenarios committed and pushed"
      : `saved scenarios committed; ${res.message}`,
  };
}

/**
 * Per specs/ui.spec.md "Main page": an edited feature file name is committed
 * and pushed to GitHub using `git mv`. Outside a standalone git repo the file
 * is simply renamed on disk.
 */
export async function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    await rename(`${repoDir}/${fromPath}`, `${repoDir}/${toPath}`);
    return { pushed: false, message: "renamed locally (not a git repository)" };
  }
  const mv = await git(repoDir, "mv", fromPath, toPath);
  if (mv.exitCode !== 0) {
    throw new Error(`git mv failed: ${(mv.stderr.toString() + mv.stdout.toString()).trim()}`);
  }
  await git(repoDir, "commit", "-m", message, "--", fromPath, toPath);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "renamed, committed and pushed" : `renamed, committed; ${res.message}`,
  };
}

/**
 * Per specs/crud-feature.spec.md, saving ends with "do a git commit and push".
 */
export async function commitAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { pushed: false, message: "saved locally (not a git repository)" };
  }
  await git(repoDir, "add", relPath);
  await git(repoDir, "commit", "-m", message, "--", relPath);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "committed and pushed" : `committed; ${res.message}`,
  };
}
