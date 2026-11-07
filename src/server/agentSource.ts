// Checking that the source is up to date before a coding session
// (specs/agents/agent-plugins.feature.md "A coding session should check that
// source is up to date"): when a session is about to start in a code
// repository, the pane shows the branch's state against its remote of record
// so new work branches from the right place, and offers to refresh it — a
// merge or a rebase — before the agent runs. Offline, or with no remote, only
// the local state is shown and the user confirms whether to proceed.
//
// This is the code repo under development, not the SpecDriven data repo (which
// the app already pulls and pushes on its own). It is read-only but for the
// refresh the user asks for, which runs here, before the session.
//
// System git only, like src/server/agentWorktree.ts — the bundled engine has
// no `fetch`/`pull` against an arbitrary code repo — and Node APIs only
// (src/server/run.ts), so this also runs inside Electron.

import { resolve } from "node:path";
import { run, which } from "./run";
import type { RunResult } from "./run";
import { isAuthFailure, signInHint } from "./git/cli";

/** Runs one git command; injectable so tests can count, fake or fail them. */
export type SourceGit = (cwd: string, args: string[]) => Promise<RunResult>;

const systemGit: SourceGit = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let git: SourceGit = systemGit;
let gitOnPath: () => boolean = () => which("git") !== null;

/** Tests: swap the git runner (and whether git is "on PATH"); no arguments restores both. */
export function setSourceGit(runner?: SourceGit, available?: () => boolean): void {
  git = runner ?? systemGit;
  gitOnPath = available ?? (() => which("git") !== null);
}

/** How a session's source stands against its remote of record. */
export interface SourceStatus {
  /** The repo's top folder, when the folder is in one. */
  repo?: string;
  /** The branch checked out there, or absent when detached. */
  branch?: string;
  /** The upstream the branch tracks (e.g. `origin/main`), when it tracks one. */
  upstream?: string;
  /** Whether a remote of record was reached — the branch could be compared live. */
  online: boolean;
  /** Whether the branch has an upstream to compare against at all. */
  hasRemote: boolean;
  /** Whether HEAD is detached (no branch to refresh). */
  detached: boolean;
  /** Commits on the upstream the branch does not have. */
  behind: number;
  /** Commits on the branch the upstream does not have. */
  ahead: number;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
  /** Why no live comparison was possible, for the dialog. */
  reason?: string;
}

/** What a refresh did, for the pane. */
export interface RefreshResult {
  /** Whether the branch was brought up to date without conflict. */
  ok: boolean;
  /** What to tell the user — git's own words, or a sign-in hint. */
  message: string;
  /** Whether the refresh left the working tree with merge/rebase conflicts. */
  conflicted: boolean;
}

/** How to bring the branch up to date. */
export type RefreshMode = "merge" | "rebase";

function firstLine(res: RunResult): string {
  return (res.stderr.trim() || res.stdout.trim()).split("\n")[0] ?? "";
}

/** `git -C folder rev-parse --show-toplevel`, resolved, or null when not a repo. */
async function repoTop(folder: string): Promise<string | null> {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  return top.exitCode === 0 ? resolve(top.stdout.trim()) : null;
}

/** The two counts `rev-list --left-right --count A...B` prints, left then right. */
function parseLeftRight(res: RunResult): { left: number; right: number } | null {
  if (res.exitCode !== 0) return null;
  const nums = res.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  const left = nums[0];
  const right = nums[1];
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return { left: left as number, right: right as number };
}

/**
 * Read the branch's state against its remote of record. A bounded `git fetch`
 * is tried so ahead/behind reflect the remote; when it cannot be reached the
 * status is offline and the counts fall back to what the last fetch left in
 * the remote-tracking ref. No remote at all (a local-only branch, a detached
 * HEAD) is reported as such, not as an error.
 */
export async function sourceStatus(folder: string): Promise<SourceStatus> {
  const base: SourceStatus = {
    online: false,
    hasRemote: false,
    detached: false,
    behind: 0,
    ahead: 0,
    dirty: false,
  };
  if (!gitOnPath()) return { ...base, reason: "git is not on PATH" };
  const repo = await repoTop(folder);
  if (!repo) return { ...base, reason: "Not a git repository" };

  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.exitCode !== 0) {
    return { ...base, repo, reason: "The repository has no commit yet" };
  }

  const dirtyRes = await git(folder, ["status", "--porcelain"]);
  const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;

  const branchRes = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : "HEAD";
  if (branch === "HEAD") {
    return { ...base, repo, dirty, detached: true, reason: "HEAD is detached — no branch to refresh" };
  }

  // The upstream the branch tracks, if any. `@{u}` is the symbolic name; a
  // branch with no upstream makes this fail, which is "local only", not an error.
  const upstreamRes = await git(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]);
  if (upstreamRes.exitCode !== 0) {
    return { ...base, repo, branch, dirty, reason: "The branch has no upstream — local only" };
  }
  const upstream = upstreamRes.stdout.trim();
  const remote = upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin";

  // Try to reach the remote so the comparison is live. A failure (offline, or
  // no access) is not fatal: we report offline and compare against the
  // remote-tracking ref as it stands.
  const fetched = await git(folder, ["fetch", "--quiet", remote]);
  const online = fetched.exitCode === 0;

  const counts = parseLeftRight(
    await git(folder, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]),
  );
  const behind = counts?.left ?? 0;
  const ahead = counts?.right ?? 0;

  return {
    repo,
    branch,
    upstream,
    online,
    hasRemote: true,
    detached: false,
    behind,
    ahead,
    dirty,
    ...(online ? {} : { reason: `Could not reach ${remote} — showing the last known state` }),
  };
}

/**
 * Bring the branch up to date before the session: a merge (`git pull
 * --no-rebase`) or a rebase (`git pull --rebase`). A dirty working tree is
 * refused up front so a refresh never half-applies over uncommitted work.
 */
export async function refreshSource(folder: string, mode: RefreshMode): Promise<RefreshResult> {
  if (!gitOnPath()) return { ok: false, message: "git is not on PATH", conflicted: false };
  const repo = await repoTop(folder);
  if (!repo) return { ok: false, message: "Not a git repository", conflicted: false };

  const dirtyRes = await git(folder, ["status", "--porcelain"]);
  if (dirtyRes.exitCode === 0 && dirtyRes.stdout.trim()) {
    return {
      ok: false,
      message: "The working tree has uncommitted changes — commit or stash them before refreshing.",
      conflicted: false,
    };
  }

  const res = await git(folder, ["pull", mode === "rebase" ? "--rebase" : "--no-rebase"]);
  if (res.exitCode === 0) {
    return { ok: true, message: res.stdout.trim() || "Already up to date.", conflicted: false };
  }

  // A conflict leaves unmerged index entries; anything else is reported as is,
  // with the sign-in hint when it reads like an auth problem.
  const conflicts = await git(folder, ["ls-files", "-u"]);
  const conflicted = conflicts.exitCode === 0 && conflicts.stdout.trim().length > 0;
  const output = (res.stderr + res.stdout).trim();
  if (conflicted) {
    return {
      ok: false,
      conflicted: true,
      message: `The ${mode} left conflicts to resolve before the session can start.`,
    };
  }
  return { ok: false, conflicted: false, message: isAuthFailure(output) ? signInHint() : firstLine(res) || output };
}
