// The routes behind "extract specs from a code project"
// (specs/app/extract-specs-from-code.feature.md). They are their own
// module, handed to the route table by src/server/api.ts, which passes in
// the wrappers only it has. The flow, as the dialog drives it:
//
//   POST /api/extract/analyse   the folders proposed for a code project
//   POST /api/extract/refine    have an agent regroup the proposal; GET and DELETE on its id
//   POST /api/extract/repo      make its specification folder, with the chosen folders —
//                               or add them to one that already exists
//   POST /api/extract/prompt    the drafting prompt a specification folder keeps, to show
//                               before anything is made
//   POST /api/extract/publish   give the open folder its repository on GitHub, later
//   POST /api/extract/draft     start drafting specs for the chosen folders — and, with
//                               `tests`, linking the project's tests to them afterwards
//                               — with the writing instructions the wizard showed, when
//                               they were changed there
//   GET  /api/extract/tests     what of the open folder could have tests linked
//   POST /api/extract/tests     start linking tests to the features extracted before
//   GET  /api/extract/draft     how the drafting stands
//   POST /api/extract/draft/cancel, /retry    stop it; take up what is not done
//   DELETE /api/extract/draft   forget a run that is over
//   GET  /api/extract/github    where the open folder could be published
//
// The drafting routes work on the specification folder that is open, and
// read the code project from its project-settings.yaml.
//
// Analysing, refining and making the folder need no specification folder
// open — making one is the point. Every such request names the code project
// by its folder, and the server analyses that folder itself: a tree a page
// sends is only ever a choice among what the analysis found.
//
// None of it is offered in the demo or the read-only site, which open no
// folders on the machine they run on; a hosted worker refuses through
// `unlessHosted`.

import { resolve } from "node:path";
import { isDemoMode } from "./demo";
import { json, type Handler, type Params } from "./http";
import { analyseModules, flattenFolders, LANGUAGE_LABEL } from "./intentModules";
import { isRepoRoot } from "./git";
import { originUrl } from "./git/origin";
import { repoOwners } from "./githubRepos";
import {
  cancelExtraction,
  dismissExtraction,
  extractionOf,
  retryExtraction,
  startExtraction,
  startLinking,
} from "./intentExtraction";
import { extractedRoots } from "./intentDraft";
import { instructionsProblem, isDefaultInstructions, tidyInstructions } from "./intentDraftPrompt";
import { readSavedInstructions, savedInstructionsAt, writeSavedInstructions } from "./intentPromptFile";
import { isTestPath } from "./intentModules";
import { testLinkBase, type TestLinking } from "./intentTestUrl";
import { listFeatures, readFeature } from "./features";
import {
  addToSpecsFolder,
  chosenFolders,
  createSpecsFolder,
  existingSpecsFor,
  ExtractError,
  publishSpecsFolder,
  publishTo,
  resolveCodeProject,
  resolveSpecsFolder,
  specsTarget,
  suggestedSpecsName,
} from "./intentRepo";
import { getAppRoot } from "./paths";
import { cancelRefine, refineJob, startRefine } from "./intentRefine";
import { scanProject } from "./intentScan";
import { readProjectSettings } from "./members";
import { isReadOnlyMode } from "./readOnlyMode";
import { specsLinkStatus } from "./specsLink";

type Route = [method: string, pattern: string, handler: Handler];

/** What the routes answer where folders on this machine cannot be opened. */
const NOT_HERE = "specs cannot be extracted from a code project here";

/** The languages the analysis reads, as a phrase. */
const LANGUAGES = `${Object.values(LANGUAGE_LABEL).slice(0, -1).join(", ")} or ${Object.values(LANGUAGE_LABEL).slice(-1)[0]}`;

/** Run a handler, answering an ExtractError with its status and words. */
const guarded =
  (handler: Handler): Handler =>
  async (req, params) => {
    if (isDemoMode() || isReadOnlyMode()) return json({ error: NOT_HERE }, 403);
    try {
      return await handler(req, params);
    } catch (e) {
      if (e instanceof ExtractError) return json({ error: e.message, ...e.extra }, e.status);
      return json({ error: (e as Error).message }, 500);
    }
  };

const bodyOf = async (req: Request): Promise<Record<string, unknown>> =>
  ((await req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};

// POST /api/extract/analyse { codeDir }: the project's module structure as
// folders to propose, with the specification folder it would get.
const postAnalyse: Handler = async (req) => {
  const body = await bodyOf(req);
  const codeDir = await resolveCodeProject(body.codeDir);
  const snapshot = await scanProject(codeDir);
  const proposal = analyseModules(snapshot);
  const name = suggestedSpecsName(codeDir);
  const target = await specsTarget(codeDir, name);
  return json({
    codeDir,
    proposal,
    ...(proposal.sourceFiles === 0 ? { problem: `No ${LANGUAGES} code was found in ${codeDir}` } : {}),
    name,
    target: target.dir,
    targetState: target.state,
    // The specification folder the project already has, when the app can tell.
    existing: await existingSpecsFor(codeDir),
    specsLink: (await specsLinkStatus(codeDir, target.dir)).state,
    github: await repoOwners(codeDir),
    // Whether the project's tests could be linked to the specs drafted from it.
    tests: await linkable(codeDir, snapshot.files.filter((f) => isTestPath(f.path)).length),
  });
};

async function linkable(codeDir: string, files: number): Promise<TestLinking> {
  const target = await testLinkBase(codeDir);
  if (target.base === null) return { files, repo: null, problem: target.problem };
  return { files, repo: target.repo, ...(files === 0 ? { problem: "No tests were found in this project" } : {}) };
}

// POST /api/extract/refine { codeDir, agent?, model? }: start an agent
// regrouping the project's proposed folders by business area. The answer is
// a job: GET /api/extract/refine/:id says how it stands, DELETE stops it.
const postRefine: Handler = async (req) => {
  const body = await bodyOf(req);
  const codeDir = await resolveCodeProject(body.codeDir);
  const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : undefined;
  const model = modelOf(body.model);
  return json(startRefine(codeDir, { ...(agent ? { agent } : {}), ...(model ? { model } : {}) }), 202);
};

const getRefine: Handler = async (_req, params) => {
  const job = refineJob(params.id ?? "");
  return job ? json(job) : json({ error: "No such regrouping" }, 404);
};

const deleteRefine: Handler = async (_req, params) => {
  const job = cancelRefine(params.id ?? "");
  return job ? json(job) : json({ error: "No such regrouping" }, 404);
};

// POST /api/extract/repo { codeDir, name, folders, link, github }: make the
// specification folder beside the project, with the chosen folders in it.
// With `existing` in place of `name` — a specification folder's path, or its
// GitHub url — the chosen folders are added to that folder instead; a fresh
// repository there is set up first when `initialize` is true, and otherwise
// answered with `{ initialize: true }` so the dialog can ask.
const postRepo: Handler = async (req) => {
  const body = await bodyOf(req);
  const codeDir = await resolveCodeProject(body.codeDir);
  const known = new Set(flattenFolders(analyseModules(await scanProject(codeDir)).folders).map((f) => f.id));
  const folders = chosenFolders(body.folders, known);
  // An existing specification folder is added to, not made.
  if (body.existing !== undefined && body.existing !== null) {
    const { dir, open, setUp } = await resolveSpecsFolder(body.existing, codeDir, getAppRoot(), body.initialize === true);
    const added = await addToSpecsFolder({ codeDir, dir, folders, link: body.link === true, setUp: setUp === true });
    return json({ ...added, ...(open !== dir ? { open } : {}) }, 201);
  }
  const created = await createSpecsFolder({
    codeDir,
    name: typeof body.name === "string" ? body.name : "",
    folders,
    link: body.link === true,
    github: publishTo(body.github),
  });
  return json(created, 201);
};

// POST /api/extract/publish { github }: the open specification folder,
// made on this computer only, gets its repository on GitHub.
const postPublish = (dir: string): Handler => async (req) => {
  const body = await bodyOf(req);
  const to = publishTo(body.github);
  if (!to) throw new ExtractError(400, "Choose the account the repository goes under");
  return json({ github: await publishSpecsFolder(dir, to) });
};

/**
 * The code project an open specification folder's specs are drafted from:
 * the one a request names, when it is one of the folder's code
 * repositories, else its default one. A folder may describe several
 * projects, and only its own are read.
 */
async function codeProjectOf(dir: string, asked?: unknown): Promise<string> {
  const { codeRepo, codeRepos } = await readProjectSettings(dir);
  if (typeof asked === "string" && asked.trim()) {
    const wanted = await resolveCodeProject(asked);
    if (!codeRepos.some((repo) => repo.dir === wanted)) {
      throw new ExtractError(400, `${wanted} is not one of this folder's code repositories`);
    }
    return wanted;
  }
  if (!codeRepo) throw new ExtractError(409, "This folder names no code repository in its project settings");
  return resolveCodeProject(codeRepo);
}

/** A model name as an agent takes one, or nothing. */
function modelOf(input: unknown): string | undefined {
  const model = typeof input === "string" ? input.trim() : "";
  if (!model) return undefined;
  if (!/^(?!-)[\w.:/@[\]-]{1,100}$/.test(model)) throw new ExtractError(400, "Not a model name");
  return model;
}

/** How the open folder's drafting stands, and whether the folder has a repository to push to. */
async function status(dir: string) {
  return {
    job: await extractionOf(dir),
    published: (await isRepoRoot(dir)) && (await originUrl(dir)) !== null,
  };
}

// POST /api/extract/prompt { folder? }: the writing instructions a
// specification folder on this computer keeps for drafting, for the wizard
// to show before anything is made; null when it has none of its own.
const postPrompt: Handler = async (req) => {
  const body = await bodyOf(req);
  return json({ saved: await savedInstructionsAt(body.folder) });
};

/**
 * The writing instructions a run drafts with, or nothing for the built-in
 * ones. Text the wizard sends is what the user was shown and changed: it is
 * checked, and kept in the folder for the next run — the built-in text
 * takes the folder's file away. Without any, the folder's own are used.
 */
async function instructionsFor(dir: string, sent: unknown): Promise<string | undefined> {
  if (sent === undefined || sent === null) return (await readSavedInstructions(dir)) ?? undefined;
  if (typeof sent !== "string") throw new ExtractError(400, "The prompt must be text");
  if (!isDefaultInstructions(sent)) {
    const problem = instructionsProblem(sent);
    if (problem) throw new ExtractError(400, problem);
  }
  await writeSavedInstructions(dir, sent);
  return isDefaultInstructions(sent) ? undefined : tidyInstructions(sent);
}

// POST /api/extract/draft { folders, codeDir?, specsDir?, agent?, model?, tests?, instructions? }: start drafting.
const postDraft = (dir: string): Handler => async (req) => {
  const body = await bodyOf(req);
  // The page names the folder it made the specs for: when another one is
  // open — the switch was refused, say — nothing is drafted into it.
  if (typeof body.specsDir === "string" && resolve(body.specsDir) !== resolve(dir)) {
    throw new ExtractError(409, "The folder that is open is not the one the folders were made in — open it, then resume");
  }
  const codeDir = await codeProjectOf(dir, body.codeDir);
  const known = new Set(flattenFolders(analyseModules(await scanProject(codeDir)).folders).map((f) => f.id));
  const folders = chosenFolders(body.folders, known);
  const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : undefined;
  const model = modelOf(body.model);
  const instructions = await instructionsFor(dir, body.instructions);
  await startExtraction({
    dataDir: dir,
    codeDir,
    folders,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(instructions ? { instructions } : {}),
    ...(body.tests === true ? { linkTests: true } : {}),
  });
  return json(await status(dir), 202);
};

// GET /api/extract/tests: the open folder's code repositories, each with
// whether its tests can be linked, and the spec folders holding features
// that were extracted from code — the only ones a linking run takes up.
const getTests = (dir: string): Handler => async () => {
  const { codeRepos } = await readProjectSettings(dir);
  const repos = await Promise.all(
    codeRepos.map(async (repo) => {
      const files = (await scanProject(repo.dir).catch(() => null))?.files.filter((f) => isTestPath(f.path)).length ?? 0;
      return { dir: repo.dir, default: repo.isDefault, ...(await linkable(repo.dir, files)) };
    }),
  );
  const folders = new Map<string, number>();
  for (const feature of await listFeatures(dir)) {
    const text = await readFeature(dir, feature.fileName);
    if (text === null || extractedRoots(text) === null) continue;
    const folder = feature.fileName.split("/").slice(1, -1).join("/");
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  return json({
    repos,
    folders: [...folders].map(([folder, features]) => ({ folder, features })).sort((a, b) => a.folder.localeCompare(b.folder)),
  });
};

// POST /api/extract/tests { codeDir?, folder?, agent?, model? }: start linking
// the project's tests to the features extracted from it before.
const postTests = (dir: string): Handler => async (req) => {
  const body = await bodyOf(req);
  const codeDir = await codeProjectOf(dir, body.codeDir);
  const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : undefined;
  const model = modelOf(body.model);
  const folder = typeof body.folder === "string" && body.folder.trim() ? body.folder.trim() : undefined;
  await startLinking({ dataDir: dir, codeDir, ...(folder ? { folder } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) });
  return json(await status(dir), 202);
};

const getDraft = (dir: string): Handler => async () => json(await status(dir));

const postDraftCancel = (dir: string): Handler => async () => {
  await cancelExtraction(dir);
  return json(await status(dir));
};

const postDraftRetry = (dir: string): Handler => async (req) => {
  const body = await bodyOf(req);
  await retryExtraction(dir, typeof body.folder === "string" && body.folder ? body.folder : undefined);
  return json(await status(dir), 202);
};

const deleteDraft = (dir: string): Handler => async () => {
  await dismissExtraction(dir);
  return json(await status(dir));
};

// GET /api/extract/github: the accounts the open folder could be published under.
// A folder that names no code project is still its own to publish: the account signed in is offered.
const getGithub = (dir: string): Handler => async () => json(await repoOwners(await codeProjectOf(dir).catch(() => dir)));

/** What src/server/api.ts lends: its refusal for a hosted worker, and its way to the open specification folder. */
export interface RouteWrappers {
  unlessHosted: (handler: Handler) => Handler;
  withDataDir: (handler: (dir: string, req: Request, params: Params) => Response | Promise<Response>) => Handler;
}

/** The extraction routes, for the route table. */
export function extractRoutes(wrap: RouteWrappers): Route[] {
  const open = (handler: Handler) => wrap.unlessHosted(guarded(handler));
  /** A route on the specification folder that is open. */
  const onFolder = (make: (dir: string) => Handler) =>
    wrap.unlessHosted(wrap.withDataDir((dir, req, params) => guarded(make(dir))(req, params)));
  return [
    ["POST", "/api/extract/analyse", open(postAnalyse)],
    ["POST", "/api/extract/refine", open(postRefine)],
    ["GET", "/api/extract/refine/:id", open(getRefine)],
    ["DELETE", "/api/extract/refine/:id", open(deleteRefine)],
    ["POST", "/api/extract/repo", open(postRepo)],
    ["POST", "/api/extract/prompt", open(postPrompt)],
    ["POST", "/api/extract/publish", onFolder(postPublish)],
    ["GET", "/api/extract/github", onFolder(getGithub)],
    ["POST", "/api/extract/draft/cancel", onFolder(postDraftCancel)],
    ["POST", "/api/extract/draft/retry", onFolder(postDraftRetry)],
    ["POST", "/api/extract/draft", onFolder(postDraft)],
    ["GET", "/api/extract/draft", onFolder(getDraft)],
    ["DELETE", "/api/extract/draft", onFolder(deleteDraft)],
    ["GET", "/api/extract/tests", onFolder(getTests)],
    ["POST", "/api/extract/tests", onFolder(postTests)],
  ];
}
