// Per specs/app-start.spec.md, the data repo may be given as a regular
// GitHub url, e.g. https://github.com/SpecDriven/data-insurance. A URL is
// resolved to a local clone in a sibling directory of the app root
// (../data-insurance), cloning on first use. Plain names/paths keep working
// as local directories.

import { resolve } from "node:path";
import { isRepoRoot } from "./git";
import { cloneBase } from "./paths";
import { run } from "./run";
import {
  chosenScheme,
  discoverScheme,
  probeSchemes,
  recordDiscoveredScheme,
  schemeArgs,
  PROBE_ENV,
} from "./scheme";
import type { GitScheme } from "./scheme";

export interface GitHubRepo {
  /**
   * Canonical https url. The url form only identifies the repository — the
   * git scheme decides the actual transport (specs/git-operations.spec.md).
   */
  url: string;
  /** Repository name — used as the local clone directory name. */
  name: string;
}

const HTTPS_RE =
  /^(?:https:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const SSH_RE = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

export function parseGitHubUrl(input: string): GitHubRepo | null {
  const trimmed = input.trim();
  const m = trimmed.match(HTTPS_RE) ?? trimmed.match(SSH_RE);
  if (!m) return null;
  const [, owner, name] = m;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { url: `https://github.com/${owner}/${name}`, name: name! };
}

/** Something the user clearly meant as a URL, even if we can't parse it. */
export function looksLikeRepoUrl(input: string): boolean {
  return /^(https?:\/\/|git@|(www\.)?github\.com\/)/i.test(input.trim());
}

/**
 * Local directory a GitHub repo is cloned into: a sibling of the app root,
 * unless SPECDRIVEN_REPOS_DIR points somewhere (the desktop app keeps clones
 * in its own data directory — specs/desktop-app.spec.md).
 */
export function cloneDir(rootDir: string, repoName: string): string {
  return resolve(cloneBase(rootDir), repoName);
}

/** Local directory a configured data repo resolves to, without cloning. */
export function dataRepoDir(dataRepo: string, rootDir: string): string {
  const gh = parseGitHubUrl(dataRepo);
  return gh ? cloneDir(rootDir, gh.name) : resolve(rootDir, dataRepo.trim());
}

/**
 * Clone into dir unless dir is already a git repo (e.g. a pre-existing
 * clone). A GitHub url is cloned with the chosen git scheme; with none
 * chosen the schemes are probed in order (specs/git-operations.spec.md —
 * https, ssh, gh) and the first that works is remembered as the discovered
 * scheme. Prompts are disabled so auth failures fail fast instead of
 * hanging on the server's stdin; git removes the target dir on failure, so
 * the next probe starts clean.
 */
export async function ensureClone(url: string, dir: string): Promise<void> {
  if (await isRepoRoot(dir)) return;
  const chosen = chosenScheme();
  const schemes: (GitScheme | null)[] = parseGitHubUrl(url)
    ? chosen
      ? [chosen]
      : probeSchemes()
    : [null]; // local paths and non-GitHub urls have no scheme
  const failures: string[] = [];
  for (const scheme of schemes) {
    const probingEnv = scheme && !chosen;
    const res = await run("git", [...schemeArgs(scheme), "clone", url, dir], {
      env: probingEnv ? PROBE_ENV : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (res.exitCode === 0) {
      if (scheme) recordDiscoveredScheme(dir, scheme);
      return;
    }
    const detail = res.stderr.trim() || res.stdout.trim();
    failures.push(`Could not clone ${url}${scheme ? ` via ${scheme}` : ""}: ${detail}`);
  }
  throw new Error(failures.join("\n"));
}

/**
 * Resolve the configured data repo (GitHub url or local name/path) to a local
 * directory. Cloning a URL on first use doubles as the access check from
 * specs/crud-feature.spec.md ("user is verified to have access to the data
 * GH repo"). The repo's git scheme is resolved here too, so every following
 * git command follows it (specs/git-operations.spec.md).
 */
export async function resolveDataRepo(dataRepo: string, rootDir: string): Promise<string> {
  const gh = parseGitHubUrl(dataRepo);
  if (gh) {
    const dir = cloneDir(rootDir, gh.name);
    await ensureClone(gh.url, dir);
    await discoverScheme(dir);
    return dir;
  }
  if (looksLikeRepoUrl(dataRepo)) {
    throw new Error(
      `Unsupported data repo URL: ${dataRepo.trim()} — expected https://github.com/<owner>/<repo>`,
    );
  }
  const dir = resolve(rootDir, dataRepo.trim());
  // A local dir may still have a GitHub origin (a clone made by hand); a
  // dir that is not a repo root (e.g. the starter data/ folder) has no
  // scheme and must not probe the containing repo's origin.
  if (await isRepoRoot(dir)) await discoverScheme(dir);
  return dir;
}
