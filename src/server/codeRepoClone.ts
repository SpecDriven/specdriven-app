// Cloning a missing code repo (specs/app/project-settings.feature.md "A
// code repo that is not on this computer is offered for cloning"): a
// teammate's project-settings.json names `../acme-app`, but this computer has
// only the data repo — a fresh clone through the app's GitHub sign-in, say,
// or the desktop app's own clones folder. The app offers to clone it into
// the folder the path resolves to, from a url it suggests: the data repo's
// own GitHub owner with the code repo's folder name, which holds for the
// usual layout of a team's repos side by side on GitHub.
//
// A clone can outlast a request (the server's idle timeout is a minute), so
// it runs in the background: starting one answers at once, and the Project
// settings page polls the job's state until the folder is there or the
// clone failed.

import { mkdir, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { getAuth } from "./auth";
import { directoryExists } from "./fsx";
import { clone, isRepoRoot } from "./git";
import { remoteUrl } from "./github";
import { repoOfFolder } from "./issues";
import { looksLikeRepoUrl, parseGitHubUrl } from "./repo";

/** A clone in flight, or one that failed and has not been tried again. */
export interface CodeRepoCloneJob {
  url: string;
  state: "running" | "failed";
  error?: string;
}

/** A refusal worded for the user, with the HTTP status the route answers. */
export class CodeRepoCloneError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

const jobs = new Map<string, CodeRepoCloneJob>();

type CloneRunner = (url: string, dir: string) => Promise<void>;
let runner: CloneRunner = clone;

/** Tests: clone with this instead of the git engine; none puts the engine back. */
export function setCodeRepoCloneRunner(run?: CloneRunner): void {
  runner = run ?? clone;
}

/** The clone job for a code repo's folder, if one ran since the start and has not finished well. */
export function codeRepoCloneJob(dir: string): CodeRepoCloneJob | undefined {
  return jobs.get(dir);
}

/**
 * The url the app suggests for a code repo it cannot find: the data repo's
 * GitHub owner, on the data repo's host, with the code repo's folder name —
 * `../acme-app` beside `github.com/acme/acme-specs` is
 * `https://github.com/acme/acme-app`. Null when the data repo is no GitHub
 * one, so there is nothing to go on; the user can still type a url.
 */
export async function suggestedCloneUrl(dataDir: string, codeRepoDir: string): Promise<string | null> {
  const data = await repoOfFolder(dataDir, (await getAuth())?.host);
  if (!data) return null;
  const name = basename(codeRepoDir);
  if (!name || name === "." || name === "..") return null;
  return parseGitHubUrl(`${data.url.replace(/\/[^/]+$/, "")}/${name}`)?.url ?? null;
}

/**
 * What git is handed for a url the user confirmed: a GitHub one (github.com
 * or an Enterprise host) as its canonical clone url, so the app's sign-in
 * applies as it does for the data repo; any other https or ssh url as typed.
 */
export function cloneSource(input: string): string {
  const typed = input.trim();
  const gh = parseGitHubUrl(typed);
  if (gh) return remoteUrl(gh.owner, gh.name, gh.host);
  if (looksLikeRepoUrl(typed) && !/\s/.test(typed)) return typed;
  throw new CodeRepoCloneError(`Not a repository url: ${typed || "(empty)"}`, 400);
}

/**
 * Start cloning `url` into a code repo's folder, in the background. Refused
 * when the folder is already there — a clone never lands on someone's work —
 * or a clone into it is already running. A failed clone leaves no folder
 * behind (a half-made one would read as found), and its error stays on the
 * job for the page to show until the next try.
 */
export function startCodeRepoClone(
  dir: string,
  url: string,
  run: CloneRunner = runner,
): Promise<{ done: Promise<void> }> {
  return (async () => {
    const source = cloneSource(url);
    if (jobs.get(dir)?.state === "running") throw new CodeRepoCloneError(`Already cloning into ${dir}`, 409);
    if (await directoryExists(dir)) throw new CodeRepoCloneError(`There is already a folder at ${dir}`, 409);
    const job: CodeRepoCloneJob = { url: url.trim(), state: "running" };
    jobs.set(dir, job);
    const done = (async () => {
      try {
        await mkdir(dirname(dir), { recursive: true });
        await run(source, dir);
        jobs.delete(dir);
      } catch (e) {
        if (!(await isRepoRoot(dir).catch(() => false))) await rm(dir, { recursive: true, force: true }).catch(() => {});
        jobs.set(dir, { ...job, state: "failed", error: (e as Error).message });
      }
    })();
    return { done };
  })();
}

/** Tests: forget every job. */
export function resetCodeRepoClones(): void {
  jobs.clear();
}
