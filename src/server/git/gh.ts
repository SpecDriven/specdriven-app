// GitHub CLI engine (git-operations.md): the same `git`
// subprocesses as the plain engine, with two things taken over by `gh` —
// GitHub credentials come from gh's own credential helper (the wiring
// `gh auth setup-git` writes, but per command rather than into the user's
// config), and a GitHub repo is cloned with `gh repo clone`. gh is asked,
// never configured; nothing here writes to the machine's git config.
//
// With gh installed but signed out there is nothing for it to contribute, so
// every command falls back to the plain-git context — the machine's own
// credentials keep working instead of being reset to nothing. The app's own
// sign-in (a pasted token above all) is the person's explicit choice, so it
// wins over gh's account the same way. Signing out of the app turns gh's
// account off too (setGhAccountEnabled), so "signed out" means signed out.

import { getAuth } from "../auth";
import { run, which } from "../run";
import type { GitBackend } from "./backend";
import {
  SIGN_IN_HINT,
  appContext,
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

// Whether the app may fall back to gh's account while it has no sign-in of
// its own — the "useGhAccount" setting, applied at startup and on change.
let enabled = true;

/** Apply the "use the GitHub CLI account" setting. */
export function setGhAccountEnabled(on: boolean): void {
  enabled = on;
}

/**
 * Whether gh's account stands in for a missing app sign-in: gh installed,
 * signed in, and not turned off by signing out of the app.
 */
export async function ghAccountInUse(): Promise<boolean> {
  return enabled && ghAvailable() && (await ghSignedIn());
}

/**
 * Forget what gh last reported. Called whenever the engine setting is
 * applied, so a `gh auth login` while the app runs is picked up by saving
 * Settings rather than restarting.
 */
export function resetGhCache(): void {
  signedIn = null;
  account = null;
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
 * The token gh holds, or null when gh is missing or signed out. Asked for
 * on every call — a token is a credential, never cached here — and used
 * only for API requests the app makes on the user's behalf
 * (src/server/issues.ts).
 */
export async function ghToken(): Promise<string | null> {
  const path = ghPath();
  if (!path) return null;
  const res = await run(path, ["auth", "token"]);
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
 * Context for the GitHub CLI engine, unless the app has a sign-in of its own:
 * gh's credential helper for github.com,
 * scoped to that host so helpers configured for anything else stay untouched
 * (the empty entry resets only github.com's helper list). The gh account
 * authors the commits, the way the app's own sign-in does on the other engine.
 */
async function ghContext(): Promise<GitContext> {
  const path = ghPath();
  if (!path || (await getAuth()) || !(await ghSignedIn())) return appContext();
  const who = await ghAccount();
  return {
    config: [
      "-c", "credential.https://github.com.helper=",
      "-c", `credential.https://github.com.helper=${credentialHelper(path)}`,
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
 * reports gh's own errors. Anything else (a local path, another host, the
 * loopback stub the tests clone from) is a plain `git clone` with the gh
 * credential helper already in the context.
 */
async function ghClone(git: GitRun, url: string, dir: string): Promise<void> {
  const path = ghPath();
  const slug = githubSlug(url);
  if (!path || !slug || (await getAuth()) || !(await ghSignedIn())) return gitClone(git, url, dir);
  const res = await run(path, ["repo", "clone", slug, dir], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.exitCode !== 0) {
    const output = res.stderr + res.stdout;
    throw new Error(
      `Could not clone ${url}: ${isAuthFailure(output) ? SIGN_IN_HINT : output.trim()}`,
    );
  }
}

export const ghBackend: GitBackend = createGitBackend({
  name: "gh",
  git: subprocessRun(ghContext),
  clone: ghClone,
});
