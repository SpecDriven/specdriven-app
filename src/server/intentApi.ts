// The routes behind "extract specs from a code project"
// (specs/app/extract-specs-from-code.feature.md). They are their own
// module, handed to the route table by src/server/api.ts, which passes in
// the wrappers only it has. The flow, as the dialog drives it:
//
//   POST /api/extract/analyse   the folders proposed for a code project
//   POST /api/extract/refine    have an agent regroup the proposal; GET and DELETE on its id
//   POST /api/extract/repo      make its specification folder, with the chosen folders —
//                               or add them to one that already exists
//   POST /api/extract/publish   give the open folder its repository on GitHub, later
//   POST /api/extract/draft     start drafting specs for the chosen folders
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
} from "./intentExtraction";
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
  const proposal = analyseModules(await scanProject(codeDir));
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
  });
};

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

// POST /api/extract/draft { folders, codeDir?, specsDir?, agent?, model? }: start drafting.
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
  await startExtraction({ dataDir: dir, codeDir, folders, ...(agent ? { agent } : {}), ...(model ? { model } : {}) });
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
    ["POST", "/api/extract/publish", onFolder(postPublish)],
    ["GET", "/api/extract/github", onFolder(getGithub)],
    ["POST", "/api/extract/draft/cancel", onFolder(postDraftCancel)],
    ["POST", "/api/extract/draft/retry", onFolder(postDraftRetry)],
    ["POST", "/api/extract/draft", onFolder(postDraft)],
    ["GET", "/api/extract/draft", onFolder(getDraft)],
    ["DELETE", "/api/extract/draft", onFolder(deleteDraft)],
  ];
}
