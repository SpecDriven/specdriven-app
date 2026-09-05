// Runtime-agnostic HTTP API (specs/desktop-app.spec.md): one route table
// serves both Bun.serve in web mode and the app:// protocol handler in the
// desktop app, so handlers speak only the standard Request/Response types.

import {
  readState,
  writeState,
  needsDataRepo,
  normalizeAssignments,
  normalizeAutosaveSeconds,
  normalizeCodeGen,
  normalizeCodeGenTarget,
  CODE_GEN_TARGET_LIST,
  DEFAULT_PROJECT_MANAGEMENT_TOOL,
  normalizeDeletePublished,
  normalizeProjectManagement,
  normalizeProjectManagementTool,
  normalizePublishExternalLinks,
  normalizeRoadmap,
  normalizeScenarioPreviewLines,
  normalizeShowTestLinks,
  normalizeSyncServerUrl,
  recentDataRepos,
  rememberDataRepo,
  MIN_AUTOSAVE_SECONDS,
} from "./state";
import type { SpecDrivenState } from "./state";
import { resolveDataRepo } from "./repo";
import { isDemoMode, reseedDemo } from "./demo";
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
  readFeatureView,
  createFeature,
  createFolder,
  deleteFolder,
  deleteDraftScenario,
  deleteFeature,
  deletePublishedScenario,
  moveFeature,
  renameFeature,
  renameFeatureFile,
  reprojectFeatures,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
} from "./features";
import type { FeatureView, ScenarioTarget } from "./features";
import {
  buildSessionPrompt,
  claudeAvailable,
  claudeDesktopAvailable,
  launchDesktopSession,
  piAvailable,
  runCodeGenSession,
  sessionsDirectory,
} from "./agent";
import type { SessionPlace, SpecInput } from "./agent";
import {
  ChatError,
  answerPermission,
  createChatSession,
  endChatSession,
  getChatCommands,
  getChatEvents,
  getChatSession,
  interruptChat,
  isFinalStatus,
  listChatSessions,
  normalizeChatAgent,
  normalizePermissionMode,
  CHAT_AGENTS,
  PERMISSION_MODES,
  sendChatMessage,
  setChatPermissionMode,
  subscribeChat,
} from "./agentChat";
import type { ChatAgent, ChatEvent, PermissionAnswer } from "./agentChat";
import { directoryExists } from "./fsx";
import { imageMime, readImage, storeImage, MAX_IMAGE_BYTES } from "./images";
import { PROJECT_SETTINGS_FILE, readProjectSettings } from "./members";
import { extractScenarios } from "./parser";
import type { ScenarioPick } from "./parser";
import { searchSpecs } from "./search";
import { readReadme, writeReadme } from "./readme";
import {
  createRoadmapPage,
  deleteRoadmapPage,
  ensureRoadmapFolder,
  isRoadmapPath,
  listRoadmap,
  readRoadmapPage,
  saveRoadmapPage,
} from "./roadmap";
import {
  createReloadScheduler,
  normalizeReloadSeconds,
  reloadData,
  syncDataDir,
} from "./reload";
import { startNetSyncClient } from "./automerge/netsync";
import { setProjectionOptions } from "./automerge/project";
import type { NetSync } from "./automerge/netsync";
import { errorAttributes, getLogger } from "./telemetry";
import { version as appVersion } from "../../package.json";

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
  // External links go into the markdown projections only while the setting
  // says so (specs/external-links/project-management-jira-linear-etc.
  // feature.md) — decided before the first sync tick writes a projection.
  setProjectionOptions({
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
  });
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
    projectManagement: normalizeProjectManagement(state.projectManagement),
    projectManagementTool: normalizeProjectManagementTool(state.projectManagementTool),
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
    codeGen: normalizeCodeGen(state.codeGen),
    // Where "Start session" runs (specs/agents/claude.feature.md): the
    // remembered choice, or null for "desktop when it is there, else cli".
    codeGenTarget: normalizeCodeGenTarget(state.codeGenTarget),
    // Whether Claude.app is installed here, so a session can open in Claude
    // Code Desktop — gates the "Run in" choice of the session dialog.
    canOpenClaudeDesktop: claudeDesktopAvailable(),
    // Whether the Claude CLI is on PATH, so a session can run in the app's
    // own coding agent pane (specs/agents/coding-agent-ui.feature.md).
    canRunAgentPane: claudeAvailable(),
    // Whether the Pi CLI is on PATH, so a session can run in Pi
    // (specs/agents/integration-with-pi-dev-agent.feature.md) — gates the
    // Pi entry of the session dialog's agent choice.
    canRunPi: piAvailable(),
    deletePublished: normalizeDeletePublished(state.deletePublished),
    assignments: normalizeAssignments(state.assignments),
    roadmap: normalizeRoadmap(state.roadmap),
    syncServerUrl: state.syncServerUrl ?? null,
    // Recent folder list (specs/ui/ui.feature.md "Recent folder list"):
    // most recent first, the current folder included, at most 10.
    recentDataRepos: recentDataRepos(state),
    // Whether the runtime can open a native folder chooser
    // (specs/app-start.spec.md) — gates the Browse… buttons.
    canChooseFolder: canChooseFolder(),
    // Demo mode: the client hides everything that changes or syncs the data
    // directory — the dataset is ephemeral and resets on every page load.
    demo: isDemoMode(),
    // The running app's version (package.json). The demo shows it beside the
    // user name, so a public demo says which build is on screen.
    version: appVersion,
    ...gitEngineFields(state),
    ...(await authFields()),
  };
}

// App start (specs/app-start.spec.md): the client asks for state; if no
// data repo is recorded, it prompts the user for one. The repo may be a
// regular GitHub url (https://github.com/SpecDriven/data-insurance).
const getState: Handler = async (req) => {
  // Demo mode: the client's one boot-time state fetch carries ?boot=1, and a
  // page load is the demo's reset point — reseed the pristine dataset before
  // answering, so a browser refresh always opens on the default data.
  if (isDemoMode() && new URL(req.url).searchParams.has("boot")) {
    await reseedDemo();
  }
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
    projectManagement?: boolean;
    projectManagementTool?: string;
    publishExternalLinks?: boolean;
    codeGen?: boolean;
    codeGenTarget?: string;
    deletePublished?: boolean;
    assignments?: boolean;
    roadmap?: boolean;
    syncServerUrl?: string | null;
  };
  if (
    body.dataRepo === undefined &&
    body.reloadFrequencySeconds === undefined &&
    body.scenarioPreviewLines === undefined &&
    body.autosaveIntervalSeconds === undefined &&
    body.gitEngine === undefined &&
    body.showTestLinks === undefined &&
    body.projectManagement === undefined &&
    body.projectManagementTool === undefined &&
    body.publishExternalLinks === undefined &&
    body.codeGen === undefined &&
    body.codeGenTarget === undefined &&
    body.deletePublished === undefined &&
    body.assignments === undefined &&
    body.roadmap === undefined &&
    body.syncServerUrl === undefined
  ) {
    return json(
      {
        error:
          "dataRepo, reloadFrequencySeconds, scenarioPreviewLines, autosaveIntervalSeconds, gitEngine, showTestLinks, projectManagement, projectManagementTool, publishExternalLinks, codeGen, codeGenTarget, deletePublished, assignments, roadmap or syncServerUrl is required",
      },
      400,
    );
  }
  // Demo mode: the ephemeral dataset is the only one on offer — the data
  // directory, git engine and sync server are pinned (same server-side 403
  // pattern as postDeletePublished / postAgentSession).
  if (
    isDemoMode() &&
    (body.dataRepo !== undefined ||
      body.gitEngine !== undefined ||
      body.syncServerUrl !== undefined)
  ) {
    return json({ error: "changing the data directory is disabled in demo mode" }, 403);
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
    // Recent folder list (specs/ui/ui.feature.md): the picked folder moves
    // to the front, the oldest past ten falls off.
    rememberDataRepo(state, dataRepo);
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
  // Project management (specs/external-links/project-management-jira-linear-
  // etc.feature.md): whether tickets are tracked at all, and which tool they
  // live in. Both defaults — ON, and Jira — are stored as an absent key.
  if (body.projectManagement !== undefined) {
    if (typeof body.projectManagement !== "boolean") {
      return json({ error: "projectManagement must be a boolean" }, 400);
    }
    if (body.projectManagement) delete state.projectManagement;
    else state.projectManagement = false;
  }
  if (body.projectManagementTool !== undefined) {
    if (typeof body.projectManagementTool !== "string") {
      return json({ error: "projectManagementTool must be a string" }, 400);
    }
    const tool = body.projectManagementTool.trim();
    // The name becomes the `<program>` of `[Jira:ABC-123](url)`, so it must
    // survive that form — the same rule the link fields enforce.
    if (!tool || /[:[\]]/.test(tool)) {
      return json(
        { error: "projectManagementTool must be a name without ':' or brackets" },
        400,
      );
    }
    if (tool === DEFAULT_PROJECT_MANAGEMENT_TOOL) delete state.projectManagementTool;
    else state.projectManagementTool = tool;
  }
  // External links in the markdown (specs/external-links/project-management-
  // jira-linear-etc.feature.md): optional, default ON — stored as an absent
  // key. Flipping it rewrites every feature file to the new form below.
  let linksChanged = false;
  if (body.publishExternalLinks !== undefined) {
    if (typeof body.publishExternalLinks !== "boolean") {
      return json({ error: "publishExternalLinks must be a boolean" }, 400);
    }
    linksChanged =
      body.publishExternalLinks !== normalizePublishExternalLinks(state.publishExternalLinks);
    if (body.publishExternalLinks) delete state.publishExternalLinks;
    else state.publishExternalLinks = false;
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
  // Session target (specs/agents/claude.feature.md): the last "Run in"
  // choice of the session dialog, so the next dialog opens on it.
  if (body.codeGenTarget !== undefined) {
    const target = normalizeCodeGenTarget(body.codeGenTarget);
    if (target === null) {
      return json({ error: `codeGenTarget must be ${CODE_GEN_TARGET_LIST}` }, 400);
    }
    state.codeGenTarget = target;
  }
  // Published-scenario deletion (specs/editor/spec-editor.feature.md "Delete
  // Published Spec"): opt-in — the default OFF is an absent key.
  if (body.deletePublished !== undefined) {
    if (typeof body.deletePublished !== "boolean") {
      return json({ error: "deletePublished must be a boolean" }, 400);
    }
    if (body.deletePublished) state.deletePublished = true;
    else delete state.deletePublished;
  }
  // Feature assignment (src/server/members.ts): opt-in — the default OFF is
  // an absent key. Off only takes the dropdown away; nothing already
  // assigned is rewritten.
  if (body.assignments !== undefined) {
    if (typeof body.assignments !== "boolean") {
      return json({ error: "assignments must be a boolean" }, 400);
    }
    if (body.assignments) state.assignments = true;
    else delete state.assignments;
  }
  // The roadmap folder (specs/app/roadmap.feature.md): opt-in — the default
  // OFF is an absent key. Turning it on creates the folder below, once the
  // settings are written.
  let roadmapTurnedOn = false;
  if (body.roadmap !== undefined) {
    if (typeof body.roadmap !== "boolean") {
      return json({ error: "roadmap must be a boolean" }, 400);
    }
    roadmapTurnedOn = body.roadmap && !normalizeRoadmap(state.roadmap);
    if (body.roadmap) state.roadmap = true;
    else delete state.roadmap;
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
  setProjectionOptions({
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
  });
  // Scenario "Create roadmap folder if necessary": the switch is what asks
  // for the folder, so it is made on the spot rather than on the next tick.
  // A repo we cannot reach is left to that tick; the switch still stands.
  if (roadmapTurnedOn && !needsDataRepo(state)) {
    try {
      const dir = pickedDir ?? (await resolveDataRepo(state.dataRepo!, getAppRoot()));
      if (await ensureRoadmapFolder(dir)) reloadLog.info("created the roadmap folder");
    } catch (e) {
      reloadLog.error((e as Error).message, errorAttributes(e));
    }
  }
  if (linksChanged && !needsDataRepo(state)) {
    // The switch takes effect on every `.feature.md` at once; the reload
    // cron commits and pushes the rewritten files like any saved change.
    try {
      const dir = pickedDir ?? (await resolveDataRepo(state.dataRepo!, getAppRoot()));
      const changed = await reprojectFeatures(dir);
      reloadLog.info(
        `external links ${state.publishExternalLinks === false ? "withheld from" : "written into"} ${changed} feature file(s)`,
      );
    } catch (e) {
      reloadLog.error((e as Error).message, errorAttributes(e));
    }
  }
  // specs/app-start.spec.md "changing the data repo": a newly picked folder is
  // pulled before the response, so the client's first read of it — which
  // follows this response — already shows the latest data. A pull that fails
  // is logged and the switch still stands; the folder is configured either way.
  if (pickedDir) {
    const dir = pickedDir;
    await syncTick(() => syncDataDir(dir, { roadmap: normalizeRoadmap(state.roadmap) }));
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

// The listing carries the project's settings along with it (src/server/
// members.ts): the members the "Assigned" dropdown offers, and the code repo
// a session runs in. They come from the data repo, so they change when the
// folder does and refresh on every reload tick — the same rhythm as the
// feature list itself.
const getFeatures = withDataDir(async (dir) => {
  const settings = await readProjectSettings(dir);
  return json({
    features: await listFeatures(dir),
    // The roadmap folder is not a feature folder (specs/app/roadmap.feature
    // .md): it holds markdown pages, listed on their own above the tree, so
    // it never shows as an empty folder among the feature ones.
    folders: (await listFolders(dir)).filter((folder) => !isRoadmapPath(folder)),
    members: settings.members,
    codeRepo: settings.codeRepo,
  });
});

// Roadmap pages (specs/app/roadmap.feature.md): the markdown files in the
// data repo's `roadmap` folder, listed with the member each is assigned to.
const getRoadmap = withDataDir(async (dir) => json({ pages: await listRoadmap(dir) }));

const postRoadmap = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (typeof body?.name !== "string") return json({ error: "name is required" }, 400);
  try {
    return json({ fileName: await createRoadmapPage(dir, body.name) }, 201);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

const getRoadmapPage = withDataDir(async (dir, _req, params) => {
  try {
    const page = await readRoadmapPage(dir, params.file ?? "");
    return page === null ? json({ error: "Roadmap page not found" }, 404) : json(page);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// The roadmap editor's autosave: a local write through the page's document —
// the reload cron commits and pushes it, like a saved scenario.
const putRoadmapPage = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  if (typeof body?.content !== "string") return json({ error: "content is required" }, 400);
  try {
    return json(await saveRoadmapPage(dir, params.file ?? "", body.content));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Deleting a page (specs/app/roadmap.feature.md): the markdown and its
// document go, committed and pushed like a deleted feature.
const deleteRoadmapPageRoute = withDataDir(async (dir, _req, params) => {
  try {
    return json(await deleteRoadmapPage(dir, params.file ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Full-text search (specs/search.spec.md): ranked hits over feature
// names/descriptions and scenario names/bodies, each with a snippet
// around its first match. An empty query is no results, not an error.
// The data repo's README (specs/app-startup.feature.md "App Starts with
// existing specs folder selected"): the home view opens it in an editor.
const getReadme = withDataDir(async (dir) => json(await readReadme(dir)));

// The README editor's autosave: a plain local write — the reload cron commits
// and pushes it, like a saved scenario (specs/editor-autosave.feature.md
// "Autosave Saves Locally").
const putReadme = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  if (typeof body?.content !== "string") return json({ error: "content is required" }, 400);
  try {
    return json(await writeReadme(dir, body.content));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

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
  // which are never in the file (specs/automerge-store.spec.md), and the
  // parsed form carrying each scenario's document id — the identity the
  // editor hands back when it saves.
  let view: FeatureView | null;
  try {
    view = await readFeatureView(dir, params.file!);
  } catch {
    return json({ error: "not found" }, 404);
  }
  if (view === null) return json({ error: "not found" }, 404);
  return json({ fileName: params.file!, ...view });
});

/** A scenario as a request body names it: name + version, and the document
    id the editor read it under when it has one (Scenario.id). */
type ScenarioBody = { name?: unknown; version?: unknown; id?: unknown } | null | undefined;

/** The scenario a body names, or null when the name or version is missing. */
function scenarioTarget(body: ScenarioBody): ScenarioTarget | null {
  if (typeof body?.name !== "string" || typeof body.version !== "number") return null;
  const target: ScenarioTarget = { name: body.name, version: body.version };
  if (typeof body.id === "string") target.id = body.id;
  return target;
}

const putFeature = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as {
    content?: string;
    resolveConflict?: boolean;
    save?: boolean;
    // The scenario this request is about. On a publish: the one scenario to
    // publish (specs/crud-feature.spec.md "publish each scenario
    // individually"), absent = publish all. On a save: the dialog's scenario.
    // Its document id, when the editor holds one, keeps a scenario saved
    // under a new name or version one scenario rather than two
    // (specs/editor-autosave.feature.md "Autosave Never Adds the Same
    // Scenario Twice").
    scenario?: ScenarioBody;
  };
  if (typeof body.content !== "string") return json({ error: "content is required" }, 400);
  let scenario: ScenarioTarget | undefined;
  if (body.scenario !== undefined) {
    const target = scenarioTarget(body.scenario);
    if (!target) return json({ error: "scenario needs a name and a version" }, 400);
    scenario = target;
  }
  try {
    // save: auto-save locally with [proposed] markers; the reload cron
    // commits and pushes (specs/crud-feature.spec.md).
    if (body.save) return json(await saveFeature(dir, params.file!, body.content, scenario));
    const result = body.resolveConflict
      ? await resolveFeatureConflict(dir, params.file!, body.content, scenario)
      : await publishFeature(dir, params.file!, body.content, scenario);
    return json(result, result.status === "conflict" ? 409 : 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui.spec.md "Scenario editor" (Delete on a draft): a draft lives
// in the Automerge document only, so it is deleted from the document rather
// than by saving the feature without it — a save cannot express the absence
// of something the markdown never held. Proposed scenarios keep going through
// the ordinary save. POST, not DELETE, because the target rides in a body:
// a scenario is identified by name and version, and a name is free text.
const postDeleteDraft = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { scenario?: { name?: string; version?: number } };
  if (typeof body.scenario?.name !== "string" || typeof body.scenario.version !== "number") {
    return json({ error: "scenario needs a name and a version" }, 400);
  }
  const target: ScenarioTarget = { name: body.scenario.name, version: body.scenario.version };
  try {
    return json(await deleteDraftScenario(dir, params.file!, target));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/editor/spec-editor.feature.md "Delete Published Spec": deleting a
// published scenario is allowed only while the Settings switch is on —
// enforced here and not only in the UI, so nothing can remove published
// content while the switch is off. The client shows the Danger Zone
// confirmation first; the removal is committed and pushed right away.
const postDeletePublished = withDataDir(async (dir, req, params) => {
  if (!normalizeDeletePublished((await readState(getAppRoot())).deletePublished)) {
    return json({ error: "Deleting published scenarios is switched off in Settings" }, 403);
  }
  const body = (await req.json()) as { scenario?: { name?: string; version?: number } };
  if (typeof body.scenario?.name !== "string" || typeof body.scenario.version !== "number") {
    return json({ error: "scenario needs a name and a version" }, 400);
  }
  const target: ScenarioTarget = { name: body.scenario.name, version: body.scenario.version };
  try {
    return json(await deletePublishedScenario(dir, params.file!, target));
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

const CLI_MISSING = "Claude CLI not found — install the `claude` command";
const PI_MISSING = "Pi CLI not found — install the `pi` command (https://pi.dev)";

// Code gen session (specs/agents/claude.spec.md): the client sends the
// session name, the selected specs — whole files or per-file scenario
// subsets — and where to run; we build one prompt from them and either pass
// it to the Claude CLI to execute and exit, or open it in Claude Code
// Desktop. A failure comes back as an error for the client's error box.
const postAgentSession = withDataDir(async (dir, req) => {
  // The Settings switch is the gate, enforced here and not only in the UI:
  // switched off, nothing can hand a spec to Claude.
  if (!normalizeCodeGen((await readState(getAppRoot())).codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  const body = (await req.json()) as { name?: string; files?: unknown; target?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "name is required" }, 400);
  // An absent target is the original CLI session, unchanged.
  const target = body.target === undefined ? "cli" : normalizeCodeGenTarget(body.target);
  if (target === null) return json({ error: `target must be ${CODE_GEN_TARGET_LIST}` }, 400);
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
  // Where the session runs (src/server/members.ts `code-repo`): the code
  // repo the data repo's project-settings.json names, else the data repo.
  // A code repo that isn't there is the user's to fix — the setting is
  // checked in, so the message names the folder it resolved to.
  const { codeRepo } = await readProjectSettings(dir);
  if (codeRepo !== null && !(await directoryExists(codeRepo))) {
    return json(
      { error: `Code repo not found: ${codeRepo} (code-repo in ${PROJECT_SETTINGS_FILE})` },
      400,
    );
  }
  const place: SessionPlace = codeRepo ? { dataRepo: dir, codeRepo } : { dataRepo: dir };
  // The pane (specs/agents/coding-agent-ui.feature.md): the prompt opens a
  // live chat in the app; the client shows it and the conversation goes on.
  // "pane" is that chat with Claude, "pi" the same chat with Pi
  // (specs/agents/integration-with-pi-dev-agent.feature.md).
  if (target === "pane" || target === "pi") {
    const agent = target === "pi" ? "pi" : "claude";
    if (agent === "pi" && !piAvailable()) return json({ error: PI_MISSING }, 502);
    if (agent === "claude" && !claudeAvailable()) return json({ error: CLI_MISSING }, 502);
    try {
      const meta = await createChatSession({
        place,
        name,
        agent,
        prompt: buildSessionPrompt(name, specs, place),
        sessionsDir: await sessionsDirectory(getAppRoot()),
      });
      return json({ name, id: meta.id, target });
    } catch (e) {
      return chatError(e);
    }
  }
  if (target === "desktop") {
    if (!claudeDesktopAvailable()) {
      return json({ error: "Claude Code Desktop not found — install Claude.app" }, 502);
    }
    try {
      const sessionsDir = await sessionsDirectory(getAppRoot());
      return json(await launchDesktopSession(place, name, specs, { sessionsDir }));
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }
  if (!claudeAvailable()) return json({ error: CLI_MISSING }, 502);
  try {
    return json(await runCodeGenSession(place, name, specs));
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Coding agent pane (specs/agents/coding-agent-ui.feature.md): a live Claude
// Code chat the app drives itself (src/server/agentChat.ts). Creating one
// needs the data repo — for the code repo its project-settings.json names —
// so it goes through withDataDir; everything after that addresses a session
// by id. Events reach the client over a one-way NDJSON stream, the only kind
// of push that works over both Bun.serve and Electron's app:// protocol.

/** Where a pane session runs, or the refusal: switched off, no CLI, no repo. */
async function agentPanePlace(dir: string, agent: ChatAgent): Promise<SessionPlace | Response> {
  if (!normalizeCodeGen((await readState(getAppRoot())).codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  if (agent === "pi" && !piAvailable()) return json({ error: PI_MISSING }, 502);
  if (agent === "claude" && !claudeAvailable()) return json({ error: CLI_MISSING }, 502);
  const { codeRepo } = await readProjectSettings(dir);
  if (codeRepo !== null && !(await directoryExists(codeRepo))) {
    return json(
      { error: `Code repo not found: ${codeRepo} (code-repo in ${PROJECT_SETTINGS_FILE})` },
      400,
    );
  }
  return codeRepo ? { dataRepo: dir, codeRepo } : { dataRepo: dir };
}

/** A ChatError carries its status; anything else is a 500 with its words. */
function chatError(e: unknown): Response {
  if (e instanceof ChatError) return json({ error: e.message }, e.status);
  return json({ error: (e as Error).message }, 500);
}

const postAgentChat = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    prompt?: unknown;
    permissionMode?: unknown;
    agent?: unknown;
  };
  // Which agent drives the chat; absent is Claude, as it was before Pi.
  const agent = body.agent === undefined ? "claude" : normalizeChatAgent(body.agent);
  if (agent === null) return json({ error: `agent must be ${CHAT_AGENTS.join(" or ")}` }, 400);
  const place = await agentPanePlace(dir, agent);
  if (place instanceof Response) return place;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Coding agent session";
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : undefined;
  let permissionMode: ReturnType<typeof normalizePermissionMode> = null;
  if (body.permissionMode !== undefined) {
    permissionMode = normalizePermissionMode(body.permissionMode);
    if (permissionMode === null) return json({ error: MODE_ERROR }, 400);
  }
  try {
    const meta = await createChatSession({
      place,
      name,
      agent,
      ...(prompt ? { prompt } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      sessionsDir: await sessionsDirectory(getAppRoot()),
    });
    return json(meta);
  } catch (e) {
    return chatError(e);
  }
});

const MODE_ERROR = `permissionMode must be one of ${PERMISSION_MODES.join(", ")}`;

const getAgentChats: Handler = () => json({ sessions: listChatSessions() });

const getAgentChat: Handler = (_req, params) => {
  const meta = getChatSession(params.id!);
  if (!meta) return json({ error: "coding agent session not found" }, 404);
  return json({ meta, commands: getChatCommands(meta.id), events: getChatEvents(meta.id) });
};

/** Blank lines keep the connection under Bun.serve's idle timeout. */
const HEARTBEAT_MS = 20_000;

// The event stream: the backlog after `after`, then live events, one JSON
// object per line, until the session reaches a final status. A client that
// lost the stream reopens it with the last sequence it saw.
const getAgentChatEvents: Handler = (req, params) => {
  const id = params.id!;
  if (!getChatSession(id)) return json({ error: "coding agent session not found" }, 404);
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0") || 0;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        stop();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const send = (event: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          close();
          return;
        }
        if (event.kind === "status" && isFinalStatus(event.status)) close();
      };
      for (const event of getChatEvents(id, after)) send(event);
      const meta = getChatSession(id);
      if (!open || !meta || isFinalStatus(meta.status)) {
        close();
        return;
      }
      unsubscribe = subscribeChat(id, send);
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          close();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
};

const postAgentChatMessage: Handler = async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== "string") return json({ error: "text is required" }, 400);
  try {
    return json({ event: sendChatMessage(params.id!, body.text) });
  } catch (e) {
    return chatError(e);
  }
};

const postAgentChatPermission: Handler = async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as Partial<PermissionAnswer> & {
    updatedInput?: unknown;
  };
  if (typeof body.requestId !== "string") return json({ error: "requestId is required" }, 400);
  if (body.behavior !== "allow" && body.behavior !== "deny") {
    return json({ error: "behavior must be allow or deny" }, 400);
  }
  const updatedInput =
    body.updatedInput && typeof body.updatedInput === "object" && !Array.isArray(body.updatedInput)
      ? (body.updatedInput as Record<string, unknown>)
      : undefined;
  try {
    answerPermission(params.id!, {
      requestId: body.requestId,
      behavior: body.behavior,
      ...(typeof body.message === "string" ? { message: body.message } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      remember: body.remember === true,
    });
    return json({ ok: true });
  } catch (e) {
    return chatError(e);
  }
};

const postAgentChatInterrupt: Handler = async (_req, params) => {
  try {
    await interruptChat(params.id!);
    return json({ ok: true });
  } catch (e) {
    return chatError(e);
  }
};

const putAgentChatMode: Handler = async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as { permissionMode?: unknown };
  const mode = normalizePermissionMode(body.permissionMode);
  if (mode === null) return json({ error: MODE_ERROR }, 400);
  try {
    await setChatPermissionMode(params.id!, mode);
    return json({ meta: getChatSession(params.id!) });
  } catch (e) {
    return chatError(e);
  }
};

const deleteAgentChat: Handler = async (_req, params) => {
  try {
    await endChatSession(params.id!);
    return json({ ok: true });
  } catch (e) {
    return chatError(e);
  }
};

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

/** 403 in demo mode — routes whose whole point is talking to GitHub. */
const unlessDemo =
  (handler: Handler): Handler =>
  (req, params) =>
    isDemoMode()
      ? json({ error: "GitHub sign-in is disabled in demo mode" }, 403)
      : handler(req, params);

/** Pattern segments starting with `:` bind the (decoded) path segment. */
const routes: [method: string, pattern: string, handler: Handler][] = [
  ["GET", "/api/state", getState],
  ["PUT", "/api/state", putState],
  ["POST", "/api/choose-folder", postChooseFolder],
  ["POST", "/api/reload", postReload],
  ["POST", "/api/auth/github/start", unlessDemo(postAuthStart)],
  ["POST", "/api/auth/github/poll", unlessDemo(postAuthPoll)],
  ["POST", "/api/auth/github/web/start", unlessDemo(postAuthWebStart)],
  ["POST", "/api/auth/github/web/poll", unlessDemo(postAuthWebPoll)],
  ["GET", "/api/auth/github/callback", unlessDemo(getAuthWebCallback)],
  ["DELETE", "/api/auth/github", unlessDemo(deleteAuth)],
  ["GET", "/api/features", getFeatures],
  ["POST", "/api/features", postFeatures],
  ["POST", "/api/images", postImage],
  ["GET", "/api/images/:name", getImage],
  ["GET", "/api/search", getSearch],
  ["GET", "/api/readme", getReadme],
  ["PUT", "/api/readme", putReadme],
  ["GET", "/api/roadmap", getRoadmap],
  ["POST", "/api/roadmap", postRoadmap],
  ["GET", "/api/roadmap/:file", getRoadmapPage],
  ["PUT", "/api/roadmap/:file", putRoadmapPage],
  ["DELETE", "/api/roadmap/:file", deleteRoadmapPageRoute],
  ["GET", "/api/features/:file", getFeature],
  ["PUT", "/api/features/:file", putFeature],
  ["DELETE", "/api/features/:file", deleteFeatureRoute],
  ["POST", "/api/folders", postFolders],
  ["DELETE", "/api/folders/:path", deleteFolderRoute],
  ["POST", "/api/features/:file/move", postMove],
  ["POST", "/api/features/:file/rename-file", postRenameFile],
  ["POST", "/api/features/:file/rename", postRename],
  ["POST", "/api/features/:file/delete-draft", postDeleteDraft],
  ["POST", "/api/features/:file/delete-published", postDeletePublished],
  ["POST", "/api/agent/session", postAgentSession],
  ["POST", "/api/agent/chat", postAgentChat],
  ["GET", "/api/agent/chat", getAgentChats],
  ["GET", "/api/agent/chat/:id", getAgentChat],
  ["GET", "/api/agent/chat/:id/events", getAgentChatEvents],
  ["POST", "/api/agent/chat/:id/message", postAgentChatMessage],
  ["POST", "/api/agent/chat/:id/permission", postAgentChatPermission],
  ["POST", "/api/agent/chat/:id/interrupt", postAgentChatInterrupt],
  ["PUT", "/api/agent/chat/:id/mode", putAgentChatMode],
  ["DELETE", "/api/agent/chat/:id", deleteAgentChat],
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
