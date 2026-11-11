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
// folder must be on its main branch and that branch is brought level with
// origin — fetched, and fast-forwarded when it fell behind — before the
// worktree branches off it. What a fast-forward cannot fix (another branch
// checked out, commits origin lacks) refuses the session and says why. The
// specifications folder is left alone: the app keeps it level itself.
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

/** The branch prefix a session's worktree branch starts with. */
export const WORKTREE_BRANCH_PREFIX = "specdriven/";
/** Where worktrees go under the settings directory. */
export const WORKTREES_SUBDIR = "worktrees";
/** The remote a repo's main branch is kept level with. */
const REMOTE = "origin";
/** The main branch where the remote names no default of its own. */
const MAIN_BRANCH = "main";
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
export type WorktreeGit = (cwd: string, args: string[]) => Promise<RunResult>;

const systemGit: WorktreeGit = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

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
 * The branch worktree sessions start from: the remote's default branch, else
 * `main` where the remote has one. Null with no remote, or none of these on
 * it — such a repo has nothing to be level with, and its sessions branch off
 * whatever is checked out.
 */
async function baseBranch(repo: string): Promise<string | null> {
  if (!(await hasRemote(repo))) return null;
  const head = await git(repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`]);
  const name = head.stdout.trim();
  if (head.exitCode === 0 && name.startsWith(`${REMOTE}/`)) return name.slice(REMOTE.length + 1);
  const main = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${MAIN_BRANCH}`]);
  return main.exitCode === 0 ? MAIN_BRANCH : null;
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/**
 * Make sure the folder is on its main branch and that branch is level with
 * origin, before a worktree branches off it: fetch, then fast-forward a
 * branch that fell behind. Another branch checked out, commits origin lacks,
 * or a fast-forward git refuses (uncommitted changes in its way) throw — the
 * user's checkout is never switched, rebased or reset. A remote that cannot
 * be reached does not stop the session: the check runs against the last
 * fetch, and the reason comes back for the pane to show.
 */
async function levelWithOrigin(repo: string, branch: string | undefined): Promise<string | undefined> {
  if (!(await hasRemote(repo))) return undefined;
  const fetched = await git(repo, ["fetch", "--quiet", REMOTE]);
  const base = await baseBranch(repo);
  if (!base) return undefined;
  const upstream = `${REMOTE}/${base}`;
  if (branch !== base) {
    const on = !branch || branch === "HEAD" ? "has a detached HEAD" : `is on ${branch}`;
    throw new WorktreeError(409, `Worktree sessions start from ${base}, but ${repo} ${on} — switch it to ${base} first`);
  }
  const counted = await git(repo, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [behind = 0, ahead = 0] = counted.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  if (counted.exitCode !== 0) {
    throw new WorktreeError(500, `Could not compare ${base} with ${upstream}: ${firstLine(counted)}`);
  }
  if (ahead > 0) {
    const also = behind > 0 ? ` and is ${commits(behind)} behind it` : "";
    throw new WorktreeError(
      409,
      `${base} has ${commits(ahead)} that ${upstream} does not${also} — push or remove ${ahead === 1 ? "it" : "them"} before starting a worktree session`,
    );
  }
  if (behind > 0) {
    const forwarded = await git(repo, ["merge", "--ff-only", "--quiet", upstream]);
    if (forwarded.exitCode !== 0) {
      throw new WorktreeError(
        409,
        `${base} is ${commits(behind)} behind ${upstream} and could not be fast-forwarded: ${firstLine(forwarded)}`,
      );
    }
  }
  return fetched.exitCode === 0 ? undefined : firstLine(fetched) || `${REMOTE} could not be reached`;
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
  const unchecked = synced ? undefined : await levelWithOrigin(repo, info.branch);
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
    ...(info.branch && info.branch !== "HEAD" ? { base: info.branch } : {}),
    ...(unchecked ? { unchecked } : {}),
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
