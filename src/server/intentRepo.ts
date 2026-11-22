// The specification folder a code project gets (specs/app/extract-specs-
// from-code.feature.md): `specs-<project>`, made beside the project — the
// layout the app assumes for a code repository and its specs — set up as a
// specification folder, pointed back at the project in its
// project-settings.yaml, and given the spec folders the user chose.
//
// Nothing is written into the code project, with one exception the user
// asks for by name: the `specs` link (src/server/specsLink.ts).
//
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stampDataFormat } from "./dataFormat";
import { createSpecFolders } from "./features";
import { initSpecFolder } from "./folderKind";
import { writeTextFile } from "./fsx";
import { clone, commitAllAndPublish, commitAndPush, isRepoRoot } from "./git";
import { originUrl } from "./git/origin";
import { remoteUrl, webBase } from "./github";
import { createRepo, GitHubRepoError, type MadeRepo } from "./githubRepos";
import { ROOT_ID } from "./intentModules";
import { repoNameProblem, specsRepoName } from "./intentNames";
import { ensureProjectSettings, PROJECT_SETTINGS_FILE, readProjectSettings, writeCodeRepos } from "./members";
import { slugify } from "./parser";
import { looksLikeRepoUrl, parseGitHubUrl, resolveDataRepo } from "./repo";
import { createSpecsLink, SpecsLinkError } from "./specsLink";
import { cleanLine } from "./text";
import { SPECS_FOLDER } from "./walk";

/** A refusal worded for the user, with the HTTP status the route answers. */
export class ExtractError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** More for the dialog: `{ existing: "spec" }` offers "Open it instead". */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** What a folder may hold and still be free to become a specification folder. */
const IGNORED_WHEN_EMPTY = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * What a repository nobody has worked in yet holds, besides Finder's files:
 * git's own folder, what GitHub can start a repository with (a README, a
 * licence, a .gitignore), and the two folders of a specification folder
 * that got only half set up. Such a folder can be set up as a
 * specification folder without anything of someone's being in the way
 * (specs/app/extract-specs-from-code.feature.md "Target specs repo is not
 * initialized").
 */
const FRESH_REPO_NAMES = new Set([".git", ".gitignore", ".gitattributes", ".specdriven", SPECS_FOLDER]);
const FRESH_REPO_FILE = /^(readme|license|licence|copying)(\.[\w-]+)?$/i;

/** How many spec folders one extraction makes at most, and how deep. */
const MAX_CHOSEN_FOLDERS = 200;
const MAX_CHOSEN_DEPTH = 6;

/**
 * The code project a path names: absolute (a leading `~` is the home
 * folder), a folder that exists, and not a specification folder — those
 * hold specs already.
 */
export async function resolveCodeProject(input: unknown): Promise<string> {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) throw new ExtractError(400, "Choose the code project's folder");
  const expanded = typed === "~" || typed.startsWith("~/") ? homedir() + typed.slice(1) : typed;
  if (!isAbsolute(expanded)) throw new ExtractError(400, "The code project's folder must be an absolute path");
  const dir = resolve(expanded);
  const info = await stat(dir).catch(() => null);
  if (!info) throw new ExtractError(404, `There is no folder at ${dir}`);
  if (!info.isDirectory()) throw new ExtractError(400, `${dir} is not a folder`);
  if (await isSpecFolder(dir)) {
    throw new ExtractError(400, `${dir} is a specification folder, not a code project`);
  }
  return dir;
}

/**
 * Whether a folder that is not a specification folder can be set up as one:
 * it holds nothing but what a fresh repository holds (FRESH_REPO_NAMES), and
 * a `specs` there is a folder, not a code repository's link.
 */
async function canSetUp(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => null);
  if (!names || (await isSpecFolder(dir))) return false;
  if (!names.every((n) => IGNORED_WHEN_EMPTY.has(n) || FRESH_REPO_NAMES.has(n) || FRESH_REPO_FILE.test(n))) return false;
  for (const folder of [".specdriven", SPECS_FOLDER]) {
    if (!names.includes(folder)) continue;
    if (!(await lstat(join(dir, folder))).isDirectory()) return false;
  }
  return true;
}

async function isSpecFolder(dir: string): Promise<boolean> {
  const [data, specs] = await Promise.all([
    stat(join(dir, ".specdriven")).catch(() => null),
    stat(join(dir, SPECS_FOLDER)).catch(() => null),
  ]);
  return data?.isDirectory() === true && specs?.isDirectory() === true;
}

export type TargetState =
  /** Nothing there, or an empty folder: the specification folder can be made. */
  | "free"
  /** A specification folder already: it can be opened instead. */
  | "spec"
  /** A fresh repository — a clone of an empty one, or one with only a README: it can be set up and added to. */
  | "unset"
  /** Something else: another name is needed. */
  | "taken";

/** Where a project's specification folder goes — beside the project — and what is there now. */
export async function specsTarget(codeDir: string, name: string): Promise<{ dir: string; state: TargetState }> {
  const dir = resolve(dirname(codeDir), name);
  const info = await stat(dir).catch(() => null);
  if (!info) return { dir, state: "free" };
  if (!info.isDirectory()) return { dir, state: "taken" };
  if (await isSpecFolder(dir)) return { dir, state: "spec" };
  const names = await readdir(dir).catch(() => ["?"]);
  if (names.every((n) => IGNORED_WHEN_EMPTY.has(n))) return { dir, state: "free" };
  return { dir, state: (await canSetUp(dir)) ? "unset" : "taken" };
}

/** The name a project's specification folder is given unless the user types another. */
export function suggestedSpecsName(codeDir: string): string {
  return specsRepoName(basename(codeDir));
}

/**
 * The specification folder a code project already has, when the app can
 * tell: one of its suggested name beside it, or the one its `specs` link
 * points into. Null when neither is there — the usual case, a project with
 * no specifications yet.
 */
export async function existingSpecsFor(codeDir: string): Promise<string | null> {
  const beside = await specsTarget(codeDir, suggestedSpecsName(codeDir));
  if (beside.state === "spec") return beside.dir;
  // The link as written, not where it finally resolves: the folder is named as the user knows it.
  const link = await readlink(join(codeDir, SPECS_FOLDER)).catch(() => null);
  if (!link) return null;
  const linked = resolve(codeDir, link);
  return basename(linked) === SPECS_FOLDER && dirname(linked) !== resolve(codeDir) && (await isSpecFolder(dirname(linked)))
    ? dirname(linked)
    : null;
}

/**
 * The specification folder a request names as already there ("Add to a
 * specification folder that already exists"): a folder on this computer,
 * by its absolute path, or a repository on GitHub, which is cloned where
 * the app keeps its clones — as opening it would. Either way it must be a
 * specification folder, and not the code project. `open` is what the app
 * opens it by: the url for a repository, the path for a folder.
 *
 * A fresh repository — an empty one cloned, or one holding only what GitHub
 * starts a repository with — is not refused outright: without `initialize`
 * the answer asks whether to set it up (`{ initialize: true }`, 409); with
 * it, `setUp` says the folder is to be set up before anything is added.
 * Nothing is written here either way.
 */
export async function resolveSpecsFolder(
  input: unknown,
  codeDir: string,
  appRoot: string,
  initialize = false,
): Promise<{ dir: string; open: string; setUp?: true }> {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) throw new ExtractError(400, "Name the specification folder to add to");
  let dir: string;
  let open: string;
  if (parseGitHubUrl(typed) || looksLikeRepoUrl(typed)) {
    try {
      dir = await resolveDataRepo(typed, appRoot);
    } catch (e) {
      throw new ExtractError(400, (e as Error).message);
    }
    open = typed;
  } else {
    const expanded = typed === "~" || typed.startsWith("~/") ? homedir() + typed.slice(1) : typed;
    if (!isAbsolute(expanded)) throw new ExtractError(400, "The specification folder must be an absolute path or a GitHub url");
    dir = resolve(expanded);
    open = dir;
    const info = await stat(dir).catch(() => null);
    if (!info) throw new ExtractError(404, `There is no folder at ${dir}`);
    if (!info.isDirectory()) throw new ExtractError(400, `${dir} is not a folder`);
  }
  if (dir === resolve(codeDir)) throw new ExtractError(400, "That is the code project's own folder");
  if (!(await isSpecFolder(dir))) {
    if (await canSetUp(dir)) {
      if (initialize) return { dir, open, setUp: true };
      throw new ExtractError(409, `${dir} is not set up as a specification folder yet`, { initialize: true, dir });
    }
    throw new ExtractError(400, `${dir} is not a specification folder — it has no .specdriven and specs folders`);
  }
  return { dir, open };
}

/** One spec folder the user chose. */
export interface ChosenFolder {
  /** Under the spec tree, slug segments: `billing/invoices`. */
  folder: string;
  /** What the sidebar calls it. */
  name: string;
  /** The analysed folders (src/server/intentModules.ts ids) whose code its specs are drafted from. */
  modules: string[];
  /** Whether specs are drafted for it; a folder that only holds others is made and left empty. */
  draft: boolean;
}

/**
 * The chosen folders as a request sent them, checked: each a slug path no
 * deeper than the app nests, named once, and drawing only on folders the
 * analysis of the project found (`known`) — each of those at most once, so
 * no code is drafted from twice. Throws an ExtractError naming what is wrong.
 */
export function chosenFolders(input: unknown, known: ReadonlySet<string>): ChosenFolder[] {
  if (!Array.isArray(input) || input.length === 0) throw new ExtractError(400, "Choose at least one folder");
  if (input.length > MAX_CHOSEN_FOLDERS) {
    throw new ExtractError(400, `At most ${MAX_CHOSEN_FOLDERS} folders can be made at once`);
  }
  const paths = new Set<string>();
  const used = new Set<string>();
  const out: ChosenFolder[] = [];
  for (const raw of input as { folder?: unknown; name?: unknown; modules?: unknown; draft?: unknown }[]) {
    const folder = typeof raw?.folder === "string" ? raw.folder.trim() : "";
    const segments = folder.split("/");
    if (!folder || segments.length > MAX_CHOSEN_DEPTH || segments.some((s) => !s || slugify(s) !== s)) {
      throw new ExtractError(400, `Not a folder path: ${folder || "(empty)"}`);
    }
    if (paths.has(folder)) throw new ExtractError(400, `Two folders share the path ${folder}`);
    paths.add(folder);
    const modules = Array.isArray(raw.modules) ? raw.modules.filter((m): m is string => typeof m === "string") : [];
    for (const id of modules) {
      if (!known.has(id)) throw new ExtractError(400, `${folder} names code the project does not have: ${id}`);
      if (used.has(id)) throw new ExtractError(400, `${id === ROOT_ID ? "The project's top" : id} is in two folders`);
      used.add(id);
    }
    const name = typeof raw.name === "string" ? cleanLine(raw.name).slice(0, 100) : "";
    out.push({ folder, name, modules, draft: raw.draft === true && modules.length > 0 });
  }
  return out;
}

export interface CreateSpecsOptions {
  /** The code project, as resolveCodeProject answered. */
  codeDir: string;
  /** The specification folder's name; its folder is made beside the project. */
  name: string;
  folders: readonly ChosenFolder[];
  /** Also make the project's `specs` link to the new folder. */
  link?: boolean;
  /**
   * Give the folder a repository on GitHub: made there, cloned to the
   * folder's place before anything is written, and pushed to once the
   * folder is set up. When GitHub refuses, the folder is made plain and the
   * result says why.
   */
  github?: PublishTo | null;
}

/** Where on GitHub a specification folder's repository goes. */
export interface PublishTo {
  host: string;
  owner: string;
  private: boolean;
}

/** `github` as a request sent it, or null when it asks for no repository. */
export function publishTo(input: unknown): PublishTo | null {
  if (!input || typeof input !== "object") return null;
  const { host, owner, private: isPrivate } = input as { host?: unknown; owner?: unknown; private?: unknown };
  if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner.trim())) {
    throw new ExtractError(400, "Choose the account the repository goes under");
  }
  if (typeof host !== "string" || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host.trim())) {
    throw new ExtractError(400, "Not a GitHub host");
  }
  return { host: host.trim(), owner: owner.trim(), private: isPrivate !== false };
}

/** How long a repository just made is given before a second try at cloning it. */
const CLONE_RETRY_MS = 1500;

/** Clone a repository that was made a moment ago: GitHub now and then needs a second. */
async function cloneNew(url: string, dir: string): Promise<void> {
  try {
    await clone(url, dir);
  } catch {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, CLONE_RETRY_MS));
    await clone(url, dir);
  }
}

const commitMessage = (project: string) => `Set up specifications for ${project}`;
const describe = (project: string) => `Specifications for ${project}`;

export interface CreatedSpecs {
  /** The specification folder: the new one, or the existing one that was added to. */
  dir: string;
  /** What the app opens it by, when that is not its path: the url of a repository that was cloned. */
  open?: string;
  /** The folder was there already, and the chosen folders were added to it. */
  existing?: boolean;
  /** The existing folder was a fresh repository, set up as a specification folder first. */
  setUp?: boolean;
  /** The spec folders made, `specs/` prefixed. */
  folders: string[];
  /** The repository's page on GitHub, when it was published. */
  github: string | null;
  /** Why it was not published, when publishing was asked for. */
  githubProblem?: string;
  /** Why the `specs` link was not made, when it was asked for. */
  linkProblem?: string;
}

/** The README a new specification folder starts with. */
function readme(name: string, project: string): string {
  return [
    `# ${name}`,
    "",
    `Specifications for \`${project}\`, kept with [SpecDriven](https://specdriven.app).`,
    "",
    `- \`specs/\` holds the features: one \`.feature.md\` file each, its scenarios inside.`,
    `- \`project-settings.yaml\` names the code repository these specifications describe (\`../${project}\`).`,
    "",
    "The first features here were extracted from the code and are marked `[proposed]`: read them, correct them, and publish the ones that say what the code is meant to do.",
    "",
  ].join("\n");
}

/**
 * Make a code project's specification folder: the folder beside the
 * project, `.specdriven` and `specs` inside, the data format marker, a
 * project-settings.yaml naming the project as its code repository, a
 * README, and the chosen spec folders. Refused when the name is not one a
 * repository can have, or something already sits at the place — a
 * specification folder there is reported as such, so the dialog can offer
 * to open it.
 */
export async function createSpecsFolder(options: CreateSpecsOptions): Promise<CreatedSpecs> {
  const name = options.name.trim();
  const problem = repoNameProblem(name);
  if (problem) throw new ExtractError(400, problem);
  const target = await specsTarget(options.codeDir, name);
  if (target.dir === resolve(options.codeDir)) throw new ExtractError(400, "That is the code project's own folder");
  if (target.state === "spec") {
    throw new ExtractError(409, `${target.dir} is a specification folder already`, { existing: "spec", dir: target.dir });
  }
  if (target.state === "unset") {
    throw new ExtractError(409, `${target.dir} is a repository not set up for specifications yet — set it up and add to it instead`, {
      existing: "unset",
      dir: target.dir,
    });
  }
  if (target.state === "taken") {
    throw new ExtractError(409, `There is already something at ${target.dir} — choose another name`, { existing: "taken", dir: target.dir });
  }
  const dir = target.dir;
  const project = basename(options.codeDir);

  // The repository first: the folder then starts life as its clone, and
  // what is written below is its first commit of our own.
  let repo: MadeRepo | null = null;
  let githubProblem: string | undefined;
  if (options.github) {
    try {
      const made = await createRepo({ ...options.github, name, description: describe(project) });
      try {
        // Free means nothing but a Finder file is there: the clone needs the place.
        await rm(dir, { recursive: true, force: true });
        await cloneNew(made.cloneUrl, dir);
        repo = made;
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        githubProblem = `${made.url} was made, but could not be cloned: ${(e as Error).message}`;
      }
    } catch (e) {
      githubProblem = e instanceof GitHubRepoError ? e.message : `GitHub could not be reached: ${(e as Error).message}`;
    }
  }

  await mkdir(dir, { recursive: true });
  await initSpecFolder(dir);
  await stampDataFormat(dir);
  await ensureProjectSettings(dir);
  await writeCodeRepos(dir, [options.codeDir], options.codeDir);
  // A repository made on GitHub brings a README of its own; this one says more.
  await writeTextFile(join(dir, "README.md"), readme(name, project));
  const { folders } = await createSpecFolders(
    dir,
    options.folders.map((f) => ({ path: f.folder, name: f.name })),
  );
  if (repo) {
    const sync = await commitAllAndPublish(dir, repo.branch, commitMessage(project));
    if (!sync.pushed) githubProblem = `${repo.url} was made, but the folder was not pushed to it: ${sync.failure ?? sync.message}`;
  }

  let linkProblem: string | undefined;
  if (options.link) {
    try {
      await createSpecsLink(options.codeDir, dir);
    } catch (e) {
      linkProblem = e instanceof SpecsLinkError ? e.message : `The specs link was not made: ${(e as Error).message}`;
    }
  }
  return {
    dir,
    folders,
    github: repo?.url ?? null,
    ...(githubProblem ? { githubProblem } : {}),
    ...(linkProblem ? { linkProblem } : {}),
  };
}

/**
 * Give a specification folder that is only on this computer its repository
 * on GitHub ("Without GitHub the folder stays local and can be published
 * later"): the repository is made, cloned beside the folder, and the
 * clone's `.git` moved into the folder — which thereby becomes that
 * repository's working copy, everything in it still to be committed — then
 * all of it is committed and pushed. A folder that got as far as being a
 * repository on an earlier try is only pushed again. Returns the
 * repository's page.
 */
export async function publishSpecsFolder(dir: string, to: PublishTo): Promise<string> {
  const name = basename(dir);
  const problem = repoNameProblem(name);
  if (problem) throw new ExtractError(400, `${name} cannot be a repository's name: ${problem}`);
  const codeRepo = (await readProjectSettings(dir)).codeRepo;
  const project = codeRepo ? basename(codeRepo) : name.replace(/^specs-/, "");
  try {
    // A folder that became the repository's working copy on an earlier try
    // has only its push left to do.
    if (await isRepoRoot(dir)) {
      const origin = await originUrl(dir);
      if (origin !== remoteUrl(to.owner, name, to.host)) {
        throw new ExtractError(409, `${dir} is a repository already${origin ? `, pushing to ${origin}` : ""}`);
      }
      const url = `${webBase(to.host)}/${to.owner}/${name}`;
      const sync = await commitAllAndPublish(dir, "main", commitMessage(project));
      if (!sync.pushed) throw new ExtractError(502, `The folder was not pushed to ${url}: ${sync.failure ?? sync.message}`);
      return url;
    }
    const repo = await createRepo({ ...to, name, description: describe(project) });
    const temp = join(dirname(dir), `.${name}.publish-${randomBytes(4).toString("hex")}`);
    try {
      await cloneNew(repo.cloneUrl, temp);
      await rename(join(temp, ".git"), join(dir, ".git"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    const sync = await commitAllAndPublish(dir, repo.branch, commitMessage(project));
    if (!sync.pushed) {
      throw new ExtractError(502, `${repo.url} was made, but the folder was not pushed to it: ${sync.failure ?? sync.message}`);
    }
    return repo.url;
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    if (e instanceof GitHubRepoError) throw new ExtractError(e.status === 401 ? 401 : 502, e.message);
    throw new ExtractError(502, `Publishing to GitHub failed: ${(e as Error).message}`);
  }
}

/**
 * Add a code project's chosen folders to a specification folder that is
 * already there. Nothing it holds is replaced: a spec folder of the same
 * path keeps its display name, its features stay, and the README, the data
 * format and the git history are the folder's own. The code project joins
 * the code repositories its project-settings.yaml names — as the default
 * only when it names none — and what was written is committed as the app
 * commits any edit there.
 *
 * With `setUp` (resolveSpecsFolder's answer for a fresh repository) the
 * folder is first made a specification folder — `.specdriven` and `specs`,
 * the data format marker, project-settings.yaml, and a README when it has
 * none — and everything is committed as one "Set up specifications for
 * <project>" and pushed; an empty repository's first push starts its branch.
 */
export async function addToSpecsFolder(options: {
  codeDir: string;
  /** The existing specification folder, as resolveSpecsFolder answered. */
  dir: string;
  folders: readonly ChosenFolder[];
  link?: boolean;
  setUp?: boolean;
}): Promise<CreatedSpecs> {
  const { codeDir, dir } = options;
  const project = basename(codeDir);
  if (options.setUp) {
    await initSpecFolder(dir);
    await stampDataFormat(dir);
    await ensureProjectSettings(dir);
    const hasReadme = (await readdir(dir)).some((n) => /^readme(\.[\w-]+)?$/i.test(n));
    if (!hasReadme) await writeTextFile(join(dir, "README.md"), readme(basename(dir), project));
  }
  const settings = await readProjectSettings(dir);
  let settingsChanged = false;
  if (!settings.codeRepos.some((repo) => resolve(repo.dir) === resolve(codeDir))) {
    settingsChanged = await writeCodeRepos(
      dir,
      [...settings.codeRepos.map((repo) => repo.path), codeDir],
      settings.codeRepos.find((repo) => repo.isDefault)?.path ?? null,
    );
  }
  const { folders, files } = await createSpecFolders(
    dir,
    options.folders.map((f) => ({ path: f.folder, name: f.name })),
  );
  let githubProblem: string | undefined;
  if (options.setUp) {
    // All of it, as one commit: the folder held nothing of anyone's before.
    if (await isRepoRoot(dir)) {
      const sync = await commitAllAndPublish(dir, "main", commitMessage(project)).catch((e: Error) => ({
        pushed: false,
        failure: e.message,
        message: e.message,
      }));
      if (!sync.pushed) githubProblem = `${dir} was set up and committed, but the push failed: ${sync.failure ?? sync.message}`;
    }
  } else {
    const written = [...files, ...(settingsChanged ? [PROJECT_SETTINGS_FILE] : [])];
    // A push that fails is the sync's to retry; the folders are there either way.
    if (written.length > 0) await commitAndPush(dir, written, `Add spec folders for ${project}`).catch(() => undefined);
  }

  let linkProblem: string | undefined;
  if (options.link) {
    try {
      await createSpecsLink(codeDir, dir);
    } catch (e) {
      linkProblem = e instanceof SpecsLinkError ? e.message : `The specs link was not made: ${(e as Error).message}`;
    }
  }
  return {
    dir,
    existing: true,
    folders,
    github: null,
    ...(options.setUp ? { setUp: true } : {}),
    ...(githubProblem ? { githubProblem } : {}),
    ...(linkProblem ? { linkProblem } : {}),
  };
}
