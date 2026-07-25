// System-git engine (specs/git-operations.spec.md): the pre-existing
// subprocess implementation, kept as the fallback strategy and as an
// explicit choice in Settings. Signed in, every command carries the GitHub
// token as an HTTPS credential (fed through the environment, never argv);
// signed out, git runs unchanged with the system's own configuration —
// exactly the behavior a user with working git auth already has.

import { rename, rm } from "node:fs/promises";
import { getAuth } from "../auth";
import { writeTextFile } from "../fsx";
import { run, which } from "../run";
import type { GitBackend, PullResult, SyncResult } from "./backend";
import { isRepoRoot } from "./repoRoot";

export function cliGitAvailable(): boolean {
  return which("git") !== null;
}

/**
 * Per-command config carrying the sign-in token: GitHub remotes are
 * rewritten to https and the only credential helper echoes the token from
 * the environment. The empty helper entry resets inherited helpers.
 */
const TOKEN_CONFIG = [
  "-c", "url.https://github.com/.insteadOf=git@github.com:",
  "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/",
  "-c", "credential.helper=",
  "-c",
  "credential.helper=!f(){ echo username=x-access-token; echo \"password=$SPECDRIVEN_GIT_TOKEN\"; };f",
];

/**
 * Run git with prompts disabled, so a command that cannot authenticate
 * fails fast instead of hanging the server.
 */
async function git(repoDir: string | null, ...args: string[]) {
  const auth = await getAuth();
  const base = repoDir ? ["-C", repoDir] : [];
  return run("git", [...base, ...(auth ? TOKEN_CONFIG : []), ...args], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(auth ? { SPECDRIVEN_GIT_TOKEN: auth.token } : {}),
    },
  });
}

async function hasUpstream(repoDir: string): Promise<boolean> {
  const res = await git(repoDir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  return res.exitCode === 0;
}

async function conflictedFiles(repoDir: string): Promise<string[]> {
  const res = await git(repoDir, "diff", "--name-only", "--diff-filter=U");
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\n").filter(Boolean);
}

/**
 * Per specs/crud-feature.spec.md: before saving, do a `git pull` and merge.
 * A repo with no upstream (e.g. the local-only starter setup) counts as ok.
 */
async function pull(repoDir: string): Promise<PullResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "not a standalone git repository; skipped pull" };
  }
  if (!(await hasUpstream(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "no upstream configured; skipped pull" };
  }
  const res = await git(repoDir, "pull", "--no-rebase");
  if (res.exitCode === 0) {
    return { ok: true, conflictedFiles: [], message: res.stdout.trim() };
  }
  const conflicts = await conflictedFiles(repoDir);
  return {
    ok: false,
    conflictedFiles: conflicts,
    message: (res.stderr + res.stdout).trim(),
  };
}

/** Content of a file on the other side of an in-progress merge (theirs). */
async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  const res = await git(repoDir, "show", `MERGE_HEAD:${relPath}`);
  return res.exitCode === 0 ? res.stdout : null;
}

async function push(repoDir: string): Promise<SyncResult> {
  if (!(await hasUpstream(repoDir))) {
    return { pushed: false, message: "no upstream configured; skipped push" };
  }
  const res = await git(repoDir, "push");
  if (res.exitCode === 0) return { pushed: true, message: "pushed" };
  return {
    pushed: false,
    message: `push failed: ${(res.stderr + res.stdout).trim()}`,
  };
}

/**
 * Mark a conflicted file resolved with the given content, complete the merge,
 * then commit and push (specs/crud-feature.spec.md, "save feature with merge
 * conflict").
 */
async function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
): Promise<SyncResult> {
  await writeTextFile(`${repoDir}/${relPath}`, content);
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
async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { pushed: false, message: "not a standalone git repository; skipped sync" };
  }
  if ((await conflictedFiles(repoDir)).length > 0) {
    return { pushed: false, message: "merge conflict in progress; skipped sync" };
  }
  const status = await git(repoDir, "status", "--porcelain");
  if (status.exitCode !== 0 || status.stdout.trim() === "") {
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
 * Per specs/folders.spec.md: moving a feature between folders is a `git mv`,
 * committed and pushed. Outside a standalone git repo the file is simply
 * renamed on disk.
 */
async function moveAndPush(
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
    throw new Error(`git mv failed: ${(mv.stderr + mv.stdout).trim()}`);
  }
  await git(repoDir, "commit", "-m", message, "--", fromPath, toPath);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "renamed, committed and pushed" : `renamed, committed; ${res.message}`,
  };
}

/**
 * Per specs/ui.spec.md "Feature entry menu": deleting a feature is a
 * `git rm`, committed and pushed. Outside a standalone git repo the file is
 * simply removed from disk.
 */
async function removeAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    await rm(`${repoDir}/${relPath}`);
    return { pushed: false, message: "deleted locally (not a git repository)" };
  }
  const rmRes = await git(repoDir, "rm", "-f", relPath);
  if (rmRes.exitCode !== 0) {
    throw new Error(`git rm failed: ${(rmRes.stderr + rmRes.stdout).trim()}`);
  }
  await git(repoDir, "commit", "-m", message, "--", relPath);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "deleted, committed and pushed" : `deleted, committed; ${res.message}`,
  };
}

/**
 * Per specs/crud-feature.spec.md, saving ends with "do a git commit and push".
 */
async function commitAndPush(
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

async function clone(url: string, dir: string): Promise<void> {
  const res = await git(null, "clone", url, dir);
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim();
    throw new Error(`Could not clone ${url}: ${detail}`);
  }
}

export const cliBackend: GitBackend = {
  name: "cli",
  clone,
  pull,
  push,
  theirsVersion,
  resolveConflict,
  syncSavedChanges,
  moveAndPush,
  removeAndPush,
  commitAndPush,
  hasUpstream,
  mergeInProgress: async (repoDir) => (await conflictedFiles(repoDir)).length > 0,
};
