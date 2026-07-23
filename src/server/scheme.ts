// Git scheme (specs/git-operations.spec.md): the logged-in user talks to
// GitHub with one of three schemes — https, ssh, or gh (the GitHub CLI as
// git's credential helper). The scheme can be chosen in Settings
// (specs/user-info-settings.spec.md); without a choice it is auto-discovered
// by probing in the order https, ssh, gh. Every git command follows the
// effective scheme via per-command config, so it works no matter which url
// a clone was created with.

import { run, which } from "./run";

export type GitScheme = "https" | "ssh" | "gh";

/** All schemes, in the probe order fixed by the spec: https, ssh, gh. */
export const GIT_SCHEMES: readonly GitScheme[] = ["https", "ssh", "gh"];

export function normalizeGitScheme(value: unknown): GitScheme | null {
  return GIT_SCHEMES.includes(value as GitScheme) ? (value as GitScheme) : null;
}

/**
 * Per-command `git -c` config making a command follow the scheme:
 * `url.<base>.insteadOf` rewrites any GitHub remote url to the scheme's
 * transport, and `gh` rides https with the GitHub CLI as the only
 * credential helper (the empty helper entry resets inherited ones).
 */
export function schemeArgs(scheme: GitScheme | null): string[] {
  switch (scheme) {
    case "https":
      return [
        "-c", "url.https://github.com/.insteadOf=git@github.com:",
        "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/",
      ];
    case "ssh":
      return ["-c", "url.git@github.com:.insteadOf=https://github.com/"];
    case "gh":
      return [
        "-c", "url.https://github.com/.insteadOf=git@github.com:",
        "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/",
        "-c", "credential.helper=",
        "-c", "credential.helper=!gh auth git-credential",
      ];
    default:
      return [];
  }
}

/** Probes must fail fast — never sit on a credential or ssh prompt. */
export const PROBE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};

export function ghCliAvailable(): boolean {
  return which("gh") !== null;
}

/** Schemes worth probing: gh only when the GitHub CLI is installed. */
export function probeSchemes(): GitScheme[] {
  return GIT_SCHEMES.filter((s) => s !== "gh" || ghCliAvailable());
}

// The effective scheme: the one chosen in Settings, or — per repo — the one
// auto-discovery landed on. Discoveries hold for the server run only, so a
// changed environment is re-probed after a restart or a settings change.
let chosen: GitScheme | null = null;
const discovered = new Map<string, GitScheme | null>();
const probing = new Map<string, Promise<GitScheme | null>>();
let generation = 0;

/** Apply the scheme chosen in Settings; null returns to auto-discovery. */
export function setGitScheme(scheme: GitScheme | null): void {
  chosen = scheme;
  generation++;
  discovered.clear();
  probing.clear();
}

export function chosenScheme(): GitScheme | null {
  return chosen;
}

/** Sync view of the scheme every git command in repoDir must follow. */
export function gitSchemeFor(repoDir: string): GitScheme | null {
  return chosen ?? discovered.get(repoDir) ?? null;
}

/** Record the scheme a successful probe (e.g. a probed clone) landed on. */
export function recordDiscoveredScheme(repoDir: string, scheme: GitScheme): void {
  if (!chosen) discovered.set(repoDir, scheme);
}

const GITHUB_REMOTE = /(^|@|\/\/)([^/]*\.)?github\.com[/:]/;

/**
 * Effective scheme for a repo, auto-discovering when none is chosen: probe
 * `git ls-remote` against origin with each scheme's config (order: https,
 * ssh, gh) and remember the first that authenticates. Repos without a
 * GitHub origin have no scheme. One probe per repo per server run; callers
 * pass a repo root (see isRepoRoot) so the origin lookup cannot walk up
 * into a containing repo.
 */
export function discoverScheme(repoDir: string): Promise<GitScheme | null> {
  if (chosen) return Promise.resolve(chosen);
  const known = discovered.get(repoDir);
  if (known !== undefined) return Promise.resolve(known);
  let pending = probing.get(repoDir);
  if (!pending) {
    const gen = generation;
    pending = probeOrigin(repoDir).then((scheme) => {
      // A settings change mid-probe supersedes this result — drop it.
      if (gen === generation) {
        discovered.set(repoDir, scheme);
        probing.delete(repoDir);
      }
      return scheme;
    });
    probing.set(repoDir, pending);
  }
  return pending;
}

async function probeOrigin(repoDir: string): Promise<GitScheme | null> {
  const origin = await run("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  if (origin.exitCode !== 0 || !GITHUB_REMOTE.test(origin.stdout.trim())) {
    return null;
  }
  for (const scheme of probeSchemes()) {
    const res = await run(
      "git",
      ["-C", repoDir, ...schemeArgs(scheme), "ls-remote", "origin", "HEAD"],
      { env: PROBE_ENV },
    );
    if (res.exitCode === 0) return scheme;
  }
  return null;
}
