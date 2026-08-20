// Runtime-agnostic HTTP API (specs/desktop-app.spec.md): one route table
// serves both Bun.serve in web mode and the app:// protocol handler in the
// desktop app, so handlers speak only the standard Request/Response types.

import {
  readState,
  writeState,
  needsDataRepo,
  normalizeAutosaveSeconds,
  normalizeCodeGen,
  normalizeScenarioPreviewLines,
  normalizeShowTestLinks,
  normalizeSyncServerUrl,
  MIN_AUTOSAVE_SECONDS,
} from "./state";
import type { SpecDrivenState } from "./state";
import { resolveDataRepo } from "./repo";
import { canChooseFolder, chooseFolder } from "./folderChooser";
import {
  cliGitAvailable,
  currentEngine,
  ghAccount,
  ghAvailable,
  ghSignedIn,
  jsGitAvailable,
  normalizeGitEngine,
  setGitEngine,
} from "./git";
import {
  getAuth,
  handleWebCallback,
  pollDeviceFlow,
  pollWebFlow,
  signOut,
  startDeviceFlow,
  startWebFlow,
} from "./auth";
import { getCurrentUser } from "./user";
import { getAppRoot } from "./paths";
import {
  listFeatures,
  listFolders,
  readFeatureForEditor,
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
import { claudeAvailable, runCodeGenSession } from "./agent";
import type { SpecInput } from "./agent";
import { imageMime, readImage, storeImage, MAX_IMAGE_BYTES } from "./images";
import { extractScenarios, parseFeature } from "./parser";
import type { ScenarioPick } from "./parser";
import { searchSpecs } from "./search";
import {
  createReloadScheduler,
  normalizeReloadSeconds,
  reloadData,
  syncDataDir,
} from "./reload";
import { startNetSyncClient } from "./automerge/netsync";
import type { NetSync } from "./automerge/netsync";
import { errorAttributes, getLogger } from "./telemetry";

const reloadLog = getLogger("reload");
const netsyncLog = getLogger("netsync");

/** One sync tick (pull + push saved), logged; a failed tick never throws. */
async function syncTick(run: () => Promise<string>): Promise<void> {
  try {
    reloadLog.info(await run());
  } catch (e) {
    reloadLog.error((e as Error).message, errorAttributes(e));
  }
}

// Cron data reload (specs/crud-feature.spec.md): git pull every n seconds,
// where n comes from the Settings dialog and is stored in the settings file.
export const reloader = createReloadScheduler(() => syncTick(() => reloadData(getAppRoot())));

// App start (specs/app-start.spec.md "the data repo is pulled on start"): one
// sync tick before the app is read, so it opens on the latest data instead of
// on whatever the last run left behind. Startup itself does not wait on the
// network — reads of the data repo wait on this handle instead.
let startupSync: Promise<void> = Promise.resolve();

/** How long a data read waits for the app-start pull before serving anyway. */
export const STARTUP_SYNC_WAIT_MS = 15_000;

function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Wait for the app-start sync, so the first screen shows pulled data. A pull
 * that hangs — an unreachable remote, a remote asking for credentials — must
 * not wedge the app, so the wait is bounded: past it the read is served from
 * what is on disk, and the pull finishes into the next reload tick.
 */
export function syncedOnStart(): Promise<void> {
  return Promise.race([startupSync, after(STARTUP_SYNC_WAIT_MS)]);
}

// Optional websocket document sync (specs/automerge-store.spec.md): a bridge
// between the data repo's chunk store and the sync server named in Settings,
// running only while one is named. Off by default — git is the transport.
let netSync: NetSync | null = null;
/** What the running bridge was started with, to skip no-op re-applies. */
let netSyncKey: string | null = null;
/** Start/stop must not interleave; applies queue behind one another. */
let netSyncTurn: Promise<void> = Promise.resolve();

export function applyNetSync(state: SpecDrivenState): Promise<void> {
  netSyncTurn = netSyncTurn.then(async () => {
    const url = normalizeSyncServerUrl(state.syncServerUrl);
    let dir: string | null = null;
    if (url && !needsDataRepo(state)) {
      try {
        dir = await resolveDataRepo(state.dataRepo!, getAppRoot());
      } catch {
        // No reachable data repo means no bridge — the next apply retries.
      }
    }
    const key = url && dir ? `${url}\n${dir}` : null;
    if (key === netSyncKey) return;
    const old = netSync;
    netSync = null;
    netSyncKey = null;
    if (old) {
      try {
        await old.stop();
      } catch (e) {
        // A bridge that fails to stop cleanly is abandoned, not kept.
        netsyncLog.warn("bridge did not stop cleanly; abandoning it", errorAttributes(e));
      }
    }
    if (!url || !dir) return;
    try {
      netSync = await startNetSyncClient(dir, url);
      netSyncKey = key;
      netsyncLog.info(`syncing with ${url}`);
    } catch (e) {
      netsyncLog.error((e as Error).message, errorAttributes(e));
    }
  });
  return netSyncTurn;
}

/** Apply the persisted settings a server run starts from. */
export async function applyStartupState(): Promise<void> {
  const state = await readState(getAppRoot());
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  // Git engine (specs/git-operations.spec.md): the GitHub CLI when this
  // machine has one, or whichever engine Settings names — decided before the
  // sync below, which is the first thing to use it.
  setGitEngine(normalizeGitEngine(state.gitEngine));
  // specs/app-start.spec.md: pull the data repo on start. Not awaited here —
  // reads wait for it through syncedOnStart(); everything else starts now.
  startupSync = syncTick(() => reloadData(getAppRoot()));
  // Not awaited: resolving the data repo may clone it, and startup must not
  // wait on the network for an optional accelerator.
  void applyNetSync(state);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Git-engine fields for /api/state (specs/git-operations.spec.md): the
 * engine chosen in Settings (null = default), the engine actually in
 * effect, and which binaries exist — each engine is only offered when its
 * own is installed, which for the bundled one is always.
 */
function gitEngineFields(state: SpecDrivenState) {
  return {
    gitEngine: normalizeGitEngine(state.gitEngine),
    gitEngineEffective: currentEngine(),
    cliGitAvailable: cliGitAvailable(),
    ghAvailable: ghAvailable(),
    jsGitAvailable: jsGitAvailable(),
  };
}

/**
 * GitHub accounts for /api/state; never includes a token. `auth` is the
 * app's own device-flow sign-in, `gh` what the GitHub CLI reports — the
 * Settings dialog shows both, since either can be the one that authenticates.
 */
async function authFields() {
  const auth = await getAuth();
  const gh = ghAvailable() ? await ghAccount() : null;
  return {
    auth: auth
      ? { signedIn: true, login: auth.login, name: auth.name, email: auth.email }
      : { signedIn: false as const },
    gh: {
      available: ghAvailable(),
      signedIn: ghAvailable() ? await ghSignedIn() : false,
      login: gh?.login ?? null,
    },
  };
}

type Params = Record<string, string>;
type Handler = (req: Request, params: Params) => Response | Promise<Response>;

/**
 * Resolve the configured data repo (local path or GitHub url, cloned on first
 * use) and hand its local directory to the handler. Nothing reads the repo
 * before the app-start pull has had its turn (specs/app-start.spec.md).
 */
function withDataDir(
  handler: (dir: string, req: Request, params: Params) => Response | Promise<Response>,
): Handler {
  return async (req, params) => {
    await syncedOnStart();
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
    autosaveIntervalSeconds: normalizeAutosaveSeconds(state.autosaveIntervalSeconds),
    showTestLinks: normalizeShowTestLinks(state.showTestLinks),
    codeGen: normalizeCodeGen(state.codeGen),
    syncServerUrl: state.syncServerUrl ?? null,
    // Whether the runtime can open a native folder chooser
    // (specs/app-start.spec.md) — gates the Browse… buttons.
    canChooseFolder: canChooseFolder(),
    ...gitEngineFields(state),
    ...(await authFields()),
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
    autosaveIntervalSeconds?: number;
    gitEngine?: string | null;
    showTestLinks?: boolean;
    codeGen?: boolean;
    syncServerUrl?: string | null;
  };
  if (
    body.dataRepo === undefined &&
    body.reloadFrequencySeconds === undefined &&
    body.scenarioPreviewLines === undefined &&
    body.autosaveIntervalSeconds === undefined &&
    body.gitEngine === undefined &&
    body.showTestLinks === undefined &&
    body.codeGen === undefined &&
    body.syncServerUrl === undefined
  ) {
    return json(
      {
        error:
          "dataRepo, reloadFrequencySeconds, scenarioPreviewLines, autosaveIntervalSeconds, gitEngine, showTestLinks, codeGen or syncServerUrl is required",
      },
      400,
    );
  }
  const state = await readState(getAppRoot());
  // Git engine (specs/git-operations.spec.md): "gh" (GitHub CLI), "cli"
  // (system git) or "js" (the bundled engine, which needs nothing installed);
  // "auto" clears the choice back to the default. Applied before a dataRepo
  // change so a first clone already uses the new engine.
  if (body.gitEngine !== undefined) {
    const engine = normalizeGitEngine(body.gitEngine);
    if (engine === null && body.gitEngine !== "auto" && body.gitEngine !== null) {
      return json({ error: "gitEngine must be cli, gh, js or auto" }, 400);
    }
    if (engine === "cli" && !cliGitAvailable()) {
      return json({ error: "the system git engine needs git installed" }, 400);
    }
    if (engine === "gh" && !ghAvailable()) {
      return json({ error: "the GitHub CLI engine needs gh installed" }, 400);
    }
    if (engine) state.gitEngine = engine;
    else delete state.gitEngine;
    setGitEngine(engine);
  }
  // The directory a newly picked data repo resolves to; null when this
  // request leaves the data repo alone.
  let pickedDir: string | null = null;
  if (body.dataRepo !== undefined) {
    const dataRepo = body.dataRepo.trim();
    if (!dataRepo) return json({ error: "dataRepo is required" }, 400);
    // Verify access before recording: a GitHub url is cloned on first use
    // (specs/crud-feature.spec.md: "user is verified to have access to the
    // data GH repo").
    try {
      pickedDir = await resolveDataRepo(dataRepo, getAppRoot());
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
  // Editor autosave (specs/editor-autosave.feature.md): how often the open
  // editor saves itself. Autosave cannot be switched off here — only slowed
  // down — and never below the 3 second floor.
  if (body.autosaveIntervalSeconds !== undefined) {
    const n = body.autosaveIntervalSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < MIN_AUTOSAVE_SECONDS) {
      return json(
        { error: `autosaveIntervalSeconds must be a number >= ${MIN_AUTOSAVE_SECONDS}` },
        400,
      );
    }
    state.autosaveIntervalSeconds = Math.floor(n);
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
  // Code gen sessions (specs/agents/claude.spec.md): switched off here, the
  // app offers no way to run one — the default ON is an absent key.
  if (body.codeGen !== undefined) {
    if (typeof body.codeGen !== "boolean") {
      return json({ error: "codeGen must be a boolean" }, 400);
    }
    if (body.codeGen) delete state.codeGen;
    else state.codeGen = false;
  }
  // Websocket document sync (specs/automerge-store.spec.md): opt-in, empty
  // or null turns it off — the default, stored as an absent key.
  if (body.syncServerUrl !== undefined) {
    if (body.syncServerUrl !== null && typeof body.syncServerUrl !== "string") {
      return json({ error: "syncServerUrl must be a string or null" }, 400);
    }
    const url = (body.syncServerUrl ?? "").trim();
    if (url && normalizeSyncServerUrl(url) === null) {
      return json({ error: "syncServerUrl must be a ws:// or wss:// url" }, 400);
    }
    if (url) state.syncServerUrl = url;
    else delete state.syncServerUrl;
  }
  await writeState(state, getAppRoot());
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  // specs/app-start.spec.md "changing the data repo": a newly picked folder is
  // pulled before the response, so the client's first read of it — which
  // follows this response — already shows the latest data. A pull that fails
  // is logged and the switch still stands; the folder is configured either way.
  if (pickedDir) {
    const dir = pickedDir;
    await syncTick(() => syncDataDir(dir));
  }
  await applyNetSync(state);
  return json(await stateFields(state));
};

// Sync button (specs/ui.spec.md "Main page"): immediate data reload —
// one reload tick on demand, same as the cron (pull + push saved).
const postReload: Handler = async () => {
  try {
    const message = await reloadData(getAppRoot());
    reloadLog.info(message);
    return json({ message });
  } catch (e) {
    reloadLog.error((e as Error).message, errorAttributes(e));
    return json({ error: (e as Error).message }, 502);
  }
};

// GitHub sign-in (specs/git-operations.spec.md): device flow — start
// returns the code the user enters at github.com/login/device; the client
// polls until GitHub reports the authorization.
const postAuthStart: Handler = async () => {
  try {
    return json(await startDeviceFlow());
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
};

const postAuthPoll: Handler = async () => {
  try {
    return json(await pollDeviceFlow());
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
};

const deleteAuth: Handler = async () => {
  await signOut();
  return json({ message: "signed out" });
};

// Browser sign-in (specs/git-operations.spec.md "connect to GitHub via the
// browser"): start hands back the GitHub authorize url for the browser;
// GitHub redirects to the callback below; the Settings dialog polls until
// the outcome arrives. Needs an http(s) origin for GitHub to redirect to —
// the desktop app's app:// pages use the device flow instead.
const postAuthWebStart: Handler = async (req) => {
  const origin = new URL(req.url).origin;
  if (!/^https?:\/\//.test(origin)) {
    return json(
      { error: "Browser sign-in needs the web app — sign in with a device code instead" },
      400,
    );
  }
  try {
    return json(startWebFlow(origin));
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
};

const postAuthWebPoll: Handler = async () => json(pollWebFlow());

/** Minimal page for the browser tab GitHub redirects back to. */
function callbackPage(ok: boolean, message: string): Response {
  const esc = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>SpecDriven — GitHub sign-in</title>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size: 1.25rem;">${ok ? "Connected to GitHub" : "GitHub sign-in did not finish"}</h1>
<p>${esc}</p>
<p>You can close this tab and return to SpecDriven.</p>
</body>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const getAuthWebCallback: Handler = async (req) => {
  const result = await handleWebCallback(new URL(req.url).searchParams);
  return callbackPage(result.ok, result.message);
};

const getFeatures = withDataDir(async (dir) =>
  json({ features: await listFeatures(dir), folders: await listFolders(dir) }),
);

// Full-text search (specs/search.spec.md): ranked hits over feature
// names/descriptions and scenario names/bodies, each with a snippet
// around its first match. An empty query is no results, not an error.
const getSearch = withDataDir(async (dir, req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 50) : 20;
  return json({ query: q, results: await searchSpecs(dir, q, limit) });
});

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
  // The editor view: file content plus the document's draft scenarios,
  // which are never in the file (specs/automerge-store.spec.md).
  let content: string | null;
  try {
    content = await readFeatureForEditor(dir, params.file!);
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

// Image upload (specs/images.spec.md): the editor posts a pasted or chosen
// file as multipart form data; the image lands in the data repo's `.images/`
// folder, committed and pushed, and the response carries the url the
// markdown `![...](...)` should reference.
const postImage = withDataDir(async (dir, req) => {
  let file: File;
  try {
    const form = await req.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) throw new Error("no file");
    file = entry;
  } catch {
    return json({ error: "multipart form data with a 'file' field is required" }, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return json({ error: `Image is too large (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB)` }, 413);
  }
  try {
    const name = await storeImage(dir, file.name, new Uint8Array(await file.arrayBuffer()));
    return json({ name, path: `/api/images/${encodeURIComponent(name)}` }, 201);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Stored images referenced from scenario bodies. Names are content-addressed,
// so a hit never changes: cache forever. The CSP header keeps an uploaded
// svg inert if the url is opened directly rather than via <img>.
const getImage = withDataDir(async (dir, _req, params) => {
  const bytes = await readImage(dir, params.name!);
  if (bytes === null) return json({ error: "not found" }, 404);
  return new Response(bytes, {
    headers: {
      "content-type": imageMime(params.name!),
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
});

// One selected spec in a session request: the whole file when `scenarios`
// is absent, otherwise just the named scenarios of it.
interface SessionFile {
  fileName: string;
  scenarios?: ScenarioPick[];
}

/** The request's `files`, validated into shape — or null when malformed. */
function parseSessionFiles(value: unknown): SessionFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: SessionFile[] = [];
  for (const entry of value) {
    const { fileName, scenarios } = (entry ?? {}) as { fileName?: unknown; scenarios?: unknown };
    if (typeof fileName !== "string") return null;
    if (scenarios === undefined) {
      files.push({ fileName });
      continue;
    }
    if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
    const picks: ScenarioPick[] = [];
    for (const s of scenarios) {
      const { name, version } = (s ?? {}) as { name?: unknown; version?: unknown };
      if (typeof name !== "string" || !Number.isInteger(version) || (version as number) < 1) {
        return null;
      }
      picks.push({ name, version: version as number });
    }
    files.push({ fileName, scenarios: picks });
  }
  return files;
}

// Code gen session (specs/agents/claude.spec.md): the client sends the
// session name and the selected specs — whole files or per-file scenario
// subsets; we build one prompt from them and pass it to the Claude CLI to
// execute and exit. A non-zero exit comes back as an error for the client's
// error box.
const postAgentSession = withDataDir(async (dir, req) => {
  // The Settings switch is the gate, enforced here and not only in the UI:
  // switched off, nothing can hand a spec to the CLI.
  if (!normalizeCodeGen((await readState(getAppRoot())).codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  const body = (await req.json()) as { name?: string; files?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "name is required" }, 400);
  const files = parseSessionFiles(body.files);
  if (files === null) {
    return json({ error: "files must name at least one spec or scenario" }, 400);
  }
  const specs: SpecInput[] = [];
  for (const { fileName, scenarios } of files) {
    // The editor view, so a draft scenario the user picked in the UI is
    // there for extractScenarios to find.
    let content: string | null;
    try {
      content = await readFeatureForEditor(dir, fileName);
    } catch {
      content = null;
    }
    if (content === null) return json({ error: `spec not found: ${fileName}` }, 400);
    if (scenarios) {
      try {
        content = extractScenarios(content, scenarios);
      } catch (e) {
        return json({ error: `${fileName}: ${(e as Error).message}` }, 400);
      }
    }
    specs.push({ fileName, content, partial: scenarios !== undefined });
  }
  if (!claudeAvailable()) {
    return json({ error: "Claude CLI not found — install the `claude` command" }, 502);
  }
  try {
    return json(await runCodeGenSession(dir, name, specs));
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});

// Native folder chooser (specs/app-start.spec.md "picking the data directory
// with the native folder chooser"): opens the OS dialog on the machine the
// app runs on. 501 on runtimes with no native chooser — the client hides
// Browse… then (canChooseFolder in /api/state).
const postChooseFolder: Handler = async () => {
  if (!canChooseFolder()) {
    return json({ error: "no native folder chooser on this runtime" }, 501);
  }
  return json({ path: await chooseFolder() });
};

/** Pattern segments starting with `:` bind the (decoded) path segment. */
const routes: [method: string, pattern: string, handler: Handler][] = [
  ["GET", "/api/state", getState],
  ["PUT", "/api/state", putState],
  ["POST", "/api/choose-folder", postChooseFolder],
  ["POST", "/api/reload", postReload],
  ["POST", "/api/auth/github/start", postAuthStart],
  ["POST", "/api/auth/github/poll", postAuthPoll],
  ["POST", "/api/auth/github/web/start", postAuthWebStart],
  ["POST", "/api/auth/github/web/poll", postAuthWebPoll],
  ["GET", "/api/auth/github/callback", getAuthWebCallback],
  ["DELETE", "/api/auth/github", deleteAuth],
  ["GET", "/api/features", getFeatures],
  ["POST", "/api/features", postFeatures],
  ["POST", "/api/images", postImage],
  ["GET", "/api/images/:name", getImage],
  ["GET", "/api/search", getSearch],
  ["GET", "/api/features/:file", getFeature],
  ["PUT", "/api/features/:file", putFeature],
  ["DELETE", "/api/features/:file", deleteFeatureRoute],
  ["POST", "/api/folders", postFolders],
  ["DELETE", "/api/folders/:path", deleteFolderRoute],
  ["POST", "/api/features/:file/move", postMove],
  ["POST", "/api/features/:file/rename-file", postRenameFile],
  ["POST", "/api/features/:file/rename", postRename],
  ["POST", "/api/agent/session", postAgentSession],
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
