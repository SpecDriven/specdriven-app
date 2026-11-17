// A repository's default branch — the one new work branches from and pull
// requests go to — which is not always `main` (specs/agents/agent-pane.feature.md
// "A coding session is told the repository's default branch"). Coding agent
// sessions learn it before their first turn, and worktree sessions start from
// it (src/server/agentWorktree.ts).
//
// Where git knows it, the remote names it: `refs/remotes/<remote>/HEAD`,
// which a clone sets. A repo whose remote was added by hand has no such ref,
// so the remote is asked (`git ls-remote --symref`), and its answer recorded
// as that ref the way a clone would have — the agents' own git tools then
// read the right branch too. Offline, a remote-tracking `main` or `master`
// stands in; with no remote at all, the local branch `init.defaultBranch`
// names, else a local `main` or `master`.
//
// System git only, Node APIs only (src/server/run.ts): this runs inside
// Electron too.

import { resolve } from "node:path";
import type { RunResult } from "./run";

/** Runs one git command in `cwd`; `timeoutMs` bounds one that reaches a remote. */
export type BranchGit = (cwd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** How the default branch was found, from surest to a guess. */
export type DefaultBranchSource =
  /** `refs/remotes/<remote>/HEAD`, as a clone (or an earlier answer) left it. */
  | "remote-head"
  /** The remote, asked just now. */
  | "remote"
  /** No HEAD known for the remote: its `main`, else its `master`. */
  | "remote-guess"
  /** No remote: the local branch `init.defaultBranch` names, else `main`, else `master`. */
  | "local";

export interface DefaultBranch {
  /** The branch's short name, e.g. `develop`. */
  branch: string;
  /** The remote it lives on; absent for a repo with no remote. */
  remote?: string;
  source: DefaultBranchSource;
}

export interface DefaultBranchOptions {
  /** The remote to ask; absent, `origin`, else the repo's only remote. */
  remote?: string;
  /** Whether the remote may be asked over the network when no HEAD is
      known for it (default true). */
  ask?: boolean;
  /** How long asking the remote may take. */
  timeoutMs?: number;
}

/** How long asking a remote may take, by default. */
const ASK_REMOTE_TIMEOUT_MS = 5000;
/** How long a remote that could not say is left unasked. */
const UNANSWERED_TTL_MS = 5 * 60 * 1000;

/** Repos whose remote could not name its HEAD, and when that was. */
const unanswered = new Map<string, number>();

/** Tests: forget which remotes could not be asked. */
export function forgetUnansweredRemotes(): void {
  unanswered.clear();
}

async function ok(git: BranchGit, repo: string, args: string[]): Promise<string | null> {
  const res = await git(repo, args);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/** The remote to read: the one asked for when it exists, else `origin`, else the only one. */
async function pickRemote(git: BranchGit, repo: string, wanted?: string): Promise<string | null> {
  const listed = await ok(git, repo, ["remote"]);
  const remotes = (listed ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
  if (wanted) return remotes.includes(wanted) ? wanted : null;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? (remotes[0] as string) : null;
}

/** Whether `ref` names a commit. */
async function has(git: BranchGit, repo: string, ref: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).exitCode === 0;
}

/** The branch `git ls-remote --symref <remote> HEAD` names, or null. */
export function parseSymrefHead(out: string): string | null {
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
  return m ? (m[1] as string) : null;
}

/** Ask the remote which branch its HEAD is, and record the answer as `<remote>/HEAD`. */
async function askRemote(git: BranchGit, repo: string, remote: string, timeoutMs: number): Promise<string | null> {
  const key = `${resolve(repo)}\0${remote}`;
  const at = unanswered.get(key);
  if (at !== undefined && Date.now() - at < UNANSWERED_TTL_MS) return null;
  const res = await git(repo, ["ls-remote", "--symref", remote, "HEAD"], { timeoutMs });
  const branch = res.exitCode === 0 ? parseSymrefHead(res.stdout) : null;
  if (!branch) {
    unanswered.set(key, Date.now());
    return null;
  }
  unanswered.delete(key);
  // As a clone would have: only once the branch has been fetched, since
  // the ref must point at something.
  if (await has(git, repo, `refs/remotes/${remote}/${branch}`)) {
    await git(repo, ["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`]);
  }
  return branch;
}

/**
 * The default branch of the repo at `repo` (its top folder, or any folder
 * in it), or null when nothing names one: no remote HEAD, no `main` or
 * `master` on the remote, and none locally either.
 */
export async function defaultBranch(
  git: BranchGit,
  repo: string,
  opts: DefaultBranchOptions = {},
): Promise<DefaultBranch | null> {
  const remote = await pickRemote(git, repo, opts.remote);
  if (remote) {
    const head = await ok(git, repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    if (head?.startsWith(`${remote}/`)) return { branch: head.slice(remote.length + 1), remote, source: "remote-head" };
    if (opts.ask !== false) {
      const asked = await askRemote(git, repo, remote, opts.timeoutMs ?? ASK_REMOTE_TIMEOUT_MS);
      if (asked) return { branch: asked, remote, source: "remote" };
    }
    for (const name of ["main", "master"]) {
      if (await has(git, repo, `refs/remotes/${remote}/${name}`)) return { branch: name, remote, source: "remote-guess" };
    }
    return null;
  }
  if (opts.remote) return null;
  const configured = await ok(git, repo, ["config", "--get", "init.defaultBranch"]);
  for (const name of [configured, "main", "master"]) {
    if (name && (await has(git, repo, `refs/heads/${name}`))) return { branch: name, source: "local" };
  }
  return null;
}
