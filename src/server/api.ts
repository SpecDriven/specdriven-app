// Runtime-agnostic HTTP API (specs/app/desktop-app.feature.md): one route table
// serves both Bun.serve in web mode and the app:// protocol handler in the
// desktop app, so handlers speak only the standard Request/Response types.

import {
  readState,
  writeState,
  needsDataRepo,
  normalizeAgentFirstResponseSeconds,
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
  normalizeGoogleCalendar,
  normalizeScenarioPreviewLines,
  normalizeOpenTestsInIdea,
  normalizeShowTestLinks,
  normalizeSyncServerUrl,
  forgetDataRepo,
  normalizeDataRepo,
  recentDataRepos,
  rememberDataRepo,
  MIN_AUTOSAVE_SECONDS,
  DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
} from "./state";
import type { SpecDrivenState } from "./state";
import { ensureDataRepoFolder, MissingDataRepoError, parseGitHubUrl, resolveDataRepo } from "./repo";
import { isDemoMode, reseedDemo } from "./demo";
import { HOSTED_REFUSAL, isHostedMode } from "./hostedMode";
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
  moveScenario,
  moveFeature,
  renameFeature,
  renameFeatureFile,
  reprojectFeatures,
  saveFeature,
  savePullRequests,
  readScenarioFiles,
  saveScenarioFiles,
  publishFeature,
  resolveFeatureConflict,
} from "./features";
import type { FeatureView, ScenarioTarget } from "./features";
import {
  buildSessionPrompt,
  claudeAvailable,
  claudeDesktopAvailable,
  codexAvailable,
  launchDesktopSession,
  piAvailable,
  SESSION_TITLE_MAX,
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
import {
  FILES_DIR,
  MAX_FILE_BYTES,
  readScenarioFile,
  scenarioFileExists,
  storeScenarioFile,
} from "./scenarioFiles";
import { fileDisplayName, validScenarioFiles } from "./scenarioFileList";
import { PROJECT_SETTINGS_FILE, readProjectSettings, writeAuthorsInMarkdown } from "./members";
import { extractScenarios } from "./parser";
import type { ScenarioPick } from "./parser";
import { isSearchScope, searchPages, searchScope, searchSpecs } from "./search";
import { readReadme, writeReadme } from "./readme";
import type { SessionSection } from "./agent";
import { ROADMAP, TASKS, ensurePageFolder, pageFolderNamed, type PageFolder } from "./pages";
import { getPullRequest, readIssuesRepo } from "./issues";
import { addSpecsSubmodule, SubmoduleError } from "./submodule";
import { parseTestUrl, resolveTestName } from "./testName";
import { parsePullRequestUrl, validPullRequests } from "./pullRequests";
import type { PullRequestLookup } from "./pullRequests";
import { IDEA_SYMLINK_HINT, ideaAvailable, localTestFile, openInIdea } from "./idea";
import { fieldChoices, scanEntities } from "./entities";
import { cleanLine } from "./text";
import {
  createReloadScheduler,
  normalizeReloadSeconds,
  reloadData,
  syncDataDir,
} from "./reload";
import { startNetSyncClient } from "./automerge/netsync";
import { setProjectionOptions } from "./automerge/project";
import type { NetSync } from "./automerge/netsync";
import { errorAttributes, getLogger, setLogVerbosity } from "./telemetry";
import { getLogSettings, getLogs, putLogSettings, savedVerbosity } from "./logs";
import { version as appVersion } from "../../package.json";
import { sourceUrl } from "./sourceUrl";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { bodyOf, json, type Handler, type Params } from "./http";
import {
  pluginStates,
  provideDataAccess,
  routes as routeRegistry,
  sessionParts,
  sourcePaths,
  syncPlugins,
} from "../plugins/host/loader";
import { profileManifests } from "../plugins/builtin/manifests";
import { marketplaceEntries, marketplaceRef } from "../plugins/marketplace";
import { marketplaceRoutes } from "../plugins/host/marketplace";
import {
  PROFILE_KEY,
  legacyFields,
  migrateProfile,
  readProfile,
  sameProfile,
  startFolderLists,
  storedProfile,
  withPlugin,
  writeProfile,
} from "../plugins/profile";

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

// Cron data reload (crud-feature.md): git pull every n seconds,
// where n comes from the Settings dialog and is stored in the settings file.
export const reloader = createReloadScheduler(() => syncTick(() => reloadData(getAppRoot())));

// App start (specs/ui/app-start.feature.md "the data repo is pulled on start"):
// one sync tick before the app is read, so it opens on the latest data instead
// of on whatever the last run left behind. Startup itself does not wait on the
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

// Optional websocket document sync
// (specs/datastore/automerge-store.feature.md): a bridge between the data
// repo's chunk store and the sync server named in Settings, running only while
// one is named. Off by default — git is the transport.
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
  // Log verbosity saved from the Observability page, before anything below logs.
  setLogVerbosity(savedVerbosity(state));
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  // Git engine (git-operations.md): the GitHub CLI when this
  // machine has one, or whichever engine Settings names — decided before the
  // sync below, which is the first thing to use it.
  setGitEngine(normalizeGitEngine(state.gitEngine));
  // The profile (specs/app/plugins.feature.md "Each data folder keeps its
  // own plugins"): an older settings file — the per-module switches, or one
  // device-wide `plugins.enabled` — is read as that list once and copied to
  // every data folder the file knows, so each carries its own from here on.
  if (migrateProfile(state as Record<string, unknown>, profileManifests)) {
    await writeState(state, getAppRoot());
  }
  // The plugins the profile asks for, and the folders' (src/plugins/host/loader.ts).
  await syncHostPlugins(state);
  // External links go into the markdown projections only while the setting
  // says so (specs/external-links/project-management-jira-linear-etc.
  // feature.md) — decided before the first sync tick writes a projection.
  setProjectionOptions({
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
  });
  // specs/ui/app-start.feature.md: pull the data repo on start. Not awaited
  // here — reads wait for it through syncedOnStart(); everything else starts
  // now.
  startupSync = syncTick(() => reloadData(getAppRoot()));
  // Not awaited: resolving the data repo may clone it, and startup must not
  // wait on the network for an optional accelerator.
  void applyNetSync(state);
}


/**
 * Git-engine fields for /api/state (git-operations.md): the
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


/**
 * Resolve the configured data repo (local path or GitHub url, cloned on first
 * use) and hand its local directory to the handler. Nothing reads the repo
 * before the app-start pull has had its turn (specs/ui/app-start.feature.md).
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

/** The resolved data dir, or null while none is configured or reachable. */
async function currentDataDir(): Promise<string | null> {
  const state = await readState(getAppRoot());
  if (needsDataRepo(state)) return null;
  try {
    return await resolveDataRepo(state.dataRepo!, getAppRoot());
  } catch {
    return null;
  }
}

/**
 * The plugins the settings ask for (src/plugins/host/loader.ts): the
 * built-ins the profile lists and whatever the plugin folders hold, a
 * plugin found for the first time added to the profile and stored. The
 * demo's folders are its own home's alone — what it installed from the
 * marketplace at start (demo.ts installDemoPlugins); its dataset is
 * ephemeral, so the data folder's plugins are not read there, and neither
 * are the profile's explicit folders — its host is shared.
 */
async function syncHostPlugins(state: SpecDrivenState): Promise<void> {
  const raw = state as Record<string, unknown>;
  // A hosted worker shares its container with other users' workers, so it
  // runs the built-in plugins alone: a plugin folder is code (hostedMode.ts).
  return syncPlugins(raw, {
    sources: !isHostedMode(),
    paths: !isDemoMode(),
    dataDir: isDemoMode() ? null : await currentDataDir(),
    persist: (s) => writeState(s as SpecDrivenState, getAppRoot()),
    readState: async () => (await readState(getAppRoot())) as Record<string, unknown>,
  });
}

/** The profile's `plugins` section as stored, whatever keys it has. */
function profileSection(state: SpecDrivenState): Record<string, unknown> {
  const section = (state as Record<string, unknown>)[PROFILE_KEY];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

async function stateFields(state: SpecDrivenState) {
  return {
    dataRepo: state.dataRepo ?? null,
    needsDataRepo: needsDataRepo(state),
    reloadFrequencySeconds: normalizeReloadSeconds(state.reloadFrequencySeconds),
    scenarioPreviewLines: normalizeScenarioPreviewLines(state.scenarioPreviewLines),
    autosaveIntervalSeconds: normalizeAutosaveSeconds(state.autosaveIntervalSeconds),
    showTestLinks: normalizeShowTestLinks(state.showTestLinks),
    // Open test links in IntelliJ IDEA (specs/traceability.feature.md "Open
    // test in idea"), and whether `idea` is on PATH so that can work.
    openTestsInIdea: normalizeOpenTestsInIdea(state.openTestsInIdea),
    canOpenInIdea: !isHostedMode() && ideaAvailable(),
    projectManagement: normalizeProjectManagement(state.projectManagement),
    projectManagementTool: normalizeProjectManagementTool(state.projectManagementTool),
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
    codeGen: normalizeCodeGen(state.codeGen),
    // Where "Start session" runs (specs/agents/claude.feature.md): the
    // remembered choice, or null for "desktop when it is there, else cli".
    codeGenTarget: normalizeCodeGenTarget(state.codeGenTarget),
    // How long a Claude turn behind a proxy waits for the API's first
    // response in the pane (src/server/agentChat.ts); 0 is no limit.
    agentFirstResponseSeconds: normalizeAgentFirstResponseSeconds(state.agentFirstResponseSeconds),
    // Whether Claude.app is installed here, so a session can open in Claude
    // Code Desktop — gates the "Run in" choice of the session dialog.
    canOpenClaudeDesktop: !isHostedMode() && claudeDesktopAvailable(),
    // Whether the Claude CLI is on PATH, so a session can run in the app's
    // own coding agent pane (specs/agents/agent-pane.feature.md).
    canRunAgentPane: !isHostedMode() && claudeAvailable(),
    // Whether the Pi CLI is on PATH, so a session can run in Pi
    // (specs/agents/integration-with-pi-dev-agent.feature.md) — gates the
    // Pi entry of the session dialog's agent choice.
    canRunPi: !isHostedMode() && piAvailable(),
    // Whether the Codex CLI is on PATH, so a session can run in Codex
    // (src/server/codexChat.ts) — gates the Codex entry of the same choice.
    canRunCodex: !isHostedMode() && codexAvailable(),
    deletePublished: normalizeDeletePublished(state.deletePublished),
    assignments: normalizeAssignments(state.assignments),
    // The plugins (specs/app/plugins.feature.md): the profile's entries in
    // tab order, then the built-ins it leaves off — what Settings → Plugins
    // lists — with the per-module switches they replaced (`roadmap`,
    // `testing`, …) still reported for one release.
    plugins: pluginStates(),
    // The profile's explicit plugin folders (specs/app/plugins.feature.md "A
    // plugin loads from a local folder"), which Settings → Plugins lists.
    pluginSources: sourcePaths(profileSection(state)),
    // The marketplaces (specs/app/plugins.feature.md "The marketplace is a
    // git repository with an index"): the git urls Settings → Plugins lists.
    pluginMarketplaces: marketplaceEntries(profileSection(state)),
    ...legacyFields(readProfile(state as Record<string, unknown>, profileManifests).enabled, profileManifests),
    googleCalendar: normalizeGoogleCalendar(state.googleCalendar),
    syncServerUrl: state.syncServerUrl ?? null,
    // Recent folder list (specs/ui/ui.feature.md "Recent folder list"):
    // most recent first, the current folder included, at most 10.
    recentDataRepos: recentDataRepos(state),
    // Whether the runtime can open a native folder chooser
    // (specs/ui/app-start.feature.md) — gates the Browse… buttons.
    canChooseFolder: !isHostedMode() && canChooseFolder(),
    // Demo mode: the client hides everything that changes or syncs the data
    // directory — the dataset is ephemeral and resets on every page load.
    demo: isDemoMode(),
    // Hosted mode (src/server/hostedMode.ts): the client sends GitHub
    // sign-in to the gateway's account page and offers no local agents.
    hosted: isHostedMode(),
    // The running app's version (package.json). The demo shows it beside the
    // user name, so a public demo says which build is on screen.
    version: appVersion,
    // The running build's source (src/server/sourceUrl.ts): the AGPL asks a
    // network-served copy to offer it, so the user menu links to it.
    sourceUrl: sourceUrl(),
    ...gitEngineFields(state),
    ...(await authFields()),
  };
}

// App start (specs/ui/app-start.feature.md): the client asks for state; if no
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
  // A demo reseed above rewrote the switches; the plugins follow them, and a
  // plugin folder that appeared meanwhile is picked up.
  await syncHostPlugins(state);
  return json({
    ...(await stateFields(state)),
    // specs/user-info-settings.feature.md: the OS user by default, with
    // the git identity that authors data-repo commits.
    user: await getCurrentUser(),
  });
};

/**
 * What a hosted worker (src/server/hostedMode.ts) refuses to change in
 * Settings, or null when the request is fine there. The data repo must be a
 * GitHub url — a local path would reach into the shared container — and the
 * git engine, plugin folders and sync server are pinned for the same reason.
 */
function hostedStateRefusal(body: {
  dataRepo?: unknown;
  gitEngine?: unknown;
  plugins?: { sources?: unknown; trust?: unknown; marketplaces?: unknown };
  syncServerUrl?: unknown;
}): string | null {
  if (!isHostedMode()) return null;
  if (body.dataRepo !== undefined && (typeof body.dataRepo !== "string" || !parseGitHubUrl(body.dataRepo))) {
    return "The hosted app opens GitHub repositories only — enter a https://github.com/owner/repo url";
  }
  if (body.gitEngine === "gh") return "The GitHub CLI engine is not available in the hosted app";
  if (
    body.plugins &&
    typeof body.plugins === "object" &&
    (body.plugins.sources !== undefined ||
      body.plugins.trust !== undefined ||
      body.plugins.marketplaces !== undefined)
  ) {
    return "Plugin folders and marketplaces cannot be changed in the hosted app";
  }
  if (body.syncServerUrl !== undefined) return "The sync server cannot be changed in the hosted app";
  return null;
}

const putState: Handler = async (req) => {
  const body = (await req.json()) as {
    dataRepo?: string;
    /** Make the picked folder when it does not exist yet — the user agreed. */
    createDataRepo?: boolean;
    forgetDataRepo?: string;
    reloadFrequencySeconds?: number;
    scenarioPreviewLines?: number;
    autosaveIntervalSeconds?: number;
    gitEngine?: string | null;
    showTestLinks?: boolean;
    openTestsInIdea?: boolean;
    projectManagement?: boolean;
    projectManagementTool?: string;
    publishExternalLinks?: boolean;
    codeGen?: boolean;
    codeGenTarget?: string;
    agentFirstResponseSeconds?: number;
    deletePublished?: boolean;
    assignments?: boolean;
    /**
     * The profile: the enabled plugins, in tab order; the explicit plugin
     * folders; a data-repo plugin folder to trust from now on.
     */
    plugins?: { enabled?: unknown; sources?: unknown; trust?: unknown; marketplaces?: unknown };
    /** The per-module switches the profile replaced — aliases for one release. */
    roadmap?: boolean;
    notebook?: boolean;
    tasks?: boolean;
    models?: boolean;
    testing?: boolean;
    issues?: boolean;
    googleCalendar?: boolean;
    syncServerUrl?: string | null;
  };
  if (
    body.dataRepo === undefined &&
    body.forgetDataRepo === undefined &&
    body.reloadFrequencySeconds === undefined &&
    body.scenarioPreviewLines === undefined &&
    body.autosaveIntervalSeconds === undefined &&
    body.gitEngine === undefined &&
    body.showTestLinks === undefined &&
    body.openTestsInIdea === undefined &&
    body.projectManagement === undefined &&
    body.projectManagementTool === undefined &&
    body.publishExternalLinks === undefined &&
    body.codeGen === undefined &&
    body.codeGenTarget === undefined &&
    body.agentFirstResponseSeconds === undefined &&
    body.deletePublished === undefined &&
    body.assignments === undefined &&
    body.plugins === undefined &&
    body.roadmap === undefined &&
    body.notebook === undefined &&
    body.tasks === undefined &&
    body.models === undefined &&
    body.testing === undefined &&
    body.googleCalendar === undefined &&
    body.issues === undefined &&
    body.syncServerUrl === undefined
  ) {
    return json(
      {
        error:
          "dataRepo, forgetDataRepo, reloadFrequencySeconds, scenarioPreviewLines, autosaveIntervalSeconds, gitEngine, showTestLinks, openTestsInIdea, projectManagement, projectManagementTool, publishExternalLinks, codeGen, codeGenTarget, agentFirstResponseSeconds, deletePublished, assignments, plugins, roadmap, tasks, notebook, models, testing, googleCalendar, issues or syncServerUrl is required",
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
      body.forgetDataRepo !== undefined ||
      body.gitEngine !== undefined ||
      body.syncServerUrl !== undefined)
  ) {
    return json({ error: "changing the data directory is disabled in demo mode" }, 403);
  }
  // The plugins' sources are pinned too: a visitor may switch and reorder
  // plugins, but a folder, a trust grant or a marketplace would have the
  // shared host build and run code a visitor chose.
  if (
    isDemoMode() &&
    body.plugins &&
    typeof body.plugins === "object" &&
    (body.plugins.sources !== undefined ||
      body.plugins.trust !== undefined ||
      body.plugins.marketplaces !== undefined)
  ) {
    return json({ error: "plugin folders and marketplaces cannot be changed in demo mode" }, 403);
  }
  const hostedRefusal = hostedStateRefusal(body);
  if (hostedRefusal) return json({ error: hostedRefusal }, 403);
  const state = await readState(getAppRoot());
  // Git engine (git-operations.md): "gh" (GitHub CLI), "cli"
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
    const dataRepo = normalizeDataRepo(body.dataRepo);
    if (!dataRepo) return json({ error: "dataRepo is required" }, 400);
    // Verify access before recording: a GitHub url is cloned on first use
    // (crud-feature.md: "user is verified to have access to the
    // data GH repo").
    try {
      pickedDir = await resolveDataRepo(dataRepo, getAppRoot());
      // A path that names no folder is refused rather than made — unless
      // the client asked first (specs/app/spec-folders.feature.md).
      await ensureDataRepoFolder(pickedDir, body.createDataRepo === true);
    } catch (e) {
      if (e instanceof MissingDataRepoError) {
        return json({ error: e.message, missing: true, path: e.dir }, 404);
      }
      return json({ error: (e as Error).message }, 400);
    }
    // An older file's device-wide plugin list goes to the folders it already
    // knows before the switch, so the picked folder, if new, starts with
    // Specs alone (specs/app/plugins.feature.md). The file then says it
    // keeps per-folder lists, so a restart never takes it for an older one.
    migrateProfile(state as Record<string, unknown>, profileManifests);
    state.dataRepo = dataRepo;
    startFolderLists(state as Record<string, unknown>);
    // Recent folder list (specs/ui/ui.feature.md): the picked folder moves
    // to the front, the oldest past ten falls off.
    rememberDataRepo(state, dataRepo);
  }
  // Manage specification folders (specs/app/spec-folders.feature.md): take
  // a folder off the list. Only the list entry goes — nothing on disk is
  // touched — and the folder that is open stays: switch away from it first.
  if (body.forgetDataRepo !== undefined) {
    if (typeof body.forgetDataRepo !== "string" || !body.forgetDataRepo.trim()) {
      return json({ error: "forgetDataRepo must be a folder path or url" }, 400);
    }
    const target = normalizeDataRepo(body.forgetDataRepo);
    if (target === (state.dataRepo && normalizeDataRepo(state.dataRepo))) {
      return json({ error: "the open folder cannot be removed — switch to another folder first" }, 409);
    }
    forgetDataRepo(state, target);
  }
  if (body.reloadFrequencySeconds !== undefined) {
    const n = body.reloadFrequencySeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return json({ error: "reloadFrequencySeconds must be a number >= 0" }, 400);
    }
    state.reloadFrequencySeconds = Math.floor(n);
  }
  // Scenario-list preview length (specs/ui/ui.feature.md "Scenario List").
  if (body.scenarioPreviewLines !== undefined) {
    const n = body.scenarioPreviewLines;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
      return json({ error: "scenarioPreviewLines must be a number >= 1" }, 400);
    }
    state.scenarioPreviewLines = Math.floor(n);
  }
  // Editor autosave (specs/editor/editor-autosave.feature.md): how often the
  // open editor saves itself. Autosave cannot be switched off here — only
  // slowed down — and never below the 3 second floor.
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
  // Test-links display (specs/traceability.feature.md): optional, default
  // ON — the default is stored as an absent key.
  if (body.showTestLinks !== undefined) {
    if (typeof body.showTestLinks !== "boolean") {
      return json({ error: "showTestLinks must be a boolean" }, 400);
    }
    if (body.showTestLinks) delete state.showTestLinks;
    else state.showTestLinks = false;
  }
  // Open test links in IntelliJ IDEA (specs/traceability.feature.md "Open
  // test in idea"): default OFF — the default is stored as an absent key.
  if (body.openTestsInIdea !== undefined) {
    if (typeof body.openTestsInIdea !== "boolean") {
      return json({ error: "openTestsInIdea must be a boolean" }, 400);
    }
    if (body.openTestsInIdea) state.openTestsInIdea = true;
    else delete state.openTestsInIdea;
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
    const tool = cleanLine(body.projectManagementTool);
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
  // Code gen sessions (specs/agents/claude.feature.md): switched off here, the
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
  // The pane's first-response wait for Claude behind a proxy
  // (specs/agents/agent-pane.feature.md "A Claude turn fails fast when the
  // API proxy does not answer"): whole seconds, 0 for no limit; the default
  // is stored as an absent key.
  if (body.agentFirstResponseSeconds !== undefined) {
    const n = body.agentFirstResponseSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return json({ error: "agentFirstResponseSeconds must be a number >= 0" }, 400);
    }
    if (Math.floor(n) === DEFAULT_AGENT_FIRST_RESPONSE_SECONDS) delete state.agentFirstResponseSeconds;
    else state.agentFirstResponseSeconds = Math.floor(n);
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
  // The profile (specs/app/plugins.feature.md "The profile lists enabled
  // plugins in tab order"): the open data folder's ordered list of enabled
  // plugins (a folder just picked above included), taken whole as
  // `plugins.enabled` — or edited one id at a time through the switches it
  // replaced (`roadmap`, `testing`, …), which stay as aliases for one
  // release: on appends the id, off removes it. Either way the folder carries
  // the list from here on and the legacy keys go. A request that leaves the
  // list as it was writes none, so a folder only opened keeps showing Specs
  // alone rather than a copy (specs/app/plugins.feature.md "Each data folder
  // keeps its own plugins").
  const raw = state as Record<string, unknown>;
  const before = readProfile(raw, profileManifests).enabled;
  let enabled = before;
  if (body.plugins !== undefined) {
    if (!body.plugins || typeof body.plugins !== "object") {
      return json({ error: "plugins must be an object" }, 400);
    }
    const { enabled: list, sources, trust, marketplaces } = body.plugins;
    if (list === undefined && sources === undefined && trust === undefined && marketplaces === undefined) {
      return json({ error: "plugins.enabled must be a list of plugin ids" }, 400);
    }
    if (list !== undefined) {
      if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && id.length > 0)) {
        return json({ error: "plugins.enabled must be a list of plugin ids" }, 400);
      }
      enabled = storedProfile({ plugins: { enabled: list } }) ?? [];
    }
    // The explicit plugin folders (specs/app/plugins.feature.md "A plugin
    // loads from a local folder"): absolute paths, taken whole.
    if (sources !== undefined) {
      // Trimmed only — a folder name may hold inner spaces.
      const paths = Array.isArray(sources) ? sources.map((p) => (typeof p === "string" ? p.trim() : p)) : null;
      if (!paths || !paths.every((p) => typeof p === "string" && isAbsolute(p))) {
        return json({ error: "plugins.sources must be a list of absolute folder paths" }, 400);
      }
      const section = profileSection(state);
      const unique = paths.filter((p, i) => paths.indexOf(p) === i);
      (state as Record<string, unknown>)[PROFILE_KEY] = { ...section, sources: unique.map((path) => ({ path })) };
    }
    // A plugin under the data repo is trusted once, by its folder, before
    // its first load — the repo is pulled from GitHub.
    if (trust !== undefined) {
      const folder = typeof trust === "string" ? trust.trim() : "";
      if (!isAbsolute(folder)) {
        return json({ error: "plugins.trust must be an absolute folder path" }, 400);
      }
      const section = profileSection(state);
      const trusted = Array.isArray(section.trusted) ? section.trusted.filter((t) => typeof t === "string") : [];
      if (!trusted.includes(folder)) trusted.push(folder);
      (state as Record<string, unknown>)[PROFILE_KEY] = { ...section, trusted };
    }
    // The marketplaces (specs/app/plugins.feature.md "The marketplace is a
    // git repository with an index"): `{ name, source }` rows, taken whole;
    // an empty list is the choice of none, unlike no key at all.
    if (marketplaces !== undefined) {
      const rows = Array.isArray(marketplaces) ? marketplaces.map(marketplaceRef) : null;
      if (!rows || rows.some((r) => r === null)) {
        return json({ error: "plugins.marketplaces must be a list of { name, source } rows" }, 400);
      }
      const unique = (rows as { name: string; source: string }[]).filter(
        (r, i, all) => all.findIndex((x) => x.name === r.name) === i,
      );
      const section = profileSection(state);
      (state as Record<string, unknown>)[PROFILE_KEY] = { ...section, marketplaces: unique };
    }
  }
  for (const manifest of profileManifests) {
    const key = manifest.legacyKey as keyof typeof body | undefined;
    if (!key || body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") {
      return json({ error: `${key} must be a boolean` }, 400);
    }
    enabled = withPlugin(enabled, manifest.id, body[key] as boolean);
  }
  if (migrateProfile(raw, profileManifests) || !sameProfile(enabled, before)) {
    writeProfile(raw, enabled, profileManifests);
  }
  // The special folders (specs/app/roadmap.feature.md "Create roadmap folder
  // if necessary", specs/app/tasks.feature.md) are made below when their
  // plugin goes on, once the settings are written; a plugin with a folder
  // of its own makes it as it mounts. The notebook's is not: it appears
  // with the first entry, which is what lets a module ship on without
  // writing to anybody's repo.
  const turnedOn: PageFolder[] = [];
  const nowOn = (id: string) => enabled.includes(id) && !before.includes(id);
  if (nowOn("roadmap")) turnedOn.push(ROADMAP);
  if (nowOn("tasks")) turnedOn.push(TASKS);
  // Google Calendar (specs/app/tasks.feature.md "Add task to Google
  // Calendar"): opt-in — an absent key when off. Nothing to make: the
  // estimate lands on the task's own page, and the event on Google's side.
  if (body.googleCalendar !== undefined) {
    if (typeof body.googleCalendar !== "boolean") {
      return json({ error: "googleCalendar must be a boolean" }, 400);
    }
    if (body.googleCalendar) state.googleCalendar = true;
    else delete state.googleCalendar;
  }
  // Websocket document sync (specs/datastore/automerge-store.feature.md):
  // opt-in, empty or null turns it off — the default, stored as an absent key.
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
  // The profile mounts and unmounts its plugins on the spot: a module turned
  // off answers 404 from here on, one turned on has its routes.
  await syncHostPlugins(state);
  setProjectionOptions({
    publishExternalLinks: normalizePublishExternalLinks(state.publishExternalLinks),
  });
  // Scenario "Create roadmap folder if necessary": the switch is what asks
  // for the folder, so it is made on the spot rather than on the next tick.
  // A repo we cannot reach is left to that tick; the switch still stands.
  if (turnedOn.length > 0 && !needsDataRepo(state)) {
    try {
      const dir = pickedDir ?? (await resolveDataRepo(state.dataRepo!, getAppRoot()));
      for (const kind of turnedOn) {
        if (await ensurePageFolder(dir, kind)) {
          reloadLog.info(`created the ${kind.folder} folder`);
        }
      }
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
  // specs/ui/app-start.feature.md "changing the data repo": a newly picked
  // folder is pulled before the response, so the client's first read of it —
  // which follows this response — already shows the latest data. A pull that
  // fails is logged and the switch still stands; the folder is configured
  // either way.
  if (pickedDir) {
    const dir = pickedDir;
    await syncTick(() => syncDataDir(dir));
  }
  await applyNetSync(state);
  return json(await stateFields(state));
};

// Sync button (specs/ui/ui.feature.md "Main page"): immediate data reload —
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

// GitHub sign-in (git-operations.md): device flow — start
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

// Browser sign-in (git-operations.md "connect to GitHub via the
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
    // Only the spec tree is walked, so the reserved top-level folders —
    // `roadmap/`, `tasks/`, a plugin's `models/`, each listed on its own tab
    // — are out of range by construction rather than subtracted here.
    folders: await listFolders(dir),
    members: settings.members,
    codeRepo: settings.codeRepo,
    // Authorship in the feature files (specs/app/specs-authorship.feature.md)
    // — a setting of the data repo, so it comes with the repo's listing.
    authorsInMarkdown: settings.authorsInMarkdown,
    // GitHub issue tracking (specs/app/github-issues.feature.md): the
    // repository the code repo pushes to, when it is a GitHub one — the
    // Issues tab shows for it, and only for it. readIssuesRepo answers for
    // the demo too, which names its repo outright (demo.ts).
    issuesRepo: await readIssuesRepo(dir),
  });
});

// The data repo's own settings that Settings can change
// (specs/app/specs-authorship.feature.md): `authors-in-markdown` in its
// project-settings.json. Written into the repo — every teammate's app then
// writes the feature files the same way — and every `.feature.md` is
// reprojected on the spot, as the "Publish external links" switch does; the
// reload cron commits and pushes the lot like any saved change.
const putProjectSettings = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as { authorsInMarkdown?: unknown } | null;
  if (typeof body?.authorsInMarkdown !== "boolean") {
    return json({ error: "authorsInMarkdown must be a boolean" }, 400);
  }
  try {
    if (await writeAuthorsInMarkdown(dir, body.authorsInMarkdown)) {
      const changed = await reprojectFeatures(dir);
      reloadLog.info(
        `authors ${body.authorsInMarkdown ? "written into" : "withheld from"} ${changed} feature file(s)`,
      );
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const settings = await readProjectSettings(dir);
  return json({ authorsInMarkdown: settings.authorsInMarkdown });
});

// Full-text search (specs/search.feature.md): ranked hits over feature
// names/descriptions and scenario names/bodies, each with a snippet
// around its first match. An empty query is no results, not an error.
// `scope=roadmap` or `scope=tasks` searches that folder's pages instead —
// what the folder's own sidebar tab searches (specs/app/roadmap.feature.md,
// specs/app/tasks.feature.md).
// The data repo's README (app-startup.md "App Starts with
// existing specs folder selected"): the home view opens it in an editor.
const getReadme = withDataDir(async (dir) => json(await readReadme(dir)));

// The README editor's autosave: a local write — the reload cron commits
// and pushes it, like a saved scenario (specs/editor/editor-autosave.feature.md
// "Autosave Saves Locally"). `from` is the last loaded/saved text so a
// disk edit the dirty editor has not shown is folded in, not overwritten.
const putReadme = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as { content?: unknown; from?: unknown } | null;
  if (typeof body?.content !== "string") return json({ error: "content is required" }, 400);
  const from = typeof body.from === "string" ? body.from : undefined;
  try {
    return json(await writeReadme(dir, body.content, from));
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
  const scope = url.searchParams.get("scope") ?? "specs";
  if (!isSearchScope(scope)) return json({ error: `unknown search scope: ${scope}` }, 400);
  // A plugin's scope (`scope=models`, the Event Models plugin's) searches
  // what that plugin lists — what its tab's palette searches.
  const kind = scope === "specs" ? null : pageFolderNamed(scope);
  const results = kind
    ? await searchPages(dir, kind, q, limit)
    : scope === "specs"
      ? await searchSpecs(dir, q, limit)
      : await searchScope(dir, scope, q, limit);
  return json({ query: q, scope, results });
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
  // which are never in the file (specs/datastore/automerge-store.feature.md),
  // and the parsed form carrying each scenario's document id — the identity the
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
  // Trimmed, as every heading parses (parser.ts SCENARIO_RE), so the target
  // names the scenario the saved text holds.
  const target: ScenarioTarget = { name: body.name.trim(), version: body.version };
  if (typeof body.id === "string") target.id = body.id;
  return target;
}

const putFeature = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as {
    content?: string;
    resolveConflict?: boolean;
    save?: boolean;
    // The scenario this request is about. On a publish: the one scenario to
    // publish (crud-feature.md "publish each scenario
    // individually"), absent = publish all. On a save: the dialog's scenario.
    // Its document id, when the editor holds one, keeps a scenario saved
    // under a new name or version one scenario rather than two
    // (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
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
    // commits and pushes (crud-feature.md).
    if (body.save) return json(await saveFeature(dir, params.file!, body.content, scenario));
    const result = body.resolveConflict
      ? await resolveFeatureConflict(dir, params.file!, body.content, scenario)
      : await publishFeature(dir, params.file!, body.content, scenario);
    return json(result, result.status === "conflict" ? 409 : 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/ui.feature.md "Scenario editor" (Delete on a draft): a draft lives
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
  const target: ScenarioTarget = { name: body.scenario.name.trim(), version: body.scenario.version };
  try {
    return json(await deleteDraftScenario(dir, params.file!, target));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/external-links/related-pull-requests.feature.md: the pull requests
// linked to a feature (no `scenario` in the body) or to one of its scenarios.
// A document-only write, like delete-draft: the links never reach the
// markdown, so a save cannot carry them. The whole list is sent and the
// document brought to it by url. The scenario is named by id, name and
// version the way a save names it.
const putPullRequests = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as {
    scenario?: { name?: string; version?: number; id?: string } | null;
    prs?: unknown;
  };
  const prs = validPullRequests(body.prs);
  if (prs === null) return json({ error: "prs must be a list of { url, title } with http(s) urls" }, 400);
  let target: ScenarioTarget | null = null;
  if (body.scenario) {
    const { name, version, id } = body.scenario;
    if (typeof name !== "string" || typeof version !== "number") {
      return json({ error: "scenario needs a name and a version" }, 400);
    }
    target = { name: name.trim(), version, ...(typeof id === "string" ? { id } : {}) };
  }
  try {
    return json(await savePullRequests(dir, params.file!, target, prs));
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
  const target: ScenarioTarget = { name: body.scenario.name.trim(), version: body.scenario.version };
  try {
    return json(await deletePublishedScenario(dir, params.file!, target));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/navigation.feature.md "move a scenario to another feature": the
// scenario menu's Move to… — offered on the same terms as its Delete, so a
// published scenario moves only while Settings allows deleting published
// ones, enforced here as delete-published enforces it.
const postMoveScenario = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { scenario?: ScenarioBody; to?: unknown };
  const target = scenarioTarget(body.scenario);
  if (!target) return json({ error: "scenario needs a name and a version" }, 400);
  if (typeof body.to !== "string") return json({ error: "to is required" }, 400);
  try {
    const source = await readFeatureView(dir, params.file!);
    const moving = source?.parsed.scenarios.find(
      (s) => s.name === target.name && s.version === target.version,
    );
    if (
      moving?.status === "published" &&
      !normalizeDeletePublished((await readState(getAppRoot())).deletePublished)
    ) {
      return json({ error: "Moving published scenarios is switched off in Settings" }, 403);
    }
    return json(await moveScenario(dir, params.file!, target, body.to));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/ui.feature.md "Feature entry menu": Delete removes the feature
// file — a `git rm`, committed and pushed. The client confirms first.
const deleteFeatureRoute = withDataDir(async (dir, _req, params) => {
  try {
    return json(await deleteFeature(dir, params.file!));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Folders (specs/ui/folders.feature.md): directories in the data repo that
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

// Drag-move between folders (specs/ui/folders.feature.md): a `git mv` into
// the target directory, committed and pushed like a rename.
const postMove = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { folder?: string };
  try {
    return json(await moveFeature(dir, params.file!, body.folder ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/ui.feature.md "Feature entry menu" (File → Rename): renames the
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

// specs/ui/ui.feature.md "Main page": the Edit link edits the feature name (the
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

// Image upload (specs/images.feature.md): the editor posts a pasted or chosen
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

/** The `scenario` a files route names, the way a save names it; null when malformed. */
function scenarioTargetOf(value: unknown): ScenarioTarget | null {
  const { name, version, id } = (value ?? {}) as { name?: unknown; version?: unknown; id?: unknown };
  if (typeof name !== "string" || typeof version !== "number") return null;
  return { name: name.trim(), version, ...(typeof id === "string" ? { id } : {}) };
}

// specs/editor/store-associated-files.feature.md "CRUD on files for each
// scenario" — create: the editor posts a chosen file as multipart form data
// with the scenario it belongs to (a JSON `scenario` field). The bytes land
// under `.files/` in the data repo, committed and pushed; the scenario's
// list in the document gains the file under its own name — or, when the
// list already has that name (or the form's `name` field names an entry to
// replace), that entry now points at the new bytes.
const postScenarioFile = withDataDir(async (dir, req, params) => {
  let file: File;
  let target: ScenarioTarget | null;
  let replacing: string | null = null;
  try {
    const form = await req.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) throw new Error("no file");
    file = entry;
    const scenario = form.get("scenario");
    target = typeof scenario === "string" ? scenarioTargetOf(JSON.parse(scenario)) : null;
    const name = form.get("name");
    if (typeof name === "string" && name !== "") replacing = fileDisplayName(name);
  } catch {
    return json({ error: "multipart form data with a 'file' and a 'scenario' field is required" }, 400);
  }
  if (target === null) return json({ error: "scenario needs a name and a version" }, 400);
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: `File is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB)` }, 413);
  }
  // Refused before its name is read: Bun 1.3 parses an empty part with no
  // file name at all.
  if (file.size === 0) return json({ error: "File is empty" }, 400);
  const original = file.name ?? "";
  const listed = replacing ?? fileDisplayName(original);
  if (listed === null) return json({ error: "The file needs a name" }, 400);
  try {
    const current = await readScenarioFiles(dir, params.file!, target);
    if (current === null) {
      return json({ error: `Scenario "${target.name}" @v${target.version} not found` }, 400);
    }
    const stored = await storeScenarioFile(dir, original, new Uint8Array(await file.arrayBuffer()));
    const added = { name: listed, file: stored, size: file.size };
    const next = current.some((f) => f.name === listed)
      ? current.map((f) => (f.name === listed ? added : f))
      : [...current, added];
    return json(await saveScenarioFiles(dir, params.file!, target, next), 201);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Update and delete: the whole list is sent — a file renamed, or one gone —
// and the document brought to it by name. A document-only write like the
// pull request links; the stored bytes stay in the repo's history.
const putScenarioFiles = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { scenario?: unknown; files?: unknown };
  const target = scenarioTargetOf(body.scenario);
  if (target === null) return json({ error: "scenario needs a name and a version" }, 400);
  const files = validScenarioFiles(body.files);
  if (files === null) return json({ error: "files must be a list of { name, file, size }" }, 400);
  for (const f of files) {
    if (!(await scenarioFileExists(dir, f.file))) {
      return json({ error: `No stored file ${f.file} in ${FILES_DIR}/` }, 400);
    }
  }
  try {
    return json(await saveScenarioFiles(dir, params.file!, target, files));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Read: a stored file, downloaded under the name the scenario lists it by
// (`?name=`). Always an attachment of opaque bytes — never rendered in the
// app's origin, whatever the file holds. Content-addressed, so cache forever.
const getScenarioFile = withDataDir(async (dir, req, params) => {
  const bytes = await readScenarioFile(dir, params.name!);
  if (bytes === null) return json({ error: "not found" }, 404);
  const listed = fileDisplayName(new URL(req.url).searchParams.get("name") ?? "") ?? params.name!;
  const ascii = listed.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(listed)}`,
      "cache-control": "private, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; sandbox",
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
      files.push({ fileName: fileName.trim() });
      continue;
    }
    if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
    const picks: ScenarioPick[] = [];
    for (const s of scenarios) {
      const { name, version } = (s ?? {}) as { name?: unknown; version?: unknown };
      if (typeof name !== "string" || !Number.isInteger(version) || (version as number) < 1) {
        return null;
      }
      picks.push({ name: name.trim(), version: version as number });
    }
    files.push({ fileName: fileName.trim(), scenarios: picks });
  }
  return files;
}

const CLI_MISSING = "Claude CLI not found — install the `claude` command";
const PI_MISSING = "Pi CLI not found — install the `pi` command (https://pi.dev)";
const CODEX_MISSING = "Codex CLI not found — install the `codex` command (npm i -g @openai/codex)";
/** The agents as the error message lists them: "claude, pi or codex". */
const CHAT_AGENT_LIST = `${CHAT_AGENTS.slice(0, -1).join(", ")} or ${CHAT_AGENTS.at(-1)}`;

// Code gen session (specs/agents/claude.feature.md): the client sends the
// session name, the selected specs — whole files or per-file scenario
// subsets — and where to run; we build one prompt from them and either open
// it in the app's own coding agent pane or in Claude Code Desktop. A failure
// comes back as an error for the client's error box.
/**
 * What a session request resolves to — the name, the selected specs read
 * from the repo, what the plugins bundle with them, and where the session
 * would run — or the refusal to send back. Shared by the session route and
 * the prompt route below, so a copied prompt is the same text a started
 * session gets.
 *
 * The plugins' part (src/plugins/host/services.ts SessionParts): the
 * request's `attachments` name what was open on a plugin's tab, by plugin
 * id — the model on the Models tab, whose linked specs then come along
 * whole — and every mounted contributor is asked, so one may bundle what
 * the picked specs link (a model whose slice links one). A session may run
 * from attachments alone.
 */
async function resolveSessionRequest(
  dir: string,
  body: { name?: unknown; files?: unknown; attachments?: unknown },
): Promise<
  { name: string; specs: SpecInput[]; place: SessionPlace; sections: SessionSection[] } | Response
> {
  // The Settings switch is the gate, enforced here and not only in the UI:
  // switched off, nothing can hand a spec to Claude.
  const state = await readState(getAppRoot());
  if (!normalizeCodeGen(state.codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  const name = typeof body.name === "string" ? cleanLine(body.name) : "";
  if (!name) return json({ error: "name is required" }, 400);
  const attachments = parseSessionAttachments(body.attachments);
  if (attachments === null) {
    return json({ error: "attachments must map a plugin id to a list of names" }, 400);
  }
  const contributors = sessionParts.entries();
  const unknown = Object.keys(attachments).find((id) => !contributors.some(([key]) => key === id));
  if (unknown !== undefined) return json({ error: `nothing takes attachments for ${unknown}` }, 400);
  const files = parseSessionFiles(body.files) ?? [];
  if (files.length === 0 && Object.values(attachments).every((refs) => refs.length === 0)) {
    return json({ error: "files must name at least one spec or scenario" }, 400);
  }
  const sections: SessionSection[] = [];
  try {
    const specFiles = files.map((f) => f.fileName);
    for (const [id, contribute] of contributors) {
      const bundled = await contribute(dir, { refs: attachments[id] ?? [], specFiles });
      sections.push(...bundled.sections);
      // What an attachment links joins the session whole, unless already picked.
      for (const fileName of bundled.features) {
        if (!files.some((f) => f.fileName === fileName)) files.push({ fileName });
      }
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
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
  return { name, specs, sections, place: codeRepo ? { dataRepo: dir, codeRepo } : { dataRepo: dir } };
}

/**
 * What a session request attaches, by plugin id: none when absent, null
 * when malformed.
 */
function parseSessionAttachments(value: unknown): Record<string, string[]> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [id, refs] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(refs) || !refs.every((v) => typeof v === "string")) return null;
    out[id] = [...new Set(refs as string[])];
  }
  return out;
}

const postAgentSession = withDataDir(async (dir, req) => {
  const body = (await req.json()) as {
    name?: string;
    files?: unknown;
    attachments?: unknown;
    target?: unknown;
  };
  const resolved = await resolveSessionRequest(dir, body);
  if (resolved instanceof Response) return resolved;
  const target = normalizeCodeGenTarget(body.target);
  if (target === null) return json({ error: `target must be ${CODE_GEN_TARGET_LIST}` }, 400);
  const { name, specs, place, sections } = resolved;
  // The pane (specs/agents/agent-pane.feature.md): the prompt opens a
  // live chat in the app; the client shows it and the conversation goes on.
  // "pane" is that chat with Claude, "pi" the same chat with Pi
  // (specs/agents/integration-with-pi-dev-agent.feature.md), "codex" the
  // same chat with Codex (src/server/codexChat.ts).
  if (target === "pane" || target === "pi" || target === "codex") {
    const agent: ChatAgent = target === "pane" ? "claude" : target;
    const missing = missingAgentCli(agent);
    if (missing) return missing;
    try {
      const meta = await createChatSession({
        place,
        name,
        agent,
        prompt: buildSessionPrompt(name, specs, place, sections),
        firstResponseSeconds: await agentFirstResponseSeconds(),
        sessionsDir: await sessionsDirectory(getAppRoot()),
      });
      return json({ name, id: meta.id, target });
    } catch (e) {
      return chatError(e);
    }
  }
  if (!claudeDesktopAvailable()) {
    return json({ error: "Claude Code Desktop not found — install Claude.app" }, 502);
  }
  try {
    const sessionsDir = await sessionsDirectory(getAppRoot());
    return json(await launchDesktopSession(place, name, specs, { sessionsDir, sections }));
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});

// The same prompt, for the clipboard: the session dialog's "Copy prompt to
// clipboard" option builds the prompt without running anything, so it can be
// pasted into an agent the app doesn't drive. Nothing is launched and no
// session is recorded — only the text comes back.
const postAgentSessionPrompt = withDataDir(async (dir, req) => {
  const body = (await req.json()) as { name?: unknown; files?: unknown; attachments?: unknown };
  const resolved = await resolveSessionRequest(dir, body);
  if (resolved instanceof Response) return resolved;
  const { name, specs, place, sections } = resolved;
  return json({ name, prompt: buildSessionPrompt(name, specs, place, sections) });
});

// ---------------------------------------------------------------------------
// Coding agent pane (specs/agents/agent-pane.feature.md): a live Claude
// Code chat the app drives itself (src/server/agentChat.ts). Creating one
// needs the data repo — for the code repo its project-settings.json names —
// so it goes through withDataDir; everything after that addresses a session
// by id. Events reach the client over a one-way NDJSON stream, the only kind
// of push that works over both Bun.serve and Electron's app:// protocol.

/** The refusal for an agent whose CLI is not on PATH, or null when it is. */
function missingAgentCli(agent: ChatAgent): Response | null {
  if (agent === "pi" && !piAvailable()) return json({ error: PI_MISSING }, 502);
  if (agent === "codex" && !codexAvailable()) return json({ error: CODEX_MISSING }, 502);
  if (agent === "claude" && !claudeAvailable()) return json({ error: CLI_MISSING }, 502);
  return null;
}

/** Where a pane session runs, or the refusal: switched off, no CLI, no repo. */
async function agentPanePlace(
  dir: string,
  agent: ChatAgent,
  cwd?: string,
): Promise<SessionPlace | Response> {
  if (!normalizeCodeGen((await readState(getAppRoot())).codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  const missing = missingAgentCli(agent);
  if (missing) return missing;
  // A folder the pane picked: it stands in for the code repo, so the data
  // repo still rides along as an extra directory unless it is the folder.
  if (cwd !== undefined) {
    if (!(await directoryExists(cwd))) return json({ error: `Folder not found: ${cwd}` }, 400);
    // resolve() drops a trailing slash the open folder may have been typed with.
    return resolve(cwd) === resolve(dir) ? { dataRepo: dir } : { dataRepo: dir, codeRepo: cwd };
  }
  const { codeRepo } = await readProjectSettings(dir);
  if (codeRepo !== null && !(await directoryExists(codeRepo))) {
    return json(
      { error: `Code repo not found: ${codeRepo} (code-repo in ${PROJECT_SETTINGS_FILE})` },
      400,
    );
  }
  return codeRepo ? { dataRepo: dir, codeRepo } : { dataRepo: dir };
}

/** The Settings wait for a Claude turn's first API response behind a proxy. */
async function agentFirstResponseSeconds(): Promise<number> {
  return normalizeAgentFirstResponseSeconds((await readState(getAppRoot())).agentFirstResponseSeconds);
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
    cwd?: unknown;
  };
  // Which agent drives the chat; absent is Claude, as it was before Pi.
  const agent = body.agent === undefined ? "claude" : normalizeChatAgent(body.agent);
  if (agent === null) return json({ error: `agent must be ${CHAT_AGENT_LIST}` }, 400);
  // The folder to work in; absent is the code repo, else the data repo.
  let cwd: string | undefined;
  if (body.cwd !== undefined) {
    const raw = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const expanded = raw === "~" || raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
    if (!isAbsolute(expanded)) return json({ error: "cwd must be an absolute path" }, 400);
    cwd = resolve(expanded);
  }
  const place = await agentPanePlace(dir, agent, cwd);
  if (place instanceof Response) return place;
  const name = (typeof body.name === "string" && cleanLine(body.name)) || "Coding agent session";
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
      firstResponseSeconds: await agentFirstResponseSeconds(),
      sessionsDir: await sessionsDirectory(getAppRoot()),
    });
    return json(meta);
  } catch (e) {
    return chatError(e);
  }
});

const MODE_ERROR = `permissionMode must be one of ${PERMISSION_MODES.join(", ")}`;

// A hosted worker runs no agents; its pane lists none rather than refusing,
// so the client's boot-time restore stays quiet (src/server/hostedMode.ts).
const getAgentChats: Handler = () => json({ sessions: isHostedMode() ? [] : listChatSessions() });

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

// Native folder chooser (specs/ui/app-start.feature.md "picking the data
// directory with the native folder chooser"): opens the OS dialog on the
// machine the app runs on. 501 on runtimes with no native chooser — the client
// hides Browse… then (canChooseFolder in /api/state).
// `purpose` picks one of the fixed dialog titles — never free text, since
// the title is spliced into the osascript and PowerShell the dialog runs.
const postChooseFolder: Handler = async (req) => {
  if (!canChooseFolder()) {
    return json({ error: "no native folder chooser on this runtime" }, 501);
  }
  const body = (await req.json().catch(() => null)) as { purpose?: unknown } | null;
  const purpose = body?.purpose === "code-repo" ? "code-repo" : "data-repo";
  return json({ path: await chooseFolder(purpose) });
};

// Add the spec repo to a code repo as a git submodule (git-operations.md,
// "Add the spec repo to a code repo as a submodule"; src/server/submodule.ts).
// The code repo is the one picked in Settings, else project-settings.json's
// `code-repo`; a relative path resolves against the data repo, as that
// setting's does. System git only — the bundled engine has no `submodule`.
const addCodeRepoSubmodule = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => ({}))) as { codeRepo?: unknown; name?: unknown };
  const picked = typeof body.codeRepo === "string" ? body.codeRepo.trim() : "";
  const codeRepo = picked || (await readProjectSettings(dir)).codeRepo;
  if (!codeRepo) return json({ error: "Choose the code repo to add the specs to" }, 400);
  const name = typeof body.name === "string" ? body.name : undefined;
  try {
    return json(await addSpecsSubmodule(dir, codeRepo, name));
  } catch (e) {
    if (e instanceof SubmoduleError) return json({ error: e.message }, e.status);
    throw e;
  }
});
// Refused before the data repo is resolved: the demo's dataset has no git
// remote to point a submodule at, and without a git binary there is nothing
// to run it with.
const postCodeRepoSubmodule: Handler = (req, params) => {
  if (isDemoMode()) return json({ error: "Submodules cannot be added in demo mode" }, 403);
  if (!cliGitAvailable()) {
    return json({ error: "Adding a submodule needs git installed — the bundled engine cannot" }, 501);
  }
  return addCodeRepoSubmodule(req, params);
};

/**
 * 403 in a hosted worker (src/server/hostedMode.ts) — routes that run code
 * on the host, open something on its desktop, or sign in to GitHub, which
 * the gateway's account page does instead.
 */
const unlessHosted =
  (handler: Handler): Handler =>
  (req, params) =>
    isHostedMode() ? json({ error: HOSTED_REFUSAL }, 403) : handler(req, params);

/** 403 in demo mode — routes whose whole point is talking to GitHub. */
const unlessDemo =
  (handler: Handler): Handler =>
  (req, params) =>
    isDemoMode()
      ? json({ error: "GitHub sign-in is disabled in demo mode" }, 403)
      : handler(req, params);

// The test management module's routes live in its plugin
// (src/plugins/builtin/tests/host.ts) and exist only while it is mounted.

// GitHub issue tracking lives in its plugin (src/plugins/builtin/issues/host.ts).

/**
 * The name of the test a reference url points at (specs/external-links/
 * test-traceability.feature.md), read from the code on GitHub
 * (src/server/testName.ts). A malformed url is a 400; every other failure
 * is a 200 with `name: null` and a `reason` for the editor's hint — the
 * link is kept either way, only the name is missing.
 */
const getTestName: Handler = async (req) => {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (!parseTestUrl(url)) {
    return json({ error: "url must be a GitHub file url with a #L<line> anchor" }, 400);
  }
  if (isDemoMode()) return json({ name: null, reason: "Test names are not read from GitHub in demo mode." });
  return json(await resolveTestName(url));
};

/**
 * The entity fields the scenario editor offers after `@` + Tab (specs/
 * editor/data-model-integration-in-editor.feature.md), read from the Java
 * classes and CDS entities in the project's code repo (src/server/
 * entities.ts). No code repo, or one that is not there, is an empty list,
 * not an error: the editor asks quietly on open and simply has nothing to
 * offer — open-in-idea is where a missing folder is reported.
 */
const getEntityFields: Handler = withDataDir(async (dir) => {
  const { codeRepo } = await readProjectSettings(dir);
  if (codeRepo === null || !(await directoryExists(codeRepo))) {
    return json({ codeRepo, entities: 0, fields: [] });
  }
  const entities = await scanEntities(codeRepo);
  return json({ codeRepo, entities: entities.length, fields: fieldChoices(entities) });
});

/**
 * A pull request's title and state, read from GitHub for the "Pull requests"
 * field (specs/external-links/related-pull-requests.feature.md). A url that
 * is not a GitHub pull request is a 400; every other failure is a 200 with
 * `title: null` and a `reason` for the hint — the link can be added either
 * way, only the title is missing.
 */
const getPullRequestRoute: Handler = async (req) => {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  const ref = parsePullRequestUrl(url);
  if (!ref) return json({ error: "url must be a GitHub pull request url" }, 400);
  if (isDemoMode()) {
    const answer: PullRequestLookup = {
      title: null,
      reason: "Pull requests are not read from GitHub in demo mode.",
    };
    return json(answer);
  }
  try {
    const answer: PullRequestLookup = await getPullRequest(ref.owner, ref.repo, ref.number);
    return json(answer);
  } catch (e) {
    const answer: PullRequestLookup = { title: null, reason: (e as Error).message };
    return json(answer);
  }
};

/**
 * Open a test link in IntelliJ IDEA (specs/traceability.feature.md "Open
 * test in idea"): the url's file under the project's code repo, at the
 * url's line, through `idea --line <n> <file>` (src/server/idea.ts). Each
 * way that can't work is its own answer, worded for the toast the client
 * shows: the setting off, no `idea` on PATH (with the symlink to make),
 * no code repo named, or the file not in it.
 */
const postOpenTestInIdea = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof body.url === "string" ? body.url : "";
  if (!parseTestUrl(url)) {
    return json({ error: "url must be a GitHub file url with a #L<line> anchor" }, 400);
  }
  if (isDemoMode()) return json({ error: "Test links open in the browser in demo mode" }, 403);
  const state = await readState(getAppRoot());
  if (!normalizeOpenTestsInIdea(state.openTestsInIdea)) {
    return json({ error: '"Open test links in IntelliJ IDEA" is off in Settings' }, 409);
  }
  if (!ideaAvailable()) {
    return json({ error: `idea not found on PATH — on a Mac: ${IDEA_SYMLINK_HINT}` }, 502);
  }
  const { codeRepo } = await readProjectSettings(dir);
  if (codeRepo === null) {
    return json({ error: `No code repo: ${PROJECT_SETTINGS_FILE} must name one in code-repo` }, 400);
  }
  if (!(await directoryExists(codeRepo))) {
    return json({ error: `Code repo not found: ${codeRepo} (code-repo in ${PROJECT_SETTINGS_FILE})` }, 400);
  }
  const test = await localTestFile(codeRepo, url);
  if (!test) return json({ error: `Not in the code repo ${codeRepo}: ${url}` }, 404);
  try {
    await openInIdea(test.file, test.line);
  } catch (e) {
    return json({ error: `Could not start idea: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  return json(test);
});

// The core routes, registered first on the plugin kernel's route registry
// (src/plugins/host/loader.ts) so they match before any plugin's; a mounted
// plugin appends its own, and a disposed one takes them away again.
// The marketplace (src/plugins/host/marketplace.ts): browse, install with a
// consent step, update and remove — in the demo, browsing alone.
const market = marketplaceRoutes({
  demo: isDemoMode,
  readState: async () => (await readState(getAppRoot())) as Record<string, unknown>,
  persist: (s) => writeState(s as SpecDrivenState, getAppRoot()),
});

const coreRoutes: [method: string, pattern: string, handler: Handler][] = [
  ["GET", "/api/state", getState],
  ["PUT", "/api/state", putState],
  ["GET", "/api/plugins/marketplaces", market.getMarketplaces],
  ["POST", "/api/plugins/install", unlessHosted(market.postInstall)],
  ["POST", "/api/plugins/:id/update", unlessHosted(market.postUpdate)],
  ["DELETE", "/api/plugins/:id", unlessHosted(market.deletePlugin)],
  ["POST", "/api/choose-folder", unlessHosted(postChooseFolder)],
  ["POST", "/api/reload", postReload],
  // Observability (src/server/logs.ts): the app's own log, and its verbosity.
  ["GET", "/api/logs", getLogs],
  ["GET", "/api/logs/settings", getLogSettings],
  ["PUT", "/api/logs/settings", putLogSettings],
  ["POST", "/api/auth/github/start", unlessHosted(unlessDemo(postAuthStart))],
  ["POST", "/api/auth/github/poll", unlessHosted(unlessDemo(postAuthPoll))],
  ["POST", "/api/auth/github/web/start", unlessHosted(unlessDemo(postAuthWebStart))],
  ["POST", "/api/auth/github/web/poll", unlessHosted(unlessDemo(postAuthWebPoll))],
  ["GET", "/api/auth/github/callback", unlessHosted(unlessDemo(getAuthWebCallback))],
  ["DELETE", "/api/auth/github", unlessHosted(unlessDemo(deleteAuth))],
  ["GET", "/api/features", getFeatures],
  ["POST", "/api/features", postFeatures],
  ["POST", "/api/images", postImage],
  ["GET", "/api/images/:name", getImage],
  ["GET", "/api/scenario-files/:name", getScenarioFile],
  ["GET", "/api/search", getSearch],
  ["PUT", "/api/project-settings", putProjectSettings],
  ["GET", "/api/readme", getReadme],
  ["PUT", "/api/readme", putReadme],
  ["GET", "/api/test-name", getTestName],
  ["GET", "/api/entity-fields", getEntityFields],
  ["GET", "/api/pull-request", getPullRequestRoute],
  ["POST", "/api/tests/open-in-idea", unlessHosted(postOpenTestInIdea)],
  ["POST", "/api/code-repo/submodule", unlessHosted(postCodeRepoSubmodule)],
  ["GET", "/api/features/:file", getFeature],
  ["PUT", "/api/features/:file", putFeature],
  ["DELETE", "/api/features/:file", deleteFeatureRoute],
  ["POST", "/api/folders", postFolders],
  ["DELETE", "/api/folders/:path", deleteFolderRoute],
  ["POST", "/api/features/:file/move", postMove],
  ["POST", "/api/features/:file/rename-file", postRenameFile],
  ["POST", "/api/features/:file/rename", postRename],
  ["POST", "/api/features/:file/delete-draft", postDeleteDraft],
  ["PUT", "/api/features/:file/pull-requests", putPullRequests],
  ["POST", "/api/features/:file/scenario-files", postScenarioFile],
  ["PUT", "/api/features/:file/scenario-files", putScenarioFiles],
  ["POST", "/api/features/:file/delete-published", postDeletePublished],
  ["POST", "/api/features/:file/move-scenario", postMoveScenario],
  ["POST", "/api/agent/session", unlessHosted(postAgentSession)],
  ["POST", "/api/agent/session/prompt", postAgentSessionPrompt],
  ["POST", "/api/agent/chat", unlessHosted(postAgentChat)],
  ["GET", "/api/agent/chat", getAgentChats],
  ["GET", "/api/agent/chat/:id", unlessHosted(getAgentChat)],
  ["GET", "/api/agent/chat/:id/events", unlessHosted(getAgentChatEvents)],
  ["POST", "/api/agent/chat/:id/message", unlessHosted(postAgentChatMessage)],
  ["POST", "/api/agent/chat/:id/permission", unlessHosted(postAgentChatPermission)],
  ["POST", "/api/agent/chat/:id/interrupt", unlessHosted(postAgentChatInterrupt)],
  ["PUT", "/api/agent/chat/:id/mode", unlessHosted(putAgentChatMode)],
  ["DELETE", "/api/agent/chat/:id", unlessHosted(deleteAgentChat)],
  // "/active" before "/:id": the table is first-match.
];
for (const [method, pattern, handler] of coreRoutes) routeRegistry.add(method, pattern, handler);
// Plugins reach the data dir through the kernel (src/plugins/host/services.ts).
provideDataAccess({ withDir: withDataDir, dir: currentDataDir });

export type { ApiMatch } from "../plugins/host/services";

/** Match a request line against the route table — core rows, then the mounted plugins. */
export function matchApi(method: string, pathname: string) {
  return routeRegistry.match(method, pathname);
}

/** Serve an API request, or null when the path is not an API route. */
export async function handleApi(req: Request): Promise<Response | null> {
  const match = matchApi(req.method, new URL(req.url).pathname);
  return match ? match.handler(req, match.params) : null;
}
