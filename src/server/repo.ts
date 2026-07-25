// Per specs/app-start.spec.md, the data repo may be given as a regular
// GitHub url, e.g. https://github.com/SpecDriven/data-insurance. A URL is
// resolved to a local clone in a sibling directory of the app root
// (../data-insurance), cloning on first use. Plain names/paths keep working
// as local directories.

import { resolve } from "node:path";
import { clone, isRepoRoot, rewriteSshOrigin } from "./git";
import { remoteUrl } from "./github";
import { cloneBase } from "./paths";

export interface GitHubRepo {
  /** Canonical https url identifying the repository. */
  url: string;
  owner: string;
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
  return { url: `https://github.com/${owner}/${name}`, owner: owner!, name: name! };
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
 * clone). Cloning goes through the git engine facade
 * (specs/git-operations.spec.md) — the built-in engine by default, system
 * git when chosen or as fallback. A pre-existing app-managed clone from
 * the old ssh-scheme era gets its origin rewritten to https once, so both
 * engines can keep talking to it.
 */
export async function ensureClone(url: string, dir: string): Promise<void> {
  if (await isRepoRoot(dir)) {
    await rewriteSshOrigin(dir);
    return;
  }
  await clone(url, dir);
}

/**
 * Resolve the configured data repo (GitHub url or local name/path) to a local
 * directory. Cloning a URL on first use doubles as the access check from
 * specs/crud-feature.spec.md ("user is verified to have access to the data
 * GH repo").
 */
export async function resolveDataRepo(dataRepo: string, rootDir: string): Promise<string> {
  const gh = parseGitHubUrl(dataRepo);
  if (gh) {
    const dir = cloneDir(rootDir, gh.name);
    await ensureClone(remoteUrl(gh.owner, gh.name), dir);
    return dir;
  }
  if (looksLikeRepoUrl(dataRepo)) {
    throw new Error(
      `Unsupported data repo URL: ${dataRepo.trim()} — expected https://github.com/<owner>/<repo>`,
    );
  }
  return resolve(rootDir, dataRepo.trim());
}
