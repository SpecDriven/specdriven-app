// GitHub issue tracking (specs/app/github-issues.feature.md): the issues of
// the code repo the data repo's project-settings.json names (`code-repo`,
// src/server/members.ts), read and written through the GitHub REST API.
// Nothing is stored locally — GitHub is the source of truth, and the app is
// one more client of it: list, open one with its comments, create, edit,
// close and reopen, comment.
//
// Which GitHub repository that is comes from the code repo's git config —
// its `origin` remote — read from disk rather than through a git subprocess,
// so it works on every git engine (git-operations.md), including
// the bundled JavaScript one on a machine with no git at all.
//
// Requests carry the app's own GitHub sign-in token (src/server/tokenStore
// .ts) when there is one, else the GitHub CLI's; without either, reads of a
// public repository still work within GitHub's anonymous rate limit, and a
// write answers with a clear "sign in" message.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getAuth } from "./auth";
import { DEMO_ISSUES_REPO, isDemoMode } from "./demoMode";
import { ghAccountInUse, ghToken } from "./git/gh";
import { GITHUB_HOST, githubApiBase } from "./github";
import { readProjectSettings } from "./members";
import { parseGitHubUrl, type GitHubRepo } from "./repo";
import type { PullRequestState } from "./pullRequests";
import { cleanLine, cleanText } from "./text";

export type { GitHubRepo };

/** One issue, as the client shows it — never a pull request. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** GitHub's reason for a closed issue: completed or not_planned. */
  stateReason: string | null;
  /** The issue's page on GitHub. */
  url: string;
  author: string | null;
  assignees: string[];
  labels: { name: string; color: string }[];
  /** How many comments it holds. */
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export type IssueState = "open" | "closed" | "all";

/** A failed GitHub call, with the HTTP status so the route can pass it on. */
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// --- Which repository -----------------------------------------------------------------

/**
 * The url of a repo's `origin` remote, from its git config on disk — or
 * null when the folder is no git repo or has no origin. A worktree's `.git`
 * is a file pointing at its private git dir, whose `commondir` names the
 * shared one where the config (and the remotes) live.
 */
export async function originUrl(dir: string): Promise<string | null> {
  const dotGit = resolve(dir, ".git");
  let gitDir: string;
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m);
      if (!pointer) return null;
      const target = pointer[1]!;
      gitDir = isAbsolute(target) ? target : resolve(dir, target);
    }
  } catch {
    return null;
  }
  let commonDir = gitDir;
  try {
    const common = (await readFile(resolve(gitDir, "commondir"), "utf8")).trim();
    if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // No commondir: a plain repository, whose config lives in gitDir itself.
  }
  let config: string;
  try {
    config = await readFile(resolve(commonDir, "config"), "utf8");
  } catch {
    return null;
  }
  return parseOriginUrl(config);
}

/** The `url` of the `[remote "origin"]` section of a git config, or null. */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * The GitHub repository a remote url names, or null for any other host.
 * Beside the https and scp-like ssh forms, the explicit `ssh://` one git
 * also writes.
 */
export function githubRepoOfRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim();
  const ssh = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i);
  const repo = parseGitHubUrl(ssh ? `https://github.com/${ssh[1]}` : trimmed);
  // Issues are read from github.com's API only; an Enterprise remote has none here yet.
  return repo?.host === GITHUB_HOST ? repo : null;
}

/** The GitHub repository a local folder pushes to, or null. */
export async function repoOfFolder(dir: string): Promise<GitHubRepo | null> {
  const url = await originUrl(dir);
  return url ? githubRepoOfRemote(url) : null;
}

/**
 * The repository whose issues the app tracks for a data repo: the one its
 * project-settings.json `code-repo` pushes to. Null when the file names no
 * code repo, or the code repo is not a GitHub one — then there is no Issues
 * tab.
 *
 * The demo is the exception: its dataset is a copy with no .git anywhere, so
 * no remote can be read from it. It tracks the public release repo instead
 * (DEMO_ISSUES_REPO), read-only through the anonymous rate limit, so the
 * Issues tab has something real to show.
 */
export async function readIssuesRepo(dataDir: string): Promise<GitHubRepo | null> {
  if (isDemoMode()) return DEMO_ISSUES_REPO;
  const { codeRepo } = await readProjectSettings(dataDir);
  if (codeRepo === null) return null;
  return repoOfFolder(codeRepo);
}

// --- The GitHub API -----------------------------------------------------------------

/**
 * The token requests carry: the app's own sign-in first, then the GitHub
 * CLI's (unless signing out turned it off), else none. The CLI's is asked for on every call rather than
 * cached — `gh auth logout` must take effect without a restart.
 */
export async function issuesToken(): Promise<string | null> {
  const auth = await getAuth();
  if (auth) return auth.token;
  if (await ghAccountInUse()) return ghToken();
  return null;
}

const API_VERSION = "2022-11-28";

/** One request to the GitHub REST API, with the token and headers it wants. */
async function githubRequest(
  path: string,
  accept: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const token = await issuesToken();
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "SpecDriven",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${githubApiBase()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) throw await describeFailure(res, token !== null);
  return res;
}

async function github<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await githubRequest(path, "application/vnd.github+json", init);
  return (await res.json()) as T;
}

/**
 * A file's raw text through the contents endpoint —
 * `/repos/{owner}/{repo}/contents/{path}?ref={ref}` with GitHub's raw media
 * type — as src/server/testName.ts reads a test's source. Same token, same
 * failure wording as every other call here.
 */
export async function githubText(path: string): Promise<string> {
  const res = await githubRequest(path, "application/vnd.github.raw+json");
  return res.text();
}

/** A GitHub failure as one sentence the pane can show, with the status kept. */
async function describeFailure(res: Response, signedIn: boolean): Promise<GitHubError> {
  const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
  if (res.status === 401) {
    return new GitHubError(
      signedIn
        ? "GitHub rejected the sign-in token; sign in again in Settings."
        : "Sign in to GitHub in Settings to work with issues.",
      401,
    );
  }
  if (res.status === 403 || res.status === 429) {
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    return new GitHubError(
      limited
        ? signedIn
          ? "GitHub's API rate limit is used up; try again later."
          : "GitHub's anonymous rate limit is used up; sign in to GitHub in Settings."
        : `GitHub refused the request${detail ? `: ${detail}` : ""}`,
      403,
    );
  }
  if (res.status === 404) {
    return new GitHubError(
      signedIn
        ? "GitHub reports no such repository or issue, or the token cannot see it."
        : "GitHub reports no such repository or issue; a private one needs a sign-in in Settings.",
      404,
    );
  }
  return new GitHubError(`GitHub answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, 502);
}

/** GitHub's issue shape, the fields the app reads. */
interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  assignees?: { login?: string }[] | null;
  labels?: (string | { name?: string; color?: string | null })[] | null;
  comments?: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
}

export function toIssue(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: raw.state_reason ?? null,
    url: raw.html_url,
    author: raw.user?.login ?? null,
    assignees: (raw.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? { name: l, color: "" } : { name: l.name ?? "", color: l.color ?? "" }))
      .filter((l) => l.name),
    comments: raw.comments ?? 0,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
  };
}

function toComment(raw: RawComment): IssueComment {
  return {
    id: raw.id,
    body: raw.body ?? "",
    author: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

const repoPath = (repo: GitHubRepo) =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/**
 * The repository's issues in one state, most recently updated first. GitHub
 * lists pull requests among issues; those are left out — the module tracks
 * bugs, not reviews. At most the first hundred.
 */
export async function listIssues(repo: GitHubRepo, state: IssueState = "open"): Promise<Issue[]> {
  const raw = await github<RawIssue[]>(
    `${repoPath(repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=100`,
  );
  return raw.filter((i) => i.pull_request === undefined).map(toIssue);
}

export async function getIssue(repo: GitHubRepo, number: number): Promise<Issue> {
  const raw = await github<RawIssue>(`${repoPath(repo)}/issues/${number}`);
  if (raw.pull_request !== undefined) {
    throw new GitHubError(`#${number} is a pull request, not an issue`, 404);
  }
  return toIssue(raw);
}

/** The fields of GitHub's pull request object the lookup reads. */
interface RawPullRequest {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
}

/**
 * One pull request, for the editor's "Pull requests" field
 * (specs/external-links/related-pull-requests.feature.md): its title and
 * where it stands — draft, open, merged or closed. The same token and
 * failure wording as the issue calls; the caller names the repository from
 * the url typed, which need not be the code repo.
 */
export async function getPullRequest(
  owner: string,
  name: string,
  number: number,
): Promise<{ number: number; title: string; state: PullRequestState }> {
  const raw = await github<RawPullRequest>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
  );
  const state: PullRequestState = raw.merged_at
    ? "merged"
    : raw.state === "closed"
      ? "closed"
      : raw.draft
        ? "draft"
        : "open";
  return { number: raw.number, title: raw.title, state };
}

export async function listComments(repo: GitHubRepo, number: number): Promise<IssueComment[]> {
  const raw = await github<RawComment[]>(`${repoPath(repo)}/issues/${number}/comments?per_page=100`);
  return raw.map(toComment);
}

/** A title is the one thing an issue must have. */
function requireTitle(value: unknown): string {
  const title = typeof value === "string" ? cleanLine(value) : "";
  if (!title) throw new GitHubError("An issue needs a title", 400);
  return title;
}

export async function createIssue(
  repo: GitHubRepo,
  input: { title?: unknown; body?: unknown },
): Promise<Issue> {
  const payload: { title: string; body?: string } = { title: requireTitle(input.title) };
  if (typeof input.body === "string" && input.body.trim()) payload.body = cleanText(input.body);
  return toIssue(await github<RawIssue>(`${repoPath(repo)}/issues`, { method: "POST", json: payload }));
}

/**
 * Edit an issue: any of its title, body and state. Closing takes GitHub's
 * "completed" reason unless the caller names "not_planned"; reopening
 * clears the reason.
 */
export async function updateIssue(
  repo: GitHubRepo,
  number: number,
  input: { title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown },
): Promise<Issue> {
  const payload: Record<string, string | null> = {};
  if (input.title !== undefined) payload.title = requireTitle(input.title);
  if (input.body !== undefined) {
    if (typeof input.body !== "string") throw new GitHubError("body must be a string", 400);
    payload.body = cleanText(input.body);
  }
  if (input.state !== undefined) {
    if (input.state !== "open" && input.state !== "closed") {
      throw new GitHubError("state must be open or closed", 400);
    }
    payload.state = input.state;
    if (input.state === "closed") {
      payload.state_reason = input.stateReason === "not_planned" ? "not_planned" : "completed";
    } else {
      payload.state_reason = null;
    }
  }
  if (Object.keys(payload).length === 0) {
    throw new GitHubError("Nothing to change: give a title, body or state", 400);
  }
  return toIssue(
    await github<RawIssue>(`${repoPath(repo)}/issues/${number}`, { method: "PATCH", json: payload }),
  );
}

export async function addComment(repo: GitHubRepo, number: number, body: unknown): Promise<IssueComment> {
  const text = typeof body === "string" ? cleanText(body) : "";
  if (!text.trim()) throw new GitHubError("A comment needs some text", 400);
  return toComment(
    await github<RawComment>(`${repoPath(repo)}/issues/${number}/comments`, {
      method: "POST",
      json: { body: text },
    }),
  );
}

/** The issue number a route segment names, or a 400 for anything else. */
export function parseIssueNumber(segment: string | undefined): number {
  const n = Number(segment);
  if (!Number.isInteger(n) || n <= 0) throw new GitHubError("An issue number is a positive integer", 400);
  return n;
}
