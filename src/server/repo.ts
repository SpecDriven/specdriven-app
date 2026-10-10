// Per specs/ui/app-start.feature.md, the data repo may be given as a regular
// GitHub url, e.g. https://github.com/SpecDriven/data-insurance. A URL is
// resolved to a local clone in a sibling directory of the app root
// (../data-insurance), cloning on first use. Plain names/paths keep working
// as local directories.

import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { clone, isRepoRoot } from "./git";
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
 * in its own data directory — specs/app/desktop-app.feature.md).
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
 * (git-operations.md): `gh repo clone` on the GitHub CLI engine,
 * `git clone` on the system-git one.
 */
export async function ensureClone(url: string, dir: string): Promise<void> {
  if (await isRepoRoot(dir)) return;
  await clone(url, dir);
}

/**
 * Resolve the configured data repo (GitHub url or local name/path) to a local
 * directory. Cloning a URL on first use doubles as the access check from
 * crud-feature.md ("user is verified to have access to the data
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

/**
 * Whether a picked data folder is there to open (specs/app/spec-folders.feature.md
 * "Switch spec folder"): a typo must not quietly make a new, empty folder,
 * so a missing one is only created when the user said so (`create`).
 * Throws MissingDataRepoError when it is missing and not to be created, and
 * a plain Error when the path names something other than a folder.
 */
export async function ensureDataRepoFolder(dir: string, create: boolean): Promise<void> {
  const s = await stat(dir).catch(() => null);
  if (s?.isDirectory()) return;
  if (s) throw new Error(`Not a folder: ${dir}`);
  if (!create) throw new MissingDataRepoError(dir);
  await mkdir(dir, { recursive: true });
}

export class MissingDataRepoError extends Error {
  constructor(readonly dir: string) {
    super(`No folder at ${dir}`);
  }
}
