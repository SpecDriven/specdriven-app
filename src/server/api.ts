// Runtime-agnostic HTTP API (specs/desktop-app.spec.md): one route table
// serves both Bun.serve in web mode and the app:// protocol handler in the
// desktop app, so handlers speak only the standard Request/Response types.

import {
  readState,
  writeState,
  needsDataRepo,
  normalizeScenarioPreviewLines,
  normalizeShowTestLinks,
} from "./state";
import type { SpecDrivenState } from "./state";
import { dataRepoDir, resolveDataRepo } from "./repo";
import { isRepoRoot } from "./git";
import {
  discoverScheme,
  ghCliAvailable,
  normalizeGitScheme,
  setGitScheme,
} from "./scheme";
import type { GitScheme } from "./scheme";
import { getCurrentUser } from "./user";
import { getAppRoot } from "./paths";
import {
  listFeatures,
  listFolders,
  readFeature,
  createFeature,
  createFolder,
  deleteFolder,
  deleteFeature,
  moveFeature,
  renameFeature,
  renameFeatureFile,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
} from "./features";
import type { ScenarioTarget } from "./features";
import { parseFeature } from "./parser";
import {
  createReloadScheduler,
  normalizeReloadSeconds,
  reloadData,
} from "./reload";

// Cron data reload (specs/crud-feature.spec.md): git pull every n seconds,
// where n comes from the Settings dialog and is stored in the settings file.
export const reloader = createReloadScheduler(async () => {
  try {
    console.log(`[reload] ${await reloadData(getAppRoot())}`);
  } catch (e) {
    console.error(`[reload] ${(e as Error).message}`);
  }
});

/** Apply the persisted settings a server run starts from. */
export async function applyStartupState(): Promise<void> {
  const state = await readState(getAppRoot());
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  // Git scheme (specs/git-operations.spec.md): apply the chosen scheme to
  // every git command; unset means auto-discover by probing on first use.
  setGitScheme(normalizeGitScheme(state.gitScheme));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Git-scheme fields for /api/state (specs/git-operations.spec.md): the
 * scheme chosen in Settings (null = auto-discover), plus the scheme
 * auto-discovery found by probing the existing clone. A GET never clones —
 * without a local clone the detected scheme is simply unknown.
 */
async function gitSchemeFields(state: SpecDrivenState) {
  const gitScheme = normalizeGitScheme(state.gitScheme);
  let detected: GitScheme | null = null;
  if (!gitScheme && !needsDataRepo(state)) {
    const dir = dataRepoDir(state.dataRepo!, getAppRoot());
    if (await isRepoRoot(dir)) detected = await discoverScheme(dir);
  }
  return { gitScheme, gitSchemeDetected: detected };
}

type Params = Record<string, string>;
type Handler = (req: Request, params: Params) => Response | Promise<Response>;

/**
 * Resolve the configured data repo (local path or GitHub url, cloned on first
 * use) and hand its local directory to the handler.
 */
function withDataDir(
  handler: (dir: string, req: Request, params: Params) => Response | Promise<Response>,
): Handler {
  return async (req, params) => {
    const state = await readState(getAppRoot());
    if (needsDataRepo(state)) return json({ error: "data repo not configured" }, 409);
    let dir: string;
    try {
      dir = await resolveDataRepo(state.dataRepo!, getAppRoot());
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
    return handler(dir, req, params);
  };
}

async function stateFields(state: SpecDrivenState) {
  return {
    dataRepo: state.dataRepo ?? null,
    needsDataRepo: needsDataRepo(state),
    reloadFrequencySeconds: normalizeReloadSeconds(state.reloadFrequencySeconds),
    scenarioPreviewLines: normalizeScenarioPreviewLines(state.scenarioPreviewLines),
    showTestLinks: normalizeShowTestLinks(state.showTestLinks),
    ...(await gitSchemeFields(state)),
  };
}

// App start (specs/app-start.spec.md): the client asks for state; if no
// data repo is recorded, it prompts the user for one. The repo may be a
// regular GitHub url (https://github.com/SpecDriven/data-insurance).
const getState: Handler = async () => {
  const state = await readState(getAppRoot());
  return json({
    ...(await stateFields(state)),
    // specs/user-info-settings.spec.md: the OS user by default, with
    // the git identity that authors data-repo commits.
    user: await getCurrentUser(),
  });
};

const putState: Handler = async (req) => {
  const body = (await req.json()) as {
    dataRepo?: string;
    reloadFrequencySeconds?: number;
    scenarioPreviewLines?: number;
    gitScheme?: string | null;
    showTestLinks?: boolean;
  };
  if (
    body.dataRepo === undefined &&
    body.reloadFrequencySeconds === undefined &&
    body.scenarioPreviewLines === undefined &&
    body.gitScheme === undefined &&
    body.showTestLinks === undefined
  ) {
    return json(
      {
        error:
          "dataRepo, reloadFrequencySeconds, scenarioPreviewLines, gitScheme or showTestLinks is required",
      },
      400,
    );
  }
  const state = await readState(getAppRoot());
  // Git scheme (specs/git-operations.spec.md): https, ssh or gh;
  // "auto" clears the choice so the scheme is re-discovered by
  // probing. Applied before a dataRepo change so a first clone
  // already follows the new scheme.
  if (body.gitScheme !== undefined) {
    const scheme = normalizeGitScheme(body.gitScheme);
    if (scheme === null && body.gitScheme !== "auto" && body.gitScheme !== null) {
      return json({ error: "gitScheme must be https, ssh, gh or auto" }, 400);
    }
    if (scheme === "gh" && !ghCliAvailable()) {
      return json({ error: "the gh scheme needs the GitHub CLI (gh) installed" }, 400);
    }
    if (scheme) state.gitScheme = scheme;
    else delete state.gitScheme;
    setGitScheme(scheme);
  }
  if (body.dataRepo !== undefined) {
    const dataRepo = body.dataRepo.trim();
    if (!dataRepo) return json({ error: "dataRepo is required" }, 400);
    // Verify access before recording: a GitHub url is cloned on first use
    // (specs/crud-feature.spec.md: "user is verified to have access to the
    // data GH repo").
    try {
      await resolveDataRepo(dataRepo, getAppRoot());
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    state.dataRepo = dataRepo;
  }
  if (body.reloadFrequencySeconds !== undefined) {
    const n = body.reloadFrequencySeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return json({ error: "reloadFrequencySeconds must be a number >= 0" }, 400);
    }
    state.reloadFrequencySeconds = Math.floor(n);
  }
  // Scenario-list preview length (specs/ui.spec.md "Scenario List").
  if (body.scenarioPreviewLines !== undefined) {
    const n = body.scenarioPreviewLines;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
      return json({ error: "scenarioPreviewLines must be a number >= 1" }, 400);
    }
    state.scenarioPreviewLines = Math.floor(n);
  }
  // Test-links display (specs/traceability.spec.md): optional, default
  // ON — the default is stored as an absent key.
  if (body.showTestLinks !== undefined) {
    if (typeof body.showTestLinks !== "boolean") {
      return json({ error: "showTestLinks must be a boolean" }, 400);
    }
    if (body.showTestLinks) delete state.showTestLinks;
    else state.showTestLinks = false;
  }
  await writeState(state, getAppRoot());
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  return json(await stateFields(state));
};

// Sync button (specs/ui.spec.md "Main page"): immediate data reload —
// one reload tick on demand, same as the cron (pull + push saved).
const postReload: Handler = async () => {
  try {
    const message = await reloadData(getAppRoot());
    console.log(`[reload] ${message}`);
    return json({ message });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
};

const getFeatures = withDataDir(async (dir) =>
  json({ features: await listFeatures(dir), folders: await listFolders(dir) }),
);

const postFeatures = withDataDir(async (dir, req) => {
  const body = (await req.json()) as { name?: string };
  try {
    const fileName = await createFeature(dir, body.name ?? "");
    return json({ fileName }, 201);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

const getFeature = withDataDir(async (dir, _req, params) => {
  // A name readFeature refuses — a legacy `<slug>.feature` still held by
  // an open tab, or a traversal attempt — is "not found", not a 500.
  let content: string | null;
  try {
    content = await readFeature(dir, params.file!);
  } catch {
    return json({ error: "not found" }, 404);
  }
  if (content === null) return json({ error: "not found" }, 404);
  return json({ fileName: params.file!, content, parsed: parseFeature(content) });
});

const putFeature = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as {
    content?: string;
    resolveConflict?: boolean;
    save?: boolean;
    // Individual scenario publish (specs/crud-feature.spec.md "publish
    // each scenario individually"); absent = publish all scenarios.
    scenario?: { name?: string; version?: number };
  };
  if (typeof body.content !== "string") return json({ error: "content is required" }, 400);
  let scenario: ScenarioTarget | undefined;
  if (body.scenario !== undefined) {
    if (typeof body.scenario?.name !== "string" || typeof body.scenario.version !== "number") {
      return json({ error: "scenario needs a name and a version" }, 400);
    }
    scenario = { name: body.scenario.name, version: body.scenario.version };
  }
  try {
    // save: auto-save locally with [proposed] markers; the reload cron
    // commits and pushes (specs/crud-feature.spec.md).
    if (body.save) return json(await saveFeature(dir, params.file!, body.content));
    const result = body.resolveConflict
      ? await resolveFeatureConflict(dir, params.file!, body.content, scenario)
      : await publishFeature(dir, params.file!, body.content, scenario);
    return json(result, result.status === "conflict" ? 409 : 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui.spec.md "Feature entry menu": Delete removes the feature
// file — a `git rm`, committed and pushed. The client confirms first.
const deleteFeatureRoute = withDataDir(async (dir, _req, params) => {
  try {
    return json(await deleteFeature(dir, params.file!));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Folders (specs/folders.spec.md): directories in the data repo that
// hold feature files. Creation is local (git doesn't track empty dirs);
// deletion only removes empty folders.
const postFolders = withDataDir(async (dir, req) => {
  const body = (await req.json()) as { path?: string };
  try {
    return json({ path: await createFolder(dir, body.path ?? "") }, 201);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

const deleteFolderRoute = withDataDir(async (dir, _req, params) => {
  try {
    await deleteFolder(dir, params.path!);
    return json({ message: "folder deleted" });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Drag-move between folders (specs/folders.spec.md): a `git mv` into
// the target directory, committed and pushed like a rename.
const postMove = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { folder?: string };
  try {
    return json(await moveFeature(dir, params.file!, body.folder ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui.spec.md "Feature entry menu" (File → Rename): renames the
// underlying file — a `git mv`, committed and pushed. Only the stem is
// taken; the `.feature.md` extension and the folder are kept.
const postRenameFile = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { stem?: string };
  try {
    return json(await renameFeatureFile(dir, params.file!, body.stem ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui.spec.md "Main page": the Edit link edits the feature name (the
// file's `# <name>` heading), committed and pushed; the file name — and so
// every link to the feature — never changes here.
const postRename = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { name?: string };
  try {
    return json(await renameFeature(dir, params.file!, body.name ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

/** Pattern segments starting with `:` bind the (decoded) path segment. */
const routes: [method: string, pattern: string, handler: Handler][] = [
  ["GET", "/api/state", getState],
  ["PUT", "/api/state", putState],
  ["POST", "/api/reload", postReload],
  ["GET", "/api/features", getFeatures],
  ["POST", "/api/features", postFeatures],
  ["GET", "/api/features/:file", getFeature],
  ["PUT", "/api/features/:file", putFeature],
  ["DELETE", "/api/features/:file", deleteFeatureRoute],
  ["POST", "/api/folders", postFolders],
  ["DELETE", "/api/folders/:path", deleteFolderRoute],
  ["POST", "/api/features/:file/move", postMove],
  ["POST", "/api/features/:file/rename-file", postRenameFile],
  ["POST", "/api/features/:file/rename", postRename],
];

export interface ApiMatch {
  handler: Handler;
  params: Params;
}

/**
 * Match a request line against the route table. Segments are matched before
 * decoding, so an encoded `/` in a parameter (`billing%2Fq.feature.md`)
 * stays one segment — the params come out decoded.
 */
export function matchApi(method: string, pathname: string): ApiMatch | null {
  const segments = pathname.split("/");
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const want = pattern.split("/");
    if (want.length !== segments.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const got = segments[i]!;
      if (w.startsWith(":")) {
        try {
          params[w.slice(1)] = decodeURIComponent(got);
        } catch {
          ok = false; // malformed percent-encoding
          break;
        }
      } else if (w !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

/** Serve an API request, or null when the path is not an API route. */
export async function handleApi(req: Request): Promise<Response | null> {
  const match = matchApi(req.method, new URL(req.url).pathname);
  return match ? match.handler(req, match.params) : null;
}
