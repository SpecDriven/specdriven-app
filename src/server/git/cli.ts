// System-git engine (git-operations.md): every git operation the
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

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { getAuth } from "../auth";
import { readTextFile, writeTextFile } from "../fsx";
import { GITHUB_HOST, webBase } from "../github";
import { isHostedMode } from "../hostedMode";
import { run, which } from "../run";
import { getLogger } from "../telemetry";
import type { RunResult } from "../run";
import type { GitBackend, PathMove, PullResult, SyncResult } from "./backend";
import { isRepoRoot } from "./repoRoot";
import { FALLBACK_TITLE, pathsInStatus, summarizeSavedChanges } from "./saveSummary";
import type { ChangedFile } from "./saveSummary";

export function cliGitAvailable(): boolean {
  return which("git") !== null;
}

/**
 * What a failed operation says when git had no usable GitHub credential. A
 * hosted worker's token comes from the gateway's account page, not Settings
 * (src/server/hostedMode.ts).
 */
export function signInHint(): string {
  return isHostedMode()
    ? "authentication required — add a GitHub token that can read and write it on your account page"
    : "authentication required — sign in with GitHub in Settings";
}

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

/** How many changed files a save reads to describe; the rest are counted. */
const SUMMARY_READ_LIMIT = 40;

/** The files the auto-save summary reads: markdown specs and pages, folder descriptions. */
function isSpecText(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".txt");
}

/** Commit-author overrides for a known GitHub identity. */
export function identityConfig(name: string, email: string): string[] {
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * Context for the plain-git engine: signed in, remotes on the sign-in's
 * GitHub host are rewritten to https, the token is echoed by the only
 * credential helper for that host, and the account authors the commits. The
 * empty helper entry resets the host's helpers inherited from the machine's
 * config; every other host keeps its own. Signed out, git is left alone.
 */
export async function appContext(): Promise<GitContext> {
  const auth = await getAuth();
  if (!auth) return { config: [], env: {} };
  return tokenContext(
    auth.token,
    auth.name ?? auth.login,
    auth.email ?? `${auth.login}@users.noreply.github.com`,
    auth.host,
  );
}

/**
 * The signed-in context for one fixed token and commit author — appContext's
 * shape, for callers (the hosted gateway's datastore) that hold a token of
 * their own rather than the app's sign-in.
 */
export function tokenContext(token: string, name: string, email: string, host: string = GITHUB_HOST): GitContext {
  const base = webBase(host);
  const sshHost = host.replace(/:\d+$/, "");
  return {
    config: [
      "-c", `url.${base}/.insteadOf=git@${sshHost}:`,
      "-c", `url.${base}/.insteadOf=ssh://git@${sshHost}/`,
      "-c", `credential.${base}.helper=`,
      "-c",
      `credential.${base}.helper=!f(){ echo username=x-access-token; echo "password=$SPECDRIVEN_GIT_TOKEN"; };f`,
      ...identityConfig(name, email),
    ],
    env: { SPECDRIVEN_GIT_TOKEN: token },
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

/**
 * The error a failed clone surfaces as, on every engine: git's own output,
 * or the sign-in hint when that output is a credential problem.
 */
export function cloneFailure(url: string, res: RunResult): Error {
  const output = res.stderr + res.stdout;
  return new Error(
    `Could not clone ${url}: ${isAuthFailure(output) ? signInHint() : output.trim()}`,
  );
}

/** The default `git clone`, reused by gh.ts for anything gh cannot clone. */
export async function gitClone(git: GitRun, url: string, dir: string): Promise<void> {
  const res = await git(null, "clone", url, dir);
  if (res.exitCode !== 0) throw cloneFailure(url, res);
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
   * Per crud-feature.md: before saving, do a `git pull` and merge.
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
      message: conflicts.length === 0 && isAuthFailure(output) ? signInHint() : output,
    };
  }

  /** Content of a file on the other side of an in-progress merge (theirs). */
  async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
    const res = await git(repoDir, "show", `MERGE_HEAD:${relPath}`);
    return res.exitCode === 0 ? res.stdout : null;
  }

  /**
   * One merge stage of a conflicted file, read via its blob hash from
   * `ls-files -u` — the `:N:path` shorthand isn't in the bundled engine's
   * vocabulary, but `show <hash>` is in all three.
   */
  async function stageVersion(
    repoDir: string,
    relPath: string,
    stage: 1 | 2 | 3,
  ): Promise<string | null> {
    const res = await git(repoDir, "ls-files", "-u", "--", relPath);
    if (res.exitCode !== 0) return null;
    for (const line of res.stdout.split("\n")) {
      const m = line.match(/^\d+ ([0-9a-f]+) ([123])\t(.*)$/);
      if (m && Number(m[2]) === stage && m[3] === relPath) {
        const show = await git(repoDir, "show", m[1]!);
        return show.exitCode === 0 ? show.stdout : null;
      }
    }
    return null;
  }

  /** Paths under pathspec that differ between two commits (either direction). */
  async function diffNames(
    repoDir: string,
    from: string,
    to: string,
    pathspec: string,
  ): Promise<string[]> {
    const res = await git(repoDir, "diff", "--name-only", from, to, "--", pathspec);
    if (res.exitCode !== 0) return [];
    return res.stdout.split("\n").filter(Boolean);
  }

  /** Whether a path exists in a commit's tree. */
  async function existsIn(repoDir: string, ref: string, relPath: string): Promise<boolean> {
    return (await git(repoDir, "show", `${ref}:${relPath}`)).exitCode === 0;
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
      message: `push failed: ${isAuthFailure(output) ? signInHint() : output}`,
    };
  }

  /**
   * Mark a conflicted file resolved with the given content, complete the merge,
   * then commit and push (crud-feature.md, "Publish feature with merge
   * conflict").
   */
  async function resolveConflict(
    repoDir: string,
    relPath: string,
    content: string,
    alsoAdd: string[] = [],
  ): Promise<SyncResult> {
    await writeTextFile(`${repoDir}/${relPath}`, content);
    await git(repoDir, "add", relPath, ...alsoAdd);
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
   * Per crud-feature.md ("Scenario is automatically saved locally and
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
    const message = await saveMessage(repoDir, status.stdout);
    await git(repoDir, "add", "-A");
    await commit(repoDir, "-m", message);
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed
        ? "saved scenarios committed and pushed"
        : `saved scenarios committed; ${res.message}`,
    };
  }

  /**
   * The commit message for what the working tree holds (saveSummary.ts):
   * each changed spec file read as HEAD has it and as the disk has it now,
   * for the summary to tell what changed. The save itself must never wait
   * on its own wording, so a failure here falls back to the fixed title.
   */
  async function saveMessage(repoDir: string, porcelain: string): Promise<string> {
    try {
      const files: ChangedFile[] = [];
      for (const path of await expandFolders(repoDir, pathsInStatus(porcelain))) {
        if (files.length >= SUMMARY_READ_LIMIT || !isSpecText(path)) {
          files.push({ path });
          continue;
        }
        const shown = await git(repoDir, "show", `HEAD:${path}`);
        files.push({
          path,
          before: shown.exitCode === 0 ? shown.stdout : null,
          after: await readTextFile(`${repoDir}/${path}`),
        });
      }
      const { title, body } = summarizeSavedChanges(files);
      return `${title}\n\n${body}`;
    } catch (e) {
      getLogger("git").warn(`auto-save summary failed: ${(e as Error).message}`);
      return FALLBACK_TITLE;
    }
  }

  /** git lists a whole untracked folder as one entry; its files are what changed. */
  async function expandFolders(repoDir: string, paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      if (!path.endsWith("/")) {
        out.push(path);
        continue;
      }
      const entries = await readdir(`${repoDir}/${path}`, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parent = entry.parentPath.slice(repoDir.length + 1).replace(/\/$/, "");
        out.push(parent ? `${parent}/${entry.name}` : entry.name);
      }
    }
    return out;
  }

  /**
   * Per specs/ui/folders.feature.md: moving a feature between folders is a `git
   * mv`, committed and pushed. Outside a standalone git repo the file is simply
   * renamed on disk.
   */
  async function moveAndPush(
    repoDir: string,
    fromPath: string,
    toPath: string,
    message: string,
    extraMoves: PathMove[] = [],
  ): Promise<SyncResult> {
    const moves = [{ from: fromPath, to: toPath }, ...extraMoves];
    // A doc directory can move into a folder that has never held one — its
    // destination parent (e.g. `.specdriven/automerge/specs/billing/`)
    // must exist before the rename, for git mv and plain rename alike.
    for (const m of moves) await mkdir(dirname(`${repoDir}/${m.to}`), { recursive: true });
    if (!(await isRepoRoot(repoDir))) {
      for (const m of moves) await rename(`${repoDir}/${m.from}`, `${repoDir}/${m.to}`);
      return { pushed: false, message: "renamed locally (not a git repository)" };
    }
    for (const m of moves) {
      const mv = await git(repoDir, "mv", m.from, m.to);
      if (mv.exitCode !== 0) {
        throw new Error(`git mv failed: ${(mv.stderr + mv.stdout).trim()}`);
      }
    }
    await commit(repoDir, "-m", message, "--", ...moves.flatMap((m) => [m.from, m.to]));
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed ? "renamed, committed and pushed" : `renamed, committed; ${res.message}`,
    };
  }

  /**
   * Per specs/ui/ui.feature.md "Feature entry menu": deleting a feature is a
   * `git rm`, committed and pushed. Outside a standalone git repo the file is
   * simply removed from disk.
   */
  async function removeAndPush(
    repoDir: string,
    paths: string | string[],
    message: string,
  ): Promise<SyncResult> {
    const all = Array.isArray(paths) ? paths : [paths];
    if (!(await isRepoRoot(repoDir))) {
      for (const p of all) await rm(`${repoDir}/${p}`, { recursive: true, force: true });
      return { pushed: false, message: "deleted locally (not a git repository)" };
    }
    // -r for the Automerge doc directory that rides along with a feature.
    const rmRes = await git(repoDir, "rm", "-f", "-r", ...all);
    if (rmRes.exitCode !== 0) {
      throw new Error(`git rm failed: ${(rmRes.stderr + rmRes.stdout).trim()}`);
    }
    await commit(repoDir, "-m", message, "--", ...all);
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed ? "deleted, committed and pushed" : `deleted, committed; ${res.message}`,
    };
  }

  /**
   * Per crud-feature.md, saving ends with "do a git commit and push".
   */
  async function commitAndPush(
    repoDir: string,
    paths: string | string[],
    message: string,
  ): Promise<SyncResult> {
    const all = Array.isArray(paths) ? paths : [paths];
    if (!(await isRepoRoot(repoDir))) {
      return { pushed: false, message: "saved locally (not a git repository)" };
    }
    await git(repoDir, "add", ...all);
    await commit(repoDir, "-m", message, "--", ...all);
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed ? "committed and pushed" : `committed; ${res.message}`,
    };
  }

  async function headCommit(repoDir: string): Promise<string> {
    const res = await git(repoDir, "rev-parse", "HEAD");
    if (res.exitCode !== 0) throw new Error(`Not a git repository: ${repoDir}`);
    return res.stdout.toString().trim();
  }

  /**
   * A marketplace plugin is pinned to the ref its index names
   * (specs/app/plugins.feature.md "A plugin from the marketplace is
   * installed with consent"): the remote's branches and tags are fetched,
   * then `origin/<ref>` is tried before the bare ref, so a branch follows
   * the remote rather than the local branch the clone made.
   */
  async function checkoutRef(repoDir: string, ref: string): Promise<string> {
    const fetched = await git(repoDir, "fetch", "origin", "--tags");
    if (fetched.exitCode !== 0) {
      const output = fetched.stderr + fetched.stdout;
      throw new Error(
        `Could not fetch ${ref}: ${isAuthFailure(output) ? signInHint() : output.trim()}`,
      );
    }
    let res = await git(repoDir, "checkout", "--detach", `origin/${ref}`);
    if (res.exitCode !== 0) res = await git(repoDir, "checkout", "--detach", ref);
    if (res.exitCode !== 0) {
      throw new Error(`The repository has no ref "${ref}": ${(res.stderr + res.stdout).trim()}`);
    }
    return headCommit(repoDir);
  }

  return {
    name,
    clone: (url, dir) => (cloneWith ?? gitClone)(git, url, dir),
    checkoutRef,
    headCommit,
    pull,
    push,
    theirsVersion,
    conflictedFiles,
    stageVersion,
    diffNames,
    existsIn,
    resolveConflict,
    syncSavedChanges,
    moveAndPush,
    removeAndPush,
    commitAndPush,
    hasUpstream,
  };
}

export const cliBackend = createGitBackend({ name: "cli", git: subprocessRun(appContext) });
