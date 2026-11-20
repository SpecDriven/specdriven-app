// Who may use a repository's sync server: whoever GitHub says can push to
// that repository. The peer hands over its GitHub token once; this asks
// GitHub's own REST API what that token may do there, and keeps nothing.

export interface RepoName {
  owner: string;
  name: string;
}

export type Access =
  | { ok: true }
  | {
      ok: false;
      /** 401: GitHub does not know the token. 403: known, but may not write. 502: GitHub did not answer. */
      status: 401 | 403 | 502;
      error: string;
    };

/**
 * Whether `token` may push to `repo`, by GitHub's account of it
 * (`GET /repos/{owner}/{repo}`, whose `permissions.push` is the token's own
 * right to write). Reading is not enough, and a repository the token cannot
 * see at all is refused the same way, without saying whether it exists.
 */
export async function checkWriteAccess(
  apiBase: string,
  repo: RepoName,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<Access> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase.replace(/\/+$/, "")}/repos/${repo.owner}/${repo.name}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "specdriven-sync-server",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "GitHub could not be reached to check access" };
  }
  if (res.status === 401) return { ok: false, status: 401, error: "GitHub did not accept the token" };
  if (res.status === 403 || res.status === 404) {
    return { ok: false, status: 403, error: "Write access to the repository is required" };
  }
  if (!res.ok) return { ok: false, status: 502, error: `GitHub answered ${res.status} to the access check` };
  let body: { permissions?: { push?: unknown } } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, status: 502, error: "GitHub's answer to the access check could not be read" };
  }
  if (body?.permissions?.push !== true) {
    return { ok: false, status: 403, error: "Write access to the repository is required" };
  }
  return { ok: true };
}
