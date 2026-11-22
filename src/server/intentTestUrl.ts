// Where a code project's test links point (specs/app/extract-specs-from-
// code.feature.md "Test links are built by the app"): a test link is a
// github.com `blob` url naming a line (src/server/parser.ts isTestLink,
// src/server/testName.ts parseTestUrl), so a project can have its tests
// linked only when its `origin` is a repository on github.com. The url is
// made of that repository, its default branch, and the file's path from the
// repository's top — the project may be a folder inside it.
//
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { defaultBranch, type BranchGit } from "./defaultBranch";
import { originUrl } from "./git/origin";
import { githubRepoOfRemote } from "./issues";
import { run } from "./run";

/** Why a project's tests cannot be linked, as the dialogs say it. */
export const NO_GITHUB_REMOTE =
  "Test links point at files on github.com, and this project has no repository there (its origin remote is not a github.com one)";

export type TestLinkBase =
  | {
      /** Everything in front of a file's path: `https://github.com/<owner>/<repo>/blob/<branch>/<prefix>`. */
      base: string;
      /** `<owner>/<repo>`, for the dialogs to name. */
      repo: string;
      branch: string;
    }
  | { base: null; problem: string };

/** What a dialog needs to offer test linking for a project: how many test files it has, and where links would point. */
export interface TestLinking {
  /** How many test files the project has. */
  files: number;
  /** `<owner>/<repo>` on github.com, where the links point; null when the project has none. */
  repo: string | null;
  /** Why its tests cannot be linked. */
  problem?: string;
}

const systemGit: BranchGit = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** The top folder of the git repository `dir` is in, or null when it is in none. */
async function repoTop(dir: string): Promise<string | null> {
  for (let at = resolve(dir); ; at = dirname(at)) {
    try {
      await stat(resolve(at, ".git"));
      return at;
    } catch {
      // Not here: look one folder up.
    }
    if (dirname(at) === at) return null;
  }
}

/** A path as a url carries it: each segment escaped, so a space or a `]` never ends a `[test: … ]` token. */
const urlPath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/**
 * The base of a code project's test links, or why it has none. The branch
 * is the repository's default one — what the remote's HEAD names, as far as
 * the checkout knows without asking over the network — else `main`.
 */
export async function testLinkBase(codeDir: string, git: BranchGit = systemGit): Promise<TestLinkBase> {
  const top = await repoTop(codeDir);
  const origin = top ? await originUrl(top) : null;
  const repo = origin ? githubRepoOfRemote(origin) : null;
  if (!top || !repo) return { base: null, problem: NO_GITHUB_REMOTE };
  let branch = "main";
  try {
    const found = await defaultBranch(git, top, { ask: false });
    if (found?.branch) branch = found.branch;
  } catch {
    // No git to ask: `main` it is.
  }
  const prefix = urlPath(relative(top, resolve(codeDir)).split(sep).join("/"));
  return {
    base: `https://github.com/${repo.owner}/${repo.name}/blob/${urlPath(branch)}/${prefix ? `${prefix}/` : ""}`,
    repo: `${repo.owner}/${repo.name}`,
    branch,
  };
}

/** The link to a test: its file under the base, anchored at its line. */
export const testUrl = (base: string, path: string, line: number): string => `${base}${urlPath(path)}#L${line}`;
