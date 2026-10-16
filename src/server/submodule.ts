// Add the spec repo to a code repo as a git submodule
// (specs/app/code-repo-submodule.feature.md). The app keeps working
// on its own standalone clone of the spec repo; what this adds is the other
// direction — the code repo pins the spec repo, so cloning the code with
// `--recurse-submodules` brings the specs that go with it.
//
// The submodule's url is the data repo's own origin, so the code repo points
// at the same remote the app pushes to. The new `.gitmodules` entry and the
// gitlink are committed in the code repo — those two paths only, whatever
// else is staged there — and never pushed: the code repo is the user's, and
// sharing it is their call.
//
// `git submodule` is system git only: the bundled engine (just-git) does not
// implement it, so the route refuses without a git binary whatever engine
// Settings has chosen.

import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { appContext, isAuthFailure, signInHint, subprocessRun } from "./git/cli";
import type { GitRun } from "./git/cli";
import { githubRepoOfRemote, originUrl } from "./issues";
import { directoryExists } from "./fsx";

/** A refusal worded for the user, with the HTTP status the route answers. */
export class SubmoduleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502,
  ) {
    super(message);
  }
}

export interface AddedSubmodule {
  /** The code repo, absolute. */
  codeRepo: string;
  /** Where the specs now sit, relative to the code repo. */
  path: string;
  /** The url recorded in `.gitmodules` — the data repo's origin. */
  url: string;
  /** The branch recorded for `git submodule update --remote`, or null. */
  branch: string | null;
  /** The code repo's new commit. */
  commit: string;
}

/**
 * The submodule's default folder name: the spec repo's name on GitHub, else
 * the last segment of its url, else the data folder's own name.
 */
export function defaultSubmoduleName(url: string, dataDir: string): string {
  const github = githubRepoOfRemote(url);
  if (github) return github.name;
  const last = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  return last.replace(/\.git$/, "") || basename(dataDir);
}

/** A path inside the code repo: relative, no `..`, no leading dot-folder. */
function validName(name: string): boolean {
  if (!name || isAbsolute(name) || name.includes("\\")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Add the data repo at `dataDir` to the git repo at `codeRepo` as a
 * submodule named `name` (default: defaultSubmoduleName), and commit it there.
 */
export async function addSpecsSubmodule(
  dataDir: string,
  codeRepo: string,
  name?: string,
  git: GitRun = subprocessRun(appContext),
): Promise<AddedSubmodule> {
  const code = resolve(dataDir, codeRepo);
  if (!(await directoryExists(code))) {
    throw new SubmoduleError(`Code repo not found: ${code}`, 400);
  }
  const top = await git(code, "rev-parse", "--show-toplevel");
  const codeReal = await realpath(code);
  if (top.exitCode !== 0 || (await realpath(top.stdout.trim()).catch(() => "")) !== codeReal) {
    throw new SubmoduleError(`Not the top folder of a git repository: ${code}`, 400);
  }
  const dataReal = await realpath(dataDir);
  if (within(dataReal, codeReal) || within(codeReal, dataReal)) {
    throw new SubmoduleError(
      "The code repo and the spec repo must be separate folders, neither inside the other",
      400,
    );
  }

  const url = await originUrl(dataDir);
  if (!url) {
    throw new SubmoduleError(
      "The spec repo has no origin remote to point the submodule at — push it to GitHub first",
      409,
    );
  }
  const path = (name ?? "").trim() || defaultSubmoduleName(url, dataDir);
  if (!validName(path)) throw new SubmoduleError(`Not a folder name inside the code repo: ${path}`, 400);
  if (await exists(resolve(code, path))) {
    throw new SubmoduleError(`${path} already exists in ${code}`, 409);
  }
  const listed = await git(code, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.url$");
  if (listed.exitCode === 0) {
    for (const line of listed.stdout.split("\n")) {
      const [key, value] = line.trim().split(/\s+/, 2);
      if (value === url) {
        const at = key!.replace(/^submodule\./, "").replace(/\.url$/, "");
        throw new SubmoduleError(`${code} already has this spec repo as a submodule (${at})`, 409);
      }
    }
  }

  // Follow the branch the app works on, so `git submodule update --remote`
  // brings the newest specs from it. A detached clone records none.
  const head = await git(dataDir, "rev-parse", "--abbrev-ref", "HEAD");
  const current = head.exitCode === 0 ? head.stdout.trim() : "";
  const branch = current && current !== "HEAD" ? current : null;

  const added = await git(code, "submodule", "add", ...(branch ? ["-b", branch] : []), "--", url, path);
  if (added.exitCode !== 0) {
    const output = (added.stderr + added.stdout).trim();
    throw new SubmoduleError(
      `git submodule add failed: ${isAuthFailure(output) ? signInHint() : output}`,
      502,
    );
  }
  const message = `Add ${basename(path)} specs as a submodule`;
  const committed = await git(code, "commit", "-m", message, "--", ".gitmodules", path);
  if (committed.exitCode !== 0) {
    const output = (committed.stderr + committed.stdout).trim();
    throw new SubmoduleError(
      `Added ${path} to ${code}, but the commit failed — commit .gitmodules and ${path} yourself: ${output}`,
      502,
    );
  }
  const sha = await git(code, "rev-parse", "HEAD");
  return { codeRepo: code, path, url, branch, commit: sha.stdout.trim() };
}
