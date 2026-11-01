// Spec folders (specs/app/spec-folders.feature.md "One entry per
// repository"): a GitHub url and a folder on this computer can name the same
// spec data repo — the url's own clone opened by its path, or another
// checkout of that repository. The folder list keeps one entry per
// repository, the most recently opened, so the same data is never on the
// list (or open) twice under two names.

import { resolve } from "node:path";
import { originUrl } from "./issues";
import { dataRepoDir, parseGitHubUrl } from "./repo";

/** The repository an `origin` remote names — https, scp-like ssh or ssh:// — or null. */
function remoteRepo(url: string): string | null {
  const trimmed = url.trim().replace(/^(https?:\/\/)[^@/]+@/i, "$1");
  const ssh =
    trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i) ?? trimmed.match(/^[^@/:]+@([^/:]+):(?!\/)(.+)$/);
  return parseGitHubUrl(ssh ? `https://${ssh[1]}/${ssh[2]}` : trimmed)?.url ?? null;
}

/** A folder path as compared: Windows and macOS file systems ignore case. */
function dirKey(dir: string): string {
  const full = resolve(dir);
  return process.platform === "win32" || process.platform === "darwin" ? full.toLowerCase() : full;
}

interface RepoId {
  /** The folder the entry opens. */
  dir: string;
  /** The GitHub repository behind it — the url itself, or a folder's `origin` — when known. */
  repo: string | null;
}

async function repoId(entry: string, rootDir: string): Promise<RepoId> {
  const dir = dataRepoDir(entry, rootDir);
  const repo = parseGitHubUrl(entry)?.url ?? remoteRepo((await originUrl(dir)) ?? "");
  return { dir: dirKey(dir), repo: repo?.toLowerCase() ?? null };
}

/**
 * Whether two entries are the same spec data repo: the same GitHub
 * repository when both name one, else the same folder. Two urls that only
 * share a clone folder name (acme/specs, other/specs) stay apart.
 */
function same(a: RepoId, b: RepoId): boolean {
  return a.repo && b.repo ? a.repo === b.repo : a.dir === b.dir;
}

/** The list with every later entry for an earlier entry's repository dropped. */
export async function onePerRepo(repos: readonly string[], rootDir: string): Promise<string[]> {
  const ids = await Promise.all(repos.map((r) => repoId(r, rootDir)));
  return repos.filter((_, i) => !ids.slice(0, i).some((earlier) => same(earlier, ids[i]!)));
}

/** The entries of `repos` that name the same repository as `target`, target itself included. */
export async function sameRepoAs(target: string, repos: readonly string[], rootDir: string): Promise<string[]> {
  const wanted = await repoId(target, rootDir);
  const ids = await Promise.all(repos.map((r) => repoId(r, rootDir)));
  return repos.filter((r, i) => r === target || same(wanted, ids[i]!));
}
