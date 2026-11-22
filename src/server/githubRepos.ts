// Making a repository on GitHub (specs/app/extract-specs-from-code.
// feature.md "Published to GitHub"): the specification folder a code
// project gets is given a repository of its own, under the account the
// project's own repository is in or the one signed in.
//
// The token is the one every other GitHub call here carries
// (src/server/issues.ts issuesToken): gh's when the GitHub CLI is the Git
// access, the app's sign-in otherwise. Not every sign-in may create a
// repository — a fine-grained token needs the Administration permission,
// the GitHub App's own may not have it — so a refusal is worded for the
// dialog, which then keeps the folder on this computer.
//
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { getAuth } from "./auth";
import { apiBase, GITHUB_HOST, remoteUrl, webBase } from "./github";
import { issuesToken, repoOfFolder } from "./issues";

/** A failure worded for the user. */
export class GitHubRepoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API_VERSION = "2022-11-28";

/** How many organisations are offered as owners at most. */
const MAX_OWNERS = 30;

interface Answer {
  status: number;
  body: Record<string, unknown> | unknown[] | null;
}

/** One request to a GitHub host's REST API; the status is the caller's to judge. */
async function request(host: string, token: string, path: string, init: { method?: string; json?: unknown } = {}): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(host)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "SpecDriven",
        "X-GitHub-Api-Version": API_VERSION,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch (e) {
    throw new GitHubRepoError(`GitHub could not be reached: ${(e as Error).message}`, 502);
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as Answer["body"] };
}

/** GitHub's own words for a failure: its message, and what its `errors` add. */
function detail(body: Answer["body"]): string {
  if (!body || Array.isArray(body)) return "";
  const message = typeof body.message === "string" ? body.message : "";
  const errors = Array.isArray(body.errors)
    ? body.errors
        .map((e) => (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : ""))
        .filter(Boolean)
    : [];
  return [message, ...errors].filter(Boolean).join(": ");
}

const NOT_SIGNED_IN = "Sign in to GitHub in Settings to create a repository";

/** Where a specification folder's repository can be made, for the dialog. */
export interface RepoOwners {
  /** The GitHub host: the code project's, else the sign-in's. */
  host: string;
  /** The accounts to offer, the suggested one first; empty when none can be offered. */
  owners: string[];
  /** Why no repository can be made, when none can. */
  problem?: string;
}

/**
 * The accounts a code project's specification repository could go under:
 * first the owner of the project's own GitHub repository — its specs
 * belong beside it — then the account signed in, then its organisations.
 * Never throws: with no sign-in, or GitHub out of reach, the answer says why.
 */
export async function repoOwners(codeDir: string): Promise<RepoOwners> {
  const auth = await getAuth().catch(() => null);
  const project = await repoOfFolder(codeDir, auth?.host).catch(() => null);
  const host = project?.host ?? auth?.host ?? GITHUB_HOST;
  const token = await issuesToken(host).catch(() => null);
  if (!token) return { host, owners: [], problem: NOT_SIGNED_IN };
  try {
    const user = await request(host, token, "/user");
    if (user.status === 401) return { host, owners: [], problem: "GitHub rejected the sign-in; sign in again in Settings" };
    const login = user.body && !Array.isArray(user.body) && typeof user.body.login === "string" ? user.body.login : "";
    if (!login) return { host, owners: [], problem: `GitHub did not say who is signed in (HTTP ${user.status})` };
    const orgs = await request(host, token, `/user/orgs?per_page=${MAX_OWNERS}`);
    const names = Array.isArray(orgs.body)
      ? orgs.body.map((o) => (o && typeof o === "object" ? (o as { login?: unknown }).login : null)).filter((l): l is string => typeof l === "string")
      : [];
    const owners: string[] = [];
    for (const name of [project?.owner, login, ...names]) {
      if (name && !owners.some((o) => o.toLowerCase() === name.toLowerCase())) owners.push(name);
    }
    return { host, owners: owners.slice(0, MAX_OWNERS) };
  } catch (e) {
    return { host, owners: [], problem: (e as Error).message };
  }
}

export interface NewRepo {
  host: string;
  owner: string;
  name: string;
  private: boolean;
  description?: string;
}

export interface MadeRepo {
  /** The repository's page. */
  url: string;
  /** What git clones and pushes to. */
  cloneUrl: string;
  /** The branch its first commit is on. */
  branch: string;
}

/**
 * Make a repository, with a first commit so that it can be cloned like any
 * other. One of that name that holds nothing but such a first commit is
 * taken as it is — the repository of an earlier try that got no further —
 * and any other is refused: it is someone's work.
 */
export async function createRepo(repo: NewRepo): Promise<MadeRepo> {
  const token = await issuesToken(repo.host);
  if (!token) throw new GitHubRepoError(NOT_SIGNED_IN, 401);
  const full = `${repo.owner}/${repo.name}`;
  const made = (body: Answer["body"]): MadeRepo => {
    const b = (body && !Array.isArray(body) ? body : {}) as { html_url?: unknown; default_branch?: unknown };
    return {
      url: typeof b.html_url === "string" ? b.html_url : `${webBase(repo.host)}/${full}`,
      cloneUrl: remoteUrl(repo.owner, repo.name, repo.host),
      branch: typeof b.default_branch === "string" && b.default_branch ? b.default_branch : "main",
    };
  };

  const existing = await request(repo.host, token, `/repos/${repo.owner}/${repo.name}`);
  if (existing.status === 200) {
    const commits = await request(repo.host, token, `/repos/${repo.owner}/${repo.name}/commits?per_page=2`);
    // 409 is GitHub's answer for a repository with no commit at all.
    const count = Array.isArray(commits.body) ? commits.body.length : commits.status === 409 ? 0 : 2;
    if (count > 1) throw new GitHubRepoError(`${full} already exists on GitHub — choose another name`, 409);
    return made(existing.body);
  }
  if (existing.status === 401) throw new GitHubRepoError("GitHub rejected the sign-in; sign in again in Settings", 401);

  const user = await request(repo.host, token, "/user");
  const login = user.body && !Array.isArray(user.body) && typeof user.body.login === "string" ? user.body.login : "";
  const own = login.toLowerCase() === repo.owner.toLowerCase();
  const res = await request(repo.host, token, own ? "/user/repos" : `/orgs/${repo.owner}/repos`, {
    method: "POST",
    json: {
      name: repo.name,
      private: repo.private,
      ...(repo.description ? { description: repo.description } : {}),
      auto_init: true,
    },
  });
  if (res.status === 201) return made(res.body);
  const said = detail(res.body);
  if (res.status === 401) throw new GitHubRepoError("GitHub rejected the sign-in; sign in again in Settings", 401);
  if (res.status === 403) {
    throw new GitHubRepoError(
      `GitHub did not let this sign-in create a repository for ${repo.owner}${said ? `: ${said}` : ""}`,
      403,
    );
  }
  if (res.status === 404) {
    throw new GitHubRepoError(
      own
        ? `GitHub did not let this sign-in create a repository${said ? `: ${said}` : ""}`
        : `${repo.owner} is not an organisation this sign-in can create a repository in`,
      404,
    );
  }
  if (res.status === 422) throw new GitHubRepoError(`${full} cannot be created${said ? `: ${said}` : ""}`, 422);
  throw new GitHubRepoError(`GitHub answered HTTP ${res.status}${said ? `: ${said}` : ""}`, 502);
}
