// GitHub CLI engine (git-operations.md): the same `git`
// subprocesses as the plain engine, with two things taken over by `gh` —
// GitHub credentials come from gh's own credential helper (the wiring
// `gh auth setup-git` writes, but per command rather than into the user's
// config), and a GitHub repo is cloned with `gh repo clone`. gh is asked,
// never configured; nothing here writes to the machine's git config.
//
// This engine is the "GitHub CLI" Git access (src/server/git/access.ts):
// choosing it is choosing gh's account, so the app's own token is not used
// here — it belongs to the other two accesses. With gh installed but signed
// out there is nothing for it to contribute, so every command runs with the
// machine's own git credentials instead of being reset to nothing.

import { run, which } from "../run";
import type { GitBackend } from "./backend";
import { currentGitAccess } from "./access";
import {
  signInHint,
  createGitBackend,
  gitClone,
  identityConfig,
  isAuthFailure,
  subprocessRun,
} from "./cli";
import type { GitContext, GitRun } from "./cli";

/** The GitHub account `gh` is logged in as. */
export interface GhAccount {
  login: string;
  name: string | null;
  /** Commit email; the account's noreply address when the real one is private. */
  email: string;
}

/** Absolute path of the gh binary, or null when it is not installed. */
export function ghPath(): string | null {
  return which("gh");
}

export function ghAvailable(): boolean {
  return ghPath() !== null;
}

// What gh last reported. Asking costs a subprocess (and, for the account, a
// network round-trip), and git commands ask on every invocation.
let signedIn: Promise<boolean> | null = null;
let account: Promise<GhAccount | null> | null = null;

let hosts: Promise<string[]> | null = null;

/**
 * Whether gh's account is the one in use: the GitHub CLI is the Git access
 * in effect, and gh is installed and signed in.
 */
export async function ghAccountInUse(): Promise<boolean> {
  return currentGitAccess() === "gh" && ghAvailable() && (await ghSignedIn());
}

/**
 * Forget what gh last reported. Called whenever the engine setting is
 * applied, so a `gh auth login` while the app runs is picked up by saving
 * Settings rather than restarting.
 */
export function resetGhCache(): void {
  signedIn = null;
  account = null;
  hosts = null;
}

/**
 * The hosts gh is logged in to — github.com and any GitHub Enterprise host
 * (`gh auth login --hostname …`) — so gh's credential helper answers for
 * each of them. A gh too old for `auth status --json` is taken to know
 * github.com only.
 */
export function ghHosts(): Promise<string[]> {
  return (hosts ??= (async () => {
    const path = ghPath();
    if (!path) return [];
    const res = await run(path, ["auth", "status", "--json", "hosts"]);
    if (res.exitCode === 0) {
      try {
        const data = JSON.parse(res.stdout) as { hosts?: Record<string, { state?: string }[]> };
        const known = Object.entries(data.hosts ?? {})
          .filter(([, accounts]) => accounts.some((a) => a.state === "success"))
          .map(([host]) => host);
        if (known.length > 0) return known;
      } catch {
        // Not JSON: fall through to github.com.
      }
    }
    return ["github.com"];
  })());
}

/** Whether gh holds a token — a local lookup, no network. */
export function ghSignedIn(): Promise<boolean> {
  return (signedIn ??= (async () => {
    const path = ghPath();
    if (!path) return false;
    return (await run(path, ["auth", "token"])).exitCode === 0;
  })());
}

/**
 * The token gh holds for `host` (github.com unless named), or null when gh is
 * missing or signed out there. Asked for on every call — a token is a
 * credential, never cached here — and used only for API requests the app
 * makes on the user's behalf (src/server/issues.ts).
 */
export async function ghToken(host?: string): Promise<string | null> {
  const path = ghPath();
  if (!path) return null;
  const res = await run(path, host ? ["auth", "token", "--hostname", host] : ["auth", "token"]);
  const token = res.stdout.trim();
  return res.exitCode === 0 && token ? token : null;
}

/** The signed-in gh account, or null when gh is missing, signed out or unreachable. */
export function ghAccount(): Promise<GhAccount | null> {
  return (account ??= (async () => {
    const path = ghPath();
    if (!path || !(await ghSignedIn())) return null;
    const res = await run(path, ["api", "user"]);
    if (res.exitCode !== 0) return null;
    try {
      const user = JSON.parse(res.stdout) as {
        login?: string;
        id?: number;
        name?: string | null;
        email?: string | null;
      };
      if (!user.login) return null;
      return {
        login: user.login,
        name: user.name ?? null,
        email: user.email ?? `${user.id ?? 0}+${user.login}@users.noreply.github.com`,
      };
    } catch {
      return null; // gh printed something unexpected: treat as no account
    }
  })());
}

/** `!'<gh>' auth git-credential`, quoted for the shell git runs helpers in. */
function credentialHelper(path: string): string {
  return `!'${path.replace(/'/g, `'\\''`)}' auth git-credential`;
}

/**
 * Context for the GitHub CLI engine: gh's credential helper for every host gh
 * is logged in to, each scoped to its host so helpers configured for anything
 * else stay untouched (the empty entry resets only that host's helper list).
 * The gh account authors the commits. Signed out, git runs with the
 * machine's own configuration.
 */
async function ghContext(): Promise<GitContext> {
  const path = ghPath();
  if (!path || !(await ghSignedIn())) return { config: [], env: {} };
  const who = await ghAccount();
  const helper = credentialHelper(path);
  return {
    config: [
      ...(await ghHosts()).flatMap((host) => [
        "-c", `credential.https://${host}.helper=`,
        "-c", `credential.https://${host}.helper=${helper}`,
      ]),
      ...(who ? identityConfig(who.name ?? who.login, who.email) : []),
    ],
    env: {},
  };
}

const GITHUB_REPO_URL =
  /^(?:https:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/** `owner/repo` when url names a github.com repository, else null. */
function githubSlug(url: string): string | null {
  const m = url.trim().match(GITHUB_REPO_URL);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * `gh repo clone` for GitHub repos — it carries gh's credentials itself and
 * reports gh's own errors. The repository is named with its host: a bare
 * `owner/repo` is looked up on gh's default host, which is a GitHub
 * Enterprise one when GH_HOST names it or gh is logged in there alone. Anything else (a local path, another host, the
 * loopback stub the tests clone from) is a plain `git clone` with the gh
 * credential helper already in the context.
 */
async function ghClone(git: GitRun, url: string, dir: string): Promise<void> {
  const path = ghPath();
  const slug = githubSlug(url);
  if (!path || !slug || !(await ghSignedIn())) return gitClone(git, url, dir);
  const res = await run(path, ["repo", "clone", `github.com/${slug}`, dir], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.exitCode !== 0) {
    const output = res.stderr + res.stdout;
    throw new Error(
      `Could not clone ${url}: ${isAuthFailure(output) ? signInHint() : output.trim()}`,
    );
  }
}

export const ghBackend: GitBackend = createGitBackend({
  name: "gh",
  git: subprocessRun(ghContext),
  clone: ghClone,
});
