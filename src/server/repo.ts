// Per specs/ui/app-start.feature.md, the data repo may be given as a regular
// GitHub url, e.g. https://github.com/SpecDriven/data-insurance, or the same
// url on a GitHub Enterprise host (https://github.acme.com/team/specs). A URL is
// resolved to a local clone in a sibling directory of the app root
// (../data-insurance), cloning on first use. Plain names/paths keep working
// as local directories.

import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { clone, isRepoRoot } from "./git";
import { GITHUB_HOST, isLoopbackHost, remoteUrl, webBase } from "./github";
import { cloneBase } from "./paths";

export interface GitHubRepo {
  /** Canonical https url identifying the repository. */
  url: string;
  /** github.com, or the GitHub Enterprise host the repository lives on. */
  host: string;
  owner: string;
  /** Repository name — used as the local clone directory name. */
  name: string;
}

const NAME = "[A-Za-z0-9._-]+";
const GITHUB_HTTPS_RE = new RegExp(
  `^(?:https:\\/\\/)?(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME}?)(?:\\.git)?\\/?$`,
);
const SSH_RE = new RegExp(`^git@github\\.com:(${NAME})\\/(${NAME}?)(?:\\.git)?$`);
// Any other host needs its scheme spelled out, so a relative folder path
// like `team.specs/a/b` is never taken for one. Plain http is a test's
// loopback stub only.
const ENTERPRISE_RE = new RegExp(
  `^(https?):\\/\\/([A-Za-z0-9.-]+(?::\\d+)?)\\/(${NAME})\\/(${NAME}?)(?:\\.git)?\\/?$`,
);

// Well-known hosts that are not GitHub: refused with the "Unsupported data
// repo URL" message up front rather than failing later in a clone. Any
// other host may be a GitHub Enterprise Server, whose names are arbitrary.
const NOT_GITHUB = new Set(["gitlab.com", "bitbucket.org", "codeberg.org", "dev.azure.com"]);

export function parseGitHubUrl(input: string): GitHubRepo | null {
  const trimmed = input.trim();
  const gh = trimmed.match(GITHUB_HTTPS_RE) ?? trimmed.match(SSH_RE);
  if (gh) return repo(GITHUB_HOST, gh[1]!, gh[2]!);
  const other = trimmed.match(ENTERPRISE_RE);
  if (!other) return null;
  const [, scheme, rawHost, owner, name] = other;
  const host = rawHost!.toLowerCase();
  if (scheme === "http" && !isLoopbackHost(host)) return null;
  if (NOT_GITHUB.has(host.replace(/^www\./, ""))) return null;
  if (host === GITHUB_HOST || host === `www.${GITHUB_HOST}`) return repo(GITHUB_HOST, owner!, name!);
  return repo(host, owner!, name!);
}

function repo(host: string, owner: string, name: string): GitHubRepo | null {
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  // The canonical url names github.com itself even when a test points
  // github.com's transport at a stub.
  const base = host === GITHUB_HOST ? "https://github.com" : webBase(host);
  return { url: `${base}/${owner}/${name}`, host, owner, name };
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
    await ensureClone(remoteUrl(gh.owner, gh.name, gh.host), dir);
    return dir;
  }
  if (looksLikeRepoUrl(dataRepo)) {
    throw new Error(
      `Unsupported data repo URL: ${dataRepo.trim()} — expected https://github.com/<owner>/<repo> or a GitHub Enterprise https://<host>/<owner>/<repo>`,
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
