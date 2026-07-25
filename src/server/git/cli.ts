// System-git engine (specs/git-operations.spec.md): every git operation the
// app performs, run as a `git` subprocess. What separates the two engines is
// injected per command — credentials and commit identity as `-c` overrides,
// never written into the repo's own config — so the GitHub CLI engine in
// gh.ts reuses all of this plumbing and only swaps the context and the clone.
//
// Signed in, every command carries the GitHub token as an HTTPS credential
// (fed through the environment, never argv); signed out, git runs unchanged
// with the system's own configuration — exactly the behavior a user with
// working git auth already has.
//
// createGitBackend() below is the workflow shared by all three engines: it
// knows the order of operations for a pull, a conflict resolution or a save,
// and nothing about how a git command is carried out. Engines supply that as
// a GitRun — a subprocess here and in gh.ts, the bundled implementation in
// js.ts. Every command it issues is therefore one all three understand.

import { rename, rm } from "node:fs/promises";
import { getAuth } from "../auth";
import { writeTextFile } from "../fsx";
import { run, which } from "../run";
import type { RunResult } from "../run";
import type { GitBackend, PullResult, SyncResult } from "./backend";
import { isRepoRoot } from "./repoRoot";

export function cliGitAvailable(): boolean {
  return which("git") !== null;
}

/** What a failed operation says when git had no usable GitHub credential. */
export const SIGN_IN_HINT = "authentication required — sign in with GitHub in Settings";

/**
 * Per-command git configuration an engine runs with. Nothing here is written
 * to disk: the `-c` overrides live for the length of one subprocess, and the
 * environment carries whatever secret the configured credential helper reads.
 */
export interface GitContext {
  config: string[];
  env: Record<string, string>;
}

/** Runs one git command; `null` repoDir means "outside any repository". */
export type GitRun = (repoDir: string | null, ...args: string[]) => Promise<RunResult>;

/** Commit-author overrides for a known GitHub identity. */
export function identityConfig(name: string, email: string): string[] {
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * Context for the plain-git engine: signed in, GitHub remotes are rewritten
 * to https, the token is echoed by the only credential helper, and the
 * account authors the commits. The empty helper entry resets helpers
 * inherited from the machine's config. Signed out, git is left alone.
 */
export async function appContext(): Promise<GitContext> {
  const auth = await getAuth();
  if (!auth) return { config: [], env: {} };
  return {
    config: [
      "-c", "url.https://github.com/.insteadOf=git@github.com:",
      "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/",
      "-c", "credential.helper=",
      "-c",
      "credential.helper=!f(){ echo username=x-access-token; echo \"password=$SPECDRIVEN_GIT_TOKEN\"; };f",
      ...identityConfig(
        auth.name ?? auth.login,
        auth.email ?? `${auth.login}@users.noreply.github.com`,
      ),
    ],
    env: { SPECDRIVEN_GIT_TOKEN: auth.token },
  };
}

/**
 * Whether failing output is a credential problem rather than a repository
 * one — including GitHub's "not found" for a private repo the caller cannot
 * see. Such failures are reported with the sign-in hint instead of git's
 * plumbing message. The bare `HTTP 4xx` forms are how the bundled engine
 * reports the same three answers, which it gets from the transport rather
 * than from a git binary's stderr.
 */
export function isAuthFailure(output: string): boolean {
  return /could not read username|authentication failed|terminal prompts disabled|invalid username or password|403 forbidden|401 unauthorized|repository not found|http (401|403|404) /i.test(
    output,
  );
}

/** The default `git clone`, reused by gh.ts for anything gh cannot clone. */
export async function gitClone(git: GitRun, url: string, dir: string): Promise<void> {
  const res = await git(null, "clone", url, dir);
  if (res.exitCode !== 0) {
    const output = res.stderr + res.stdout;
    throw new Error(
      `Could not clone ${url}: ${isAuthFailure(output) ? SIGN_IN_HINT : output.trim()}`,
    );
  }
}

/**
 * A GitRun that shells out to the git binary, with prompts disabled so a
 * command that cannot authenticate fails fast instead of hanging the server.
 * The context is resolved per command, so a sign-in mid-session is picked up
 * by the next operation.
 */
export function subprocessRun(context: () => Promise<GitContext>): GitRun {
  return async (repoDir, ...args) => {
    const { config, env } = await context();
    const base = repoDir ? ["-C", repoDir] : [];
    return run("git", [...base, ...config, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });
  };
}

export interface BackendOptions {
  name: GitBackend["name"];
  /** How this engine carries out one git command. */
  git: GitRun;
  /** Replaces the default `git clone`; receives this engine's runner. */
  clone?(git: GitRun, url: string, dir: string): Promise<void>;
}

export function createGitBackend({ name, git, clone: cloneWith }: BackendOptions): GitBackend {
  /**
   * Whether the checked-out branch tracks a remote one. Read from config
   * rather than resolved as the `@{u}` revision, which the bundled engine
   * does not implement — and config is the more direct answer to the
   * question actually being asked, which is whether an upstream is
   * *configured* to push to and pull from.
   */
  async function hasUpstream(repoDir: string): Promise<boolean> {
    const branch = await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch.exitCode !== 0) return false;
    const name = branch.stdout.trim();
    if (!name || name === "HEAD") return false; // detached, or no commit yet
    return (await git(repoDir, "config", "--get", `branch.${name}.remote`)).exitCode === 0;
  }

  /**
   * Files left conflicted by a merge — the unmerged index entries, which is
   * git's own definition of the set. `ls-files -u` prints one line per stage
   * (base, ours, theirs), so the same path arrives up to three times.
   */
  async function conflictedFiles(repoDir: string): Promise<string[]> {
    const res = await git(repoDir, "ls-files", "-u");
    if (res.exitCode !== 0) return [];
    const paths = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").slice(1).join("\t"))
      .filter(Boolean);
    return [...new Set(paths)];
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
    const output = (res.stderr + res.stdout).trim();
    return {
      ok: false,
      conflictedFiles: conflicts,
      message: conflicts.length === 0 && isAuthFailure(output) ? SIGN_IN_HINT : output,
    };
  }

  /** Content of a file on the other side of an in-progress merge (theirs). */
  async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
    const res = await git(repoDir, "show", `MERGE_HEAD:${relPath}`);
    return res.exitCode === 0 ? res.stdout : null;
  }

  /**
   * Commit, refusing to pretend. A commit that fails leaves the work
   * uncommitted, so reporting it as saved would be the worst kind of wrong
   * for an app whose promise is that specs reach the repository — the one
   * benign failure is there being nothing staged to commit.
   */
  async function commit(repoDir: string, ...args: string[]): Promise<void> {
    const res = await git(repoDir, "commit", ...args);
    if (res.exitCode === 0) return;
    const output = (res.stderr + res.stdout).trim();
    if (/nothing to commit|no changes added/i.test(output)) return;
    throw new Error(`git commit failed: ${output}`);
  }

  async function push(repoDir: string): Promise<SyncResult> {
    if (!(await hasUpstream(repoDir))) {
      return { pushed: false, message: "no upstream configured; skipped push" };
    }
    const res = await git(repoDir, "push");
    if (res.exitCode === 0) return { pushed: true, message: "pushed" };
    const output = (res.stderr + res.stdout).trim();
    return {
      pushed: false,
      message: `push failed: ${isAuthFailure(output) ? SIGN_IN_HINT : output}`,
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
    await commit(repoDir, "--no-edit");
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
    await commit(repoDir, "-m", "Auto-save scenarios");
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
    await commit(repoDir, "-m", message, "--", fromPath, toPath);
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
    await commit(repoDir, "-m", message, "--", relPath);
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
    await commit(repoDir, "-m", message, "--", relPath);
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed ? "committed and pushed" : `committed; ${res.message}`,
    };
  }

  return {
    name,
    clone: (url, dir) => (cloneWith ?? gitClone)(git, url, dir),
    pull,
    push,
    theirsVersion,
    resolveConflict,
    syncSavedChanges,
    moveAndPush,
    removeAndPush,
    commitAndPush,
    hasUpstream,
  };
}

export const cliBackend = createGitBackend({ name: "cli", git: subprocessRun(appContext) });
