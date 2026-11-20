// The urls on the signed-commit list (signing.ts): what one names — a
// repository, an owner or a whole host — and whether it covers a remote.
// No imports, so the Settings page checks an entry with the same code the
// server does.

/** What a listed url names: a host, and under it an owner or an owner's repository. */
export interface RepoScope {
  /** Lower case, without `www.` or a port. */
  host: string;
  /** Nothing (the whole host), the owner, or the owner and the repository. */
  path: string[];
}

const SCHEMES = new Set(["https", "http", "ssh", "git"]);
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The scope a url names, in any form a person pastes or git writes into a
 * remote: `https://github.com/acme/specs`, the same with `.git`, a user or
 * a `/tree/main` tail, `github.com/acme`, `git@github.com:acme/specs.git`,
 * `ssh://git@github.example.com:22/acme/specs`. Null for anything else — a
 * folder path above all, which names no host.
 */
export function parseRepoScope(input: string): RepoScope | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let host: string;
  let rest: string;
  const scp = text.match(/^[^@/:]+@([^/:]+):(?!\/)(.*)$/);
  if (scp) {
    [, host, rest] = scp as unknown as [string, string, string];
  } else {
    const m = text.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^@/]+@)?([^/:@]+)(?::\d+)?(?:\/(.*))?$/i);
    if (!m) return null;
    if (m[1] !== undefined && !SCHEMES.has(m[1].toLowerCase())) return null;
    host = m[2]!;
    rest = m[3] ?? "";
    // Without a scheme, `acme/specs` is an owner and a repository, not a host.
    if (m[1] === undefined && !host.includes(".") && host.toLowerCase() !== "localhost") return null;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  if (!HOST.test(host)) return null;
  const path = rest.split(/[?#]/)[0]!.split("/").filter(Boolean).slice(0, 2);
  if (path.length === 2) path[1] = path[1]!.replace(/\.git$/i, "");
  if (path.some((segment) => !segment || segment === "." || segment === ".." || !SEGMENT.test(segment))) return null;
  return { host, path };
}

/** A scope as the settings file and the Settings page write it. */
export function scopeUrl(scope: RepoScope): string {
  return `https://${[scope.host, ...scope.path].join("/")}`;
}

const scopeKey = (scope: RepoScope): string => [scope.host, ...scope.path].join("/").toLowerCase();

/** Whether `scope` covers `repo`: the same host, and the same owner and repository as far as the scope names them. */
export function covers(scope: RepoScope, repo: RepoScope): boolean {
  if (scope.host !== repo.host || scope.path.length > repo.path.length) return false;
  return scope.path.every((segment, i) => segment.toLowerCase() === repo.path[i]!.toLowerCase());
}

/**
 * A stored or posted list, cleaned: each url in its written form
 * (`https://host/owner/repo`), once; anything that is not a url is dropped.
 */
export function normalizeSignedCommitRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const scope = typeof entry === "string" ? parseRepoScope(entry) : null;
    if (!scope || seen.has(scopeKey(scope))) continue;
    seen.add(scopeKey(scope));
    out.push(scopeUrl(scope));
  }
  return out;
}
