// Per specs/app-start.spec.md, the data repo may be given as a regular
// GitHub url, e.g. https://github.com/SpecDriven/data-insurance. A URL is
// resolved to a local clone in a sibling directory of the app root
// (../data-insurance), cloning on first use. Plain names/paths keep working
// as local directories.

import { $ } from "bun";
import { resolve } from "node:path";
import { isRepoRoot } from "./git";

export interface GitHubRepo {
  /** Candidate clone URLs, in probe order (specs/datastore.spec.md). */
  urls: string[];
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
  const https = `https://github.com/${owner}/${name}`;
  const ssh = `git@github.com:${owner}/${name}.git`;
  const urls = trimmed.startsWith("git@") ? [ssh, https] : [https, ssh];
  return { urls, name: name! };
}

/** Something the user clearly meant as a URL, even if we can't parse it. */
export function looksLikeRepoUrl(input: string): boolean {
  return /^(https?:\/\/|git@|(www\.)?github\.com\/)/i.test(input.trim());
}

/** Local directory a GitHub repo is cloned into: a sibling of the app root. */
export function cloneDir(rootDir: string, repoName: string): string {
  return resolve(rootDir, "..", repoName);
}

/**
 * Clone into dir unless dir is already a git repo (e.g. a pre-existing
 * clone). Urls are probed in order — per specs/datastore.spec.md an https://
 * clone can fail on auth where ssh succeeds. GIT_TERMINAL_PROMPT=0 makes
 * auth failures fail fast instead of prompting on the server's stdin; git
 * removes the target dir on failure, so the next probe starts clean.
 */
export async function ensureClone(urls: string | string[], dir: string): Promise<void> {
  if (await isRepoRoot(dir)) return;
  const failures: string[] = [];
  for (const url of Array.isArray(urls) ? urls : [urls]) {
    const res = await $`git clone ${url} ${dir}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .quiet()
      .nothrow();
    if (res.exitCode === 0) return;
    const detail = res.stderr.toString().trim() || res.stdout.toString().trim();
    failures.push(`Could not clone ${url}: ${detail}`);
  }
  throw new Error(failures.join("\n"));
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
    await ensureClone(gh.urls, dir);
    return dir;
  }
  if (looksLikeRepoUrl(dataRepo)) {
    throw new Error(
      `Unsupported data repo URL: ${dataRepo.trim()} — expected https://github.com/<owner>/<repo>`,
    );
  }
  return resolve(rootDir, dataRepo.trim());
}
