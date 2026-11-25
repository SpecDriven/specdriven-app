// Worktrees for the coding agent pane (specs/agents/agent-pane.feature.md
// "A session can run in its own git worktree"): as in Claude Desktop, a
// session may get a git worktree of its own — a fresh checkout of the
// folder's repo on a new branch — so the agent's edits stay off the branch
// the user has checked out and two sessions never write over each other.
// The engine (src/server/agentChat.ts) makes one before the agent starts and
// hands the agent its path as the working directory, so every agent plugin
// gets worktrees without knowing about them.
//
// A session starts from up-to-date code: where the repo has an `origin`, the
// folder is switched to its main branch when it is on another, and that
// branch is brought level with origin — fetched, and fast-forwarded when it
// fell behind — before the worktree branches off it. What would lose or
// carry work (uncommitted changes on another branch, commits origin lacks)
// refuses the session and says why. The specifications folder is left
// alone: the app keeps it level itself.
//
// Worktrees go under <settings dir>/worktrees/<repo>/<name>, outside the
// repo: a worktree inside it would show up to the repo's own tools, and to
// the app's watcher when the folder is the data repo.
//
// System git only — the bundled engine has no worktrees. Node APIs only
// (src/server/run.ts): this module also runs inside Electron.

import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { run, which } from "./run";
import type { RunResult } from "./run";
import type { ChatWorktree } from "./agentTypes";
import { defaultBranch } from "./defaultBranch";
import type { BranchGit } from "./defaultBranch";

/** The branch prefix a session's worktree branch starts with. */
export const WORKTREE_BRANCH_PREFIX = "specdriven/";
/** Where worktrees go under the settings directory. */
export const WORKTREES_SUBDIR = "worktrees";
/** The remote a repo's main branch is kept level with. */
const REMOTE = "origin";
/** Longest name part of a worktree's branch and folder. */
const SLUG_MAX = 40;

/** A worktree that could not be made, with what to tell the pane. */
export class WorktreeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Runs one git command; injectable so tests can count or fail them. */
export type WorktreeGit = BranchGit;

const systemGit: WorktreeGit = (cwd, args, opts) =>
  run("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

let git: WorktreeGit = systemGit;
let gitOnPath: () => boolean = () => which("git") !== null;

/** Tests: swap the git runner (and whether git is "on PATH"); no arguments restores both. */
export function setWorktreeGit(runner?: WorktreeGit, available?: () => boolean): void {
  git = runner ?? systemGit;
  gitOnPath = available ?? (() => which("git") !== null);
}

/** What the pane learns about a folder before it offers a worktree. */
export interface FolderGitInfo {
  /** Whether a session in this folder may get a worktree. */
  canWorktree: boolean;
  /** Why not, for the checkbox's tooltip. */
  reason?: string;
  /** The repo's top folder. */
  repo?: string;
  /** The branch checked out there, or "HEAD" when detached. */
  branch?: string;
  /** The branch a worktree session has to start from — the remote's main
      branch — where the repo has one to be level with. */
  base?: string;
}

/** What is known of a folder beyond git's own answers. */
export interface FolderGitOptions {
  /** The open specifications folder: the app keeps it level with its remote
      itself, so a worktree of it is not fetched, checked or moved here. */
  synced?: string;
}

function firstLine(res: RunResult): string {
  return (res.stderr.trim() || res.stdout.trim()).split("\n")[0] ?? "";
}

/** Whether `dir` is `parent` or a folder inside it. */
function within(parent: string, dir: string): boolean {
  const inside = relative(resolve(parent), resolve(dir));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** Whether the repo has the remote its main branch is kept level with. */
async function hasRemote(repo: string): Promise<boolean> {
  return (await git(repo, ["remote", "get-url", REMOTE])).exitCode === 0;
}

/**
 * The branch worktree sessions start from: origin's default branch
 * (src/server/defaultBranch.ts — origin's HEAD, asked of origin when no
 * clone recorded it, else its `main` or `master`). Null with no origin, or
 * none of these on it — such a repo has nothing to be level with, and its
 * sessions branch off whatever is checked out.
 */
async function baseBranch(repo: string): Promise<string | null> {
  return (await defaultBranch(git, repo, { remote: REMOTE }))?.branch ?? null;
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** What bringing a repo level with origin did, beyond the worktree itself. */
interface Levelled {
  /** Why origin could not be reached: the check ran against the last fetch. */
  unchecked?: string;
  /** The branch the folder was on before it was switched to the base. */
  switchedFrom?: string;
  /** The base branch the folder is on now, when it was switched to it. */
  base?: string;
}

/**
 * Make sure the folder is on its main branch and that branch is level with
 * origin, before a worktree branches off it: fetch, switch a folder on
 * another branch (or a detached HEAD) to main, then fast-forward a main that
 * fell behind — `git switch main && git pull`, done carefully. What would
 * lose or carry work throws instead, with the checkout left as it was:
 * uncommitted changes to tracked files while another branch is checked out
 * (they would ride along onto main), a detached HEAD whose commits are on no
 * branch, a main with commits origin lacks, or a switch or fast-forward git
 * refuses. The checkout is never rebased or reset. A remote that cannot be
 * reached does not stop the session: the check runs against the last fetch,
 * and the reason comes back for the pane to show.
 */
async function levelWithOrigin(repo: string, branch: string | undefined): Promise<Levelled> {
  if (!(await hasRemote(repo))) return {};
  const fetched = await git(repo, ["fetch", "--quiet", REMOTE]);
  const base = await baseBranch(repo);
  if (!base) return {};
  const upstream = `${REMOTE}/${base}`;
  const switching = branch !== base;
  const detached = !branch || branch === "HEAD";
  const on = detached ? "has a detached HEAD" : `is on ${branch}`;
  if (switching) {
    const dirty = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.exitCode !== 0) {
      throw new WorktreeError(500, `Could not read the state of ${repo}: ${firstLine(dirty)}`);
    }
    if (dirty.stdout.trim()) {
      throw new WorktreeError(
        409,
        `Worktree sessions start from ${base}, but ${repo} ${on} with uncommitted changes — commit or stash them so it can be switched to ${base}`,
      );
    }
    if (detached) {
      const kept = await git(repo, [
        "for-each-ref",
        "--contains",
        "HEAD",
        "--count=1",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
      ]);
      if (kept.exitCode !== 0 || !kept.stdout.trim()) {
        throw new WorktreeError(
          409,
          `Worktree sessions start from ${base}, but ${repo} has a detached HEAD with commits on no branch — put them on a branch so it can be switched to ${base}`,
        );
      }
    }
  }
  // Compare the local base branch, not HEAD: the folder may not be on it yet.
  // A base branch with no local copy yet is made from origin's by the switch.
  const local = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]);
  let behind = 0;
  if (local.exitCode === 0) {
    const counted = await git(repo, ["rev-list", "--left-right", "--count", `${upstream}...refs/heads/${base}`]);
    if (counted.exitCode !== 0) {
      throw new WorktreeError(500, `Could not compare ${base} with ${upstream}: ${firstLine(counted)}`);
    }
    const [b = 0, ahead = 0] = counted.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    behind = b;
    if (ahead > 0) {
      const also = behind > 0 ? ` and is ${commits(behind)} behind it` : "";
      throw new WorktreeError(
        409,
        `${base} has ${commits(ahead)} that ${upstream} does not${also} — push or remove ${ahead === 1 ? "it" : "them"} before starting a worktree session`,
      );
    }
  }
  if (switching) {
    const switched = await git(repo, ["switch", "--quiet", base]);
    if (switched.exitCode !== 0) {
      throw new WorktreeError(
        409,
        `Worktree sessions start from ${base}, but ${repo} ${on} and could not be switched to it: ${firstLine(switched)}`,
      );
    }
  }
  if (behind > 0) {
    const forwarded = await git(repo, ["merge", "--ff-only", "--quiet", upstream]);
    if (forwarded.exitCode !== 0) {
      const now = switching ? ` (${repo} is on ${base} now)` : "";
      throw new WorktreeError(
        409,
        `${base} is ${commits(behind)} behind ${upstream} and could not be fast-forwarded${now}: ${firstLine(forwarded)}`,
      );
    }
  }
  const unchecked = fetched.exitCode === 0 ? undefined : firstLine(fetched) || `${REMOTE} could not be reached`;
  return {
    ...(unchecked ? { unchecked } : {}),
    ...(switching ? { switchedFrom: detached ? "HEAD" : branch, base } : {}),
  };
}

/** Whether `folder` is in a git repo with a commit to branch from, and which. */
export async function folderGitInfo(folder: string, known: FolderGitOptions = {}): Promise<FolderGitInfo> {
  if (!gitOnPath()) return { canWorktree: false, reason: "Worktrees need git on PATH" };
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return { canWorktree: false, reason: "Not a git repository" };
  const repo = resolve(top.stdout.trim());
  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.exitCode !== 0) {
    return { canWorktree: false, repo, reason: "The repository has no commit to branch from yet" };
  }
  const branch = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = known.synced && within(repo, known.synced) ? null : await baseBranch(repo);
  return {
    canWorktree: true,
    repo,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : "HEAD",
    ...(base ? { base } : {}),
  };
}

/** A session name as a branch and folder name: lowercase words joined by dashes. */
export function worktreeSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "session";
}

/** The folder the worktrees of one repo go in: its name and a short hash of its path. */
function repoDir(worktreesDir: string, repo: string): string {
  const hash = createHash("sha256").update(repo).digest("hex").slice(0, 6);
  return join(worktreesDir, `${worktreeSlug(basename(repo))}-${hash}`);
}

export interface CreateWorktreeOptions {
  /** The folder the pane picked: the repo's top, or a folder inside it. */
  folder: string;
  /** The session's name, for the branch and the folder. */
  name: string;
  /** <settings dir>/worktrees. */
  worktreesDir: string;
  /** A suffix that keeps names apart; random when absent. */
  suffix?: string;
  /** The open specifications folder, which the app keeps level itself (FolderGitOptions). */
  synced?: string;
}

/**
 * Make a worktree for a session: a new branch off the folder's HEAD —
 * its main branch, level with origin, where the repo has one (levelWithOrigin)
 * — checked out under worktreesDir. The agent's working directory is the
 * picked folder's place inside it, so a folder deep in the repo stays deep.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<ChatWorktree> {
  const info = await folderGitInfo(opts.folder, { ...(opts.synced ? { synced: opts.synced } : {}) });
  if (!info.canWorktree || !info.repo) {
    throw new WorktreeError(400, `Cannot make a worktree for ${opts.folder}: ${info.reason ?? "not a git repository"}`);
  }
  const repo = info.repo;
  const synced = opts.synced !== undefined && within(repo, opts.synced);
  const levelled: Levelled = synced ? {} : await levelWithOrigin(repo, info.branch);
  const from = levelled.base ?? info.branch;
  const suffix = opts.suffix ?? randomBytes(3).toString("hex");
  const leaf = `${worktreeSlug(opts.name)}-${suffix}`;
  const branch = `${WORKTREE_BRANCH_PREFIX}${leaf}`;
  const path = join(repoDir(opts.worktreesDir, repo), leaf);
  await mkdir(dirname(path), { recursive: true });
  const added = await git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (added.exitCode !== 0) {
    throw new WorktreeError(500, `Could not make a worktree: ${firstLine(added)}`);
  }
  const inside = relative(repo, resolve(opts.folder));
  const cwd = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(path, inside) : path;
  return {
    folder: resolve(opts.folder),
    repo,
    path,
    cwd,
    branch,
    ...(from && from !== "HEAD" ? { base: from } : {}),
    ...(levelled.unchecked ? { unchecked: levelled.unchecked } : {}),
    ...(levelled.switchedFrom ? { switchedFrom: levelled.switchedFrom } : {}),
  };
}

/** What became of a session's worktree when it closed. */
export type WorktreeCleanup = "removed" | "kept" | "gone";

/**
 * Close a session's worktree: removed when nothing in it is uncommitted —
 * the branch, and every commit on it, stays — else kept for the user to
 * look at. One already gone (removed by hand) is "gone".
 */
export async function cleanUpWorktree(wt: ChatWorktree): Promise<WorktreeCleanup> {
  const status = await git(wt.path, ["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    await git(wt.repo, ["worktree", "prune"]);
    return "gone";
  }
  if (status.stdout.trim()) return "kept";
  const removed = await git(wt.repo, ["worktree", "remove", wt.path]);
  return removed.exitCode === 0 ? "removed" : "kept";
}

/**
 * Undo a worktree whose session never started: the folder and its branch
 * both go, since nothing was done on them.
 */
export async function discardWorktree(wt: ChatWorktree): Promise<void> {
  await git(wt.repo, ["worktree", "remove", "--force", wt.path]);
  await git(wt.repo, ["branch", "-D", wt.branch]);
}

/**
 * The line a coding session's agent is told with its first turn about the
 * repo it works in (specs/agents/agent-pane.feature.md "A coding session is
 * told the repository's default branch"): which branch is the default — so
 * it never takes `main` for granted — and which branch it is on. Null where
 * `cwd` is in no repo, or nothing names a default branch.
 */
export async function sessionGitContext(cwd: string, worktree?: ChatWorktree): Promise<string | null> {
  if (!gitOnPath()) return null;
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return null;
  const repo = resolve(top.stdout.trim());
  const found = await defaultBranch(git, repo);
  if (!found) return null;
  const at = found.remote ? ` (${found.remote}/${found.branch})` : " (local; the repository has no remote)";
  const parts = [
    `[Context — git: this repository's default branch is \`${found.branch}\`${at}${found.branch === "main" ? "" : ", not `main`"}.`,
    `Branch from it and compare with it, and open pull requests against it.`,
  ];
  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.exitCode === 0 ? head.stdout.trim() : "";
  if (worktree) {
    const from = worktree.base ? `, made from \`${worktree.base}\`` : "";
    parts.push(`You are on \`${worktree.branch}\`, a branch of your own in a git worktree${from}.`);
  } else if (branch && branch !== "HEAD") {
    parts.push(`The checked-out branch is \`${branch}\`.`);
  } else if (branch === "HEAD") {
    parts.push("HEAD is detached.");
  }
  return `${parts.join(" ")}]`;
}
