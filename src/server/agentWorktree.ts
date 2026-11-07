// Worktrees for the coding agent pane (specs/agents/agent-pane.feature.md
// "A session can run in its own git worktree"): as in Claude Desktop, a
// session may get a git worktree of its own — a fresh checkout of the
// folder's repo on a new branch — so the agent's edits stay off the branch
// the user has checked out and two sessions never write over each other.
// The engine (src/server/agentChat.ts) makes one before the agent starts and
// hands the agent its path as the working directory, so every agent plugin
// gets worktrees without knowing about them.
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
}

function firstLine(res: RunResult): string {
  return (res.stderr.trim() || res.stdout.trim()).split("\n")[0] ?? "";
}

/** Whether `folder` is in a git repo with a commit to branch from, and which. */
export async function folderGitInfo(folder: string): Promise<FolderGitInfo> {
  if (!gitOnPath()) return { canWorktree: false, reason: "Worktrees need git on PATH" };
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return { canWorktree: false, reason: "Not a git repository" };
  const repo = resolve(top.stdout.trim());
  const head = await git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.exitCode !== 0) {
    return { canWorktree: false, repo, reason: "The repository has no commit to branch from yet" };
  }
  const branch = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { canWorktree: true, repo, branch: branch.exitCode === 0 ? branch.stdout.trim() : "HEAD" };
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
}

/**
 * Make a worktree for a session: a new branch off the folder's HEAD,
 * checked out under worktreesDir. The agent's working directory is the
 * picked folder's place inside it, so a folder deep in the repo stays deep.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<ChatWorktree> {
  const info = await folderGitInfo(opts.folder);
  if (!info.canWorktree || !info.repo) {
    throw new WorktreeError(400, `Cannot make a worktree for ${opts.folder}: ${info.reason ?? "not a git repository"}`);
  }
  const repo = info.repo;
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
