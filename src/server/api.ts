// Runtime-agnostic HTTP API (specs/app/desktop-app.feature.md): one route table
// serves both Bun.serve in web mode and the app:// protocol handler in the
// desktop app, so handlers speak only the standard Request/Response types.

import {
  readState,
  writeState,
  needsDataRepo,
  normalizeAssignments,
  normalizeFeatureFlags,
  normalizeScenarioPolarity,
  normalizeQtestLinks,
  normalizeAhaImport,
  normalizeResourceLinks,
  normalizeAutosaveSeconds,
  normalizeCodeGen,
  normalizeCodeGenTarget,
  codeGenTargetList,
  DEFAULT_PROJECT_MANAGEMENT_TOOL,
  normalizeDeletePublished,
  normalizeProjectManagement,
  normalizeProjectManagementTool,
  normalizePublishExternalLinks,
  normalizeGoogleCalendar,
  normalizeScenarioPreviewLines,
  normalizeOpenTestsInIdea,
  normalizeShowTestLinks,
  normalizeUseGhAccount,
  normalizeSyncServerUrl,
  forgetDataRepo,
  normalizeDataRepo,
  recentDataRepos,
  rememberDataRepo,
  MIN_AUTOSAVE_SECONDS,
  normalizeQtestParentUrl,
  settingsDirectory,
} from "./state";
import type { SpecDrivenState } from "./state";
import { onePerRepo, sameRepoAs } from "./sameRepo";
import { dataRepoDir, ensureDataRepoFolder, MissingDataRepoError, parseGitHubUrl, resolveDataRepo } from "./repo";
import { isDemoMode, reseedDemo } from "./demo";
import { HOSTED_REFUSAL, isHostedMode } from "./hostedMode";
import { isReadOnlyMode, READ_ONLY_REFUSAL, readOnlyAllows, readOnlySite } from "./readOnlyMode";
import { canChooseFolder, chooseFolder } from "./folderChooser";
import {
  cliGitAvailable,
  currentEngine,
  ghAccount,
  ghAccountInUse,
  ghAvailable,
  ghSignedIn,
  jsGitAvailable,
  normalizeGitEngine,
  setGhAccountEnabled,
  setGitEngine,
} from "./git";
import {
  getAuth,
  handleWebCallback,
  pollDeviceFlow,
  pollWebFlow,
  signInWithToken,
  signOut,
  startDeviceFlow,
  startWebFlow,
} from "./auth";
import { GITHUB_HOST } from "./github";
import { getCurrentUser } from "./user";
import { getAppRoot } from "./paths";
import {
  listFeatures,
  listFolders,
  listFolderDescriptions,
  listFolderOrders,
  listFeatureOrders,
  readFeatureForEditor,
  readFeatureView,
  createFeature,
  createFolder,
  deleteFolder,
  renameFolder,
  moveFolder,
  setFolderDescription,
  setFolderOrder,
  setFeatureOrder,
  deleteDraftScenario,
  deleteFeature,
  deletePublishedScenario,
  deleteScenarios,
  PublishedLockedError,
  unpublishScenario,
  moveScenario,
  cloneScenario,
  moveFeature,
  renameFeature,
  renameFeatureFile,
  reprojectFeatures,
  saveConfluencePage,
  saveQtestModule,
  saveFeature,
  saveFeatureTickets,
  savePullRequests,
  saveResourceLinks,
  readScenarioFiles,
  saveScenarioFiles,
  publishFeature,
  resolveFeatureConflict,
} from "./features";
import type { FeatureView, ScenarioTarget } from "./features";
import {
  buildSessionPrompt,
  claudeDesktopAvailable,
  launchDesktopSession,
  SESSION_TITLE_MAX,
  sessionsDirectory,
} from "./agent";
import type { SessionPlace, SpecInput } from "./agent";
import { folderGitInfo, WORKTREES_SUBDIR } from "./agentWorktree";
import {
  ChatError,
  agentChoices,
  agentReportedModels,
  answerPermission,
  checkImages,
  createChatSession,
  endChatSession,
  getChatCommands,
  getChatEvents,
  getChatImage,
  getChatSession,
  interruptChat,
  listChatSessions,
  resolveProvider,
  sendChatMessage,
  setAgentDefaults,
  setChatEffort,
  setChatModel,
  setChatPermissionMode,
  subscribeChat,
} from "./agentChat";
import type { AgentDefaultsPatch, ChatAgent, ChatEvent, PermissionAnswer } from "./agentTypes";
import {
  EFFORT_LEVELS,
  isFinalStatus,
  normalizeEffort,
  normalizeModel,
  normalizePermissionMode,
  PERMISSION_MODES,
} from "./agentTypes";
import { agents } from "../plugins/host/agents";
import { directoryExists } from "./fsx";
import { readFile } from "node:fs/promises";
import { currentImageName, imageMime, readImage, storeImage, MAX_IMAGE_BYTES } from "./images";
import { StillReferenced, deleteImages, listImages } from "./imageCleanup";
import {
  FILES_DIR,
  MAX_FILE_BYTES,
  readScenarioFile,
  scenarioFileExists,
  storeScenarioFile,
} from "./scenarioFiles";
import { fileDisplayName, validScenarioFiles } from "./scenarioFileList";
import {
  PROJECT_SETTINGS_FILE,
  readProjectSettings,
  writeAuthorsInMarkdown,
  writeCodeRepos,
  writeMembers,
} from "./members";
import type { ProjectSettings } from "./members";
import { createSpecsLink, removeSpecsLink, SpecsLinkError, specsLinkStatus } from "./specsLink";
import { codeRepoCloneJob, CodeRepoCloneError, startCodeRepoClone, suggestedCloneUrl } from "./codeRepoClone";
import { CONFLUENCE_PROGRAM, extractScenarios, QTEST_PROGRAM, serializeFeature, titleFromFileName } from "./parser";
import type { ExternalLink, Feature } from "./parser";
import {
  attachFiles,
  ConfluenceConflict,
  ConfluenceError,
  publishFeaturePage,
  resolveParent,
  validateToken,
  type PublishedPage,
} from "./confluence";
import { normalizeConfluenceBase, onBase, parseParentPageUrl } from "./confluenceUrl";
import { attachmentNames, isPublishScope, renameAttachments, renderFeatureStorage } from "./confluenceStorage";
import {
  clearConfluenceToken,
  confluenceToken,
  listConfluenceTokens,
  saveConfluenceToken,
} from "./confluenceTokens";
import { publishFeatureTestCases, QtestError, validateToken as validateQtestToken } from "./qtest";
import { moduleIdFromUrl, normalizeQtestBase, onQtestBase, parseModuleUrl } from "./qtestUrl";
import { bareQtestToken, clearQtestToken, listQtestTokens, qtestToken, saveQtestToken } from "./qtestTokens";
import { AhaError, getAhaFeature, validateAhaKey } from "./aha";
import { normalizeAhaBase, parseAhaRecordUrl, parseAhaRef } from "./ahaUrl";
import { ahaToken, clearAhaToken, listAhaTokens, saveAhaToken } from "./ahaTokens";
import { isAhaImportScope, planAhaImport } from "./ahaImport";
import { JiraError, validateJiraToken } from "./jira";
import { normalizeJiraBase } from "./jiraUrl";
import { clearJiraToken, listJiraTokens, saveJiraToken } from "./jiraTokens";
import {
  classifySource,
  ImportError,
  MAX_JIRA_SOURCES,
  MAX_WIKI_SOURCES,
  planImportedFeature,
  proposeFeature,
  readSources,
  type SourceLink,
  type SourceRef,
} from "./jiraWikiImport";
import type { ScenarioPick } from "./parser";
import { isSearchScope, searchPages, searchScope, searchSpecs } from "./search";
import { readReadme, writeReadme } from "./readme";
import { readCustomAttributes, writeCustomAttributes } from "./customAttributesFile";
import { readAgentModels, warnUnreportedModels, writeAgentModels, type AgentModels } from "./agentModels";
import type { SessionSection } from "./agent";
import { ROADMAP, TASKS, ensurePageFolder, pageFolderNamed, type PageFolder } from "./pages";
import { getPullRequest, readIssuesRepo } from "./issues";
import { addSpecsSubmodule, SubmoduleError } from "./submodule";
import { parseTestUrl, resolveTestName } from "./testName";
import { parsePullRequestUrl, validPullRequests } from "./pullRequests";
import { RESOURCE_LINK_KINDS, isResourceLinkKind } from "./resourceLinks";
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
import { getDataDoc, getDataDocAt, getDataDocHistory, getDataTable, getDataTables } from "./dataViewer";
import { version as appVersion } from "../../package.json";
import { sourceUrl } from "./sourceUrl";
import { appUpdateHandlers, maybeCheckDaily, updateAvailable } from "./appUpdate";
import {
  anyIncompatible,
  checkDataFormat,
  DATA_TOO_NEW_HEADER,
  incompatibility,
} from "./dataFormat";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bodyOf, json, type Handler, type Params } from "./http";
import {
  pluginStates,
  provideDataAccess,
  rescanPlugins,
  routes as routeRegistry,
  sessionParts,
  sourcePaths,
  syncPlugins,
} from "../plugins/host/loader";
import { profileManifests } from "../plugins/builtin/manifests";
import { applyPluginPatch, pluginPatchRefusal, pluginSettingsOf } from "../plugins/host/pluginSettings";
import {
  AUTO_INSTALLED_KEY,
  agentOffers,
  autoInstallDeps,
  autoInstalled,
  ensureCommandPlugins,
  refreshMarketplacesOnStart,
} from "../plugins/host/autoInstall";
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
const confluenceLog = getLogger("confluence");

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
  setGhAccountEnabled(normalizeUseGhAccount(state.useGhAccount));
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
  // The agent plugins for the commands this machine has (specs/agents/
  // agent-plugins.feature.md "Agent plugins are installed for the commands
  // found on this machine"): not awaited either — the marketplace may be
  // offline, and the pane learns of a new plugin through /api/plugins/events.
  // The marketplaces are pulled first when any external plugin is installed
  // (specs/app/plugins.feature.md "The marketplaces are refreshed on start
  // when external plugins are installed"), so the install reads the index as
  // it is now and never runs git in a marketplace folder beside the pull.
  startupInstall = refreshStartupMarketplaces(state).then(() => installAgentPlugins(state));
}

let startupInstall: Promise<void> = Promise.resolve();

/** Settled once the start's marketplace refresh and agent plugin install are over — for the tests. */
export function autoInstalledOnStart(): Promise<void> {
  return startupInstall;
}

/** Whether the start may reach the marketplaces: the gates installAgentPlugins names. */
function startupReachesMarketplaces(): boolean {
  return !(isHostedMode() || isDemoMode() || isReadOnlyMode() || process.env.SPECDRIVEN_NO_AUTO_INSTALL === "1");
}

/**
 * Pull the marketplaces when any external plugin is installed, so Update is
 * offered for what changed since the last start. Same gates as the install.
 */
async function refreshStartupMarketplaces(state: SpecDrivenState): Promise<void> {
  if (!startupReachesMarketplaces()) return;
  try {
    await refreshMarketplacesOnStart(state as Record<string, unknown>, autoInstallDeps());
  } catch (e) {
    console.error(`[plugins] refreshing the marketplaces: ${(e as Error).message}`);
  }
}

/**
 * Install the agent plugins whose commands are on PATH, from the cached
 * marketplace indexes, then mount what arrived. Not in the hosted app (no
 * plugin folders) and not in the demo (its agent is the simulation);
 * SPECDRIVEN_NO_AUTO_INSTALL=1 keeps a test or a kiosk from reaching out.
 */
async function installAgentPlugins(state: SpecDrivenState): Promise<void> {
  if (!startupReachesMarketplaces()) return;
  try {
    const result = await ensureCommandPlugins(state as Record<string, unknown>, async (s) => {
      // Only the record of what was installed goes to disk, onto the file as
      // it is now — the sync above and a Settings change write beside this.
      const fresh = (await readState(getAppRoot())) as Record<string, unknown>;
      const section = fresh[PROFILE_KEY] && typeof fresh[PROFILE_KEY] === "object" ? (fresh[PROFILE_KEY] as Record<string, unknown>) : {};
      await writeState(
        { ...fresh, [PROFILE_KEY]: { ...section, [AUTO_INSTALLED_KEY]: autoInstalled(s) } } as SpecDrivenState,
        getAppRoot(),
      );
    }, autoInstallDeps());
    if (result.installed.length > 0) await rescanPlugins();
  } catch (e) {
    console.error(`[plugins] installing agent plugins: ${(e as Error).message}`);
  }
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
      ? { signedIn: true, login: auth.login, name: auth.name, email: auth.email, host: auth.host }
      : { signedIn: false as const },
    gh: {
      available: ghAvailable(),
      signedIn: ghAvailable() ? await ghSignedIn() : false,
      login: gh?.login ?? null,
      /** Whether gh's account stands in while the app is signed out. */
      inUse: await ghAccountInUse(),
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

/**
 * The open folder's data format verdict for /api/state: ok, or what to
 * install (specs/app/data-format.feature.md).
 */
async function dataFormatField(state: SpecDrivenState) {
  if (!anyIncompatible() || needsDataRepo(state)) return { ok: true as const };
  let dir: string;
  try {
    dir = await resolveDataRepo(state.dataRepo!, getAppRoot());
  } catch {
    return { ok: true as const };
  }
  const found = incompatibility(dir);
  return found
    ? { ok: false as const, minAppVersion: found.minAppVersion, reason: found.reason }
    : { ok: true as const };
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

/** The data repo's agent model lists for /api/state; none while no folder is open. */
async function agentModelsField() {
  if (isHostedMode()) return {};
  const dir = await currentDataDir();
  return dir ? checkedAgentModels(await readAgentModels(dir)) : {};
}

/** The lists as read, after starting the check that logs a warning for a
    listed model its agent's API does not report — off the request's path. */
function checkedAgentModels(lists: AgentModels): AgentModels {
  void warnUnreportedModels(lists, agentReportedModels).catch(() => {});
  return lists;
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
  // So does the read-only site, which runs no code but the app's: its data
  // folder is whatever the public repo holds.
  return syncPlugins(raw, {
    sources: !isHostedMode() && !isReadOnlyMode(),
    paths: !isDemoMode() && !isReadOnlyMode(),
    dataDir: isDemoMode() || isReadOnlyMode() ? null : await currentDataDir(),
    // Only the profile section goes to disk, onto the file as it is now: a
    // sync runs beside other writers (a demo reseed, a Settings change),
    // and the state it was handed may be behind them.
    persist: async (s) => {
      const fresh = (await readState(getAppRoot())) as Record<string, unknown>;
      await writeState({ ...fresh, [PROFILE_KEY]: s[PROFILE_KEY] } as SpecDrivenState, getAppRoot());
    },
    readState: async () => (await readState(getAppRoot())) as Record<string, unknown>,
  });
}

/** The profile's `plugins` section as stored, whatever keys it has. */
function profileSection(state: SpecDrivenState): Record<string, unknown> {
  const section = (state as Record<string, unknown>)[PROFILE_KEY];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** The local clone directory of each GitHub url among `repos`, by url. */
function cloneDirs(repos: string[]): Record<string, string> {
  const root = getAppRoot();
  return Object.fromEntries(
    repos.filter((r) => parseGitHubUrl(r)).map((r) => [r, dataRepoDir(r, root)]),
  );
}

async function stateFields(state: SpecDrivenState) {
  // One entry per repository (specs/app/spec-folders.feature.md): a list
  // saved before that rule may still name a repo by its url and by a folder.
  const recent = await onePerRepo(recentDataRepos(state), getAppRoot());
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
    // Aha! and Figma links (specs/external-links/aha-and-figma-links
    // .feature.md): each offered only once switched on.
    ahaLinks: normalizeResourceLinks(state.ahaLinks),
    figmaLinks: normalizeResourceLinks(state.figmaLinks),
    // Import from Aha! (specs/external-links/aha-import.feature.md): offered
    // only once switched on.
    ahaImport: normalizeAhaImport(state.ahaImport),
    // qTest test case links (specs/external-links/qtest-test-cases.feature.md):
    // offered only once switched on.
    qtestLinks: normalizeQtestLinks(state.qtestLinks),
    // The qTest dialog's last parent module
    // (specs/external-links/qtest-test-cases.feature.md).
    qtestParentUrl: normalizeQtestParentUrl(state.qtestParentUrl),
    codeGen: normalizeCodeGen(state.codeGen),
    // Where "Start session" runs (specs/agents/claude.feature.md): the
    // remembered choice, or null for "desktop when it is there, else cli".
    codeGenTarget: normalizeCodeGenTarget(state.codeGenTarget, agentIds()),
    // Whether Claude.app is installed here, so a session can open in Claude
    // Code Desktop — gates the "Run in" choice of the session dialog.
    canOpenClaudeDesktop: !isHostedMode() && claudeDesktopAvailable(),
    // The coding agents the plugins supply (specs/agents/agent-plugins
    // .feature.md), by rank, each saying whether its CLI is on PATH — what
    // the pane and the session dialog offer. A hosted worker runs none.
    agents: isHostedMode() ? [] : agents.describe(),
    // Marketplace plugins that would supply an agent, not installed, from
    // the cached indexes (src/plugins/host/autoInstall.ts); the pane
    // offers them. None for a hosted worker or the demo.
    agentOffers: isHostedMode() || isDemoMode() ? [] : await agentOffers(state as Record<string, unknown>, agentIds()),
    // Whether some agent answers one no-tools turn (src/server/estimate.ts).
    canEstimate: !isHostedMode() && agents.oneShot() !== undefined,
    // The models each agent offers (src/server/agentModels.ts), keyed by
    // agent id, from the data repo's .specdriven/<agent>-models.json files — what
    // the model dropdowns choose from. A hosted worker runs no agents.
    agentModels: await agentModelsField(),
    deletePublished: normalizeDeletePublished(state.deletePublished),
    assignments: normalizeAssignments(state.assignments),
    featureFlags: normalizeFeatureFlags(state.featureFlags),
    scenarioPolarity: normalizeScenarioPolarity(state.scenarioPolarity),
    // The plugins (specs/app/plugins.feature.md): the profile's entries in
    // tab order, then the built-ins it leaves off — what Settings → Plugins
    // lists — with the per-module switches they replaced (`roadmap`,
    // `testing`, …) still reported for one release.
    plugins: pluginStates(),
    // The plugins' own settings, by id (src/plugins/host/pluginSettings.ts),
    // for their Settings sections.
    pluginSettings: pluginSettingsOf(state as Record<string, unknown>),
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
    recentDataRepos: recent,
    // Where each GitHub url on that list is cloned on this computer
    // (specs/app/spec-folders.feature.md "Manage specification folders"),
    // which the Spec folders dialog shows under the url. The hosted server's
    // disk is not the user's, so it reports none.
    recentDataRepoDirs: isHostedMode() ? {} : cloneDirs(recent),
    // The open folder as an absolute path on this computer: settings may
    // name it relative to the app (".../specs"), and the coding agent pane
    // offers it as a folder to work in, which must be absolute.
    dataDir: isHostedMode() ? null : await currentDataDir(),
    // Whether the runtime can open a native folder chooser
    // (specs/ui/app-start.feature.md) — gates the Browse… buttons.
    canChooseFolder: !isHostedMode() && canChooseFolder(),
    // Demo mode: the client hides everything that changes or syncs the data
    // directory — the dataset is ephemeral and resets on every page load.
    demo: isDemoMode(),
    // Hosted mode (src/server/hostedMode.ts): the client sends GitHub
    // sign-in to the gateway's account page and offers no local agents.
    hosted: isHostedMode(),
    // The running app's version (package.json), shown beside the user name
    // so every copy, the public demo included, says which build is on screen.
    version: appVersion,
    // A newer release the app's own daily check, or a manual one, found
    // (specs/app/app-updates.feature.md): the version chip marks it.
    updateAvailable: updateAvailable(),
    // The running build's source (src/server/sourceUrl.ts): every copy,
    // network-served ones included, offers it, so the user menu links to it.
    sourceUrl: sourceUrl(),
    // Whether this app may work on the open folder
    // (specs/app/data-format.feature.md): data a newer app wrote blocks it.
    dataFormat: await dataFormatField(state),
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
  // The desktop app's daily look at the releases page
  // (specs/app/app-updates.feature.md): started here, on the boot-time
  // fetch and the routine ones, and not waited for — the answer reaches
  // the client on its next state read.
  maybeCheckDaily();
  const state = await readState(getAppRoot());
  // A demo reseed above rewrote the switches; the plugins follow them, and a
  // plugin folder that appeared meanwhile is picked up.
  await syncHostPlugins(state);
  return json({
    ...(await stateFields(state)),
    ...readOnlyFields(),
    // specs/user-info-settings.feature.md: the OS user by default, with
    // the git identity that authors data-repo commits.
    user: await getCurrentUser(),
  });
};

/**
 * What the read-only site (src/server/readOnlyMode.ts) reports over the
 * usual state: the public repo where the folder's path would be — the
 * snapshot under /tmp is nobody's business — no sign-in, nothing to run,
 * and the refresh cadence the open page re-reads on, though the server's
 * own sync cron stays off (src/server/readOnly.ts refreshes instead).
 */
function readOnlyFields() {
  if (!isReadOnlyMode()) return { readOnly: false };
  const site = readOnlySite();
  const repo = site?.repo ?? null;
  return {
    readOnly: true,
    dataRepo: repo,
    recentDataRepos: repo ? [repo] : [],
    recentDataRepoDirs: {},
    reloadFrequencySeconds: site?.refreshSeconds ?? 0,
    canOpenInIdea: false,
    canOpenClaudeDesktop: false,
    canChooseFolder: false,
    canEstimate: false,
    codeGen: false,
    agents: [],
    agentOffers: [],
    pluginSources: [],
    pluginMarketplaces: [],
    syncServerUrl: null,
    auth: { signedIn: false as const },
    gh: { available: false, signedIn: false, login: null, inUse: false },
  };
}

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
  pluginSettings?: unknown;
  syncServerUrl?: unknown;
}): string | null {
  if (!isHostedMode()) return null;
  if (body.pluginSettings !== undefined) return "Plugin settings cannot be changed in the hosted app";
  if (
    body.dataRepo !== undefined &&
    (typeof body.dataRepo !== "string" || parseGitHubUrl(body.dataRepo)?.host !== GITHUB_HOST)
  ) {
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
    useGhAccount?: boolean;
    showTestLinks?: boolean;
    openTestsInIdea?: boolean;
    projectManagement?: boolean;
    projectManagementTool?: string;
    publishExternalLinks?: boolean;
    ahaLinks?: boolean;
    ahaImport?: boolean;
    figmaLinks?: boolean;
    qtestLinks?: boolean;
    codeGen?: boolean;
    codeGenTarget?: string;
    deletePublished?: boolean;
    assignments?: boolean;
    featureFlags?: boolean;
    scenarioPolarity?: boolean;
    /**
     * The profile: the enabled plugins, in tab order; the explicit plugin
     * folders; a data-repo plugin folder to trust from now on.
     */
    plugins?: { enabled?: unknown; sources?: unknown; trust?: unknown; marketplaces?: unknown };
    /** A patch per plugin id to its own section (src/plugins/host/pluginSettings.ts). */
    pluginSettings?: unknown;
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
    body.useGhAccount === undefined &&
    body.showTestLinks === undefined &&
    body.openTestsInIdea === undefined &&
    body.projectManagement === undefined &&
    body.projectManagementTool === undefined &&
    body.publishExternalLinks === undefined &&
    body.ahaLinks === undefined &&
    body.ahaImport === undefined &&
    body.figmaLinks === undefined &&
    body.qtestLinks === undefined &&
    body.codeGen === undefined &&
    body.codeGenTarget === undefined &&
    body.deletePublished === undefined &&
    body.assignments === undefined &&
    body.featureFlags === undefined &&
    body.scenarioPolarity === undefined &&
    body.plugins === undefined &&
    body.pluginSettings === undefined &&
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
          "dataRepo, forgetDataRepo, reloadFrequencySeconds, scenarioPreviewLines, autosaveIntervalSeconds, gitEngine, useGhAccount, showTestLinks, openTestsInIdea, projectManagement, projectManagementTool, publishExternalLinks, ahaLinks, ahaImport, figmaLinks, qtestLinks, codeGen, codeGenTarget, deletePublished, assignments, featureFlags, scenarioPolarity, plugins, pluginSettings, roadmap, tasks, notebook, models, testing, googleCalendar, issues or syncServerUrl is required",
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
      // Data a newer app wrote (specs/app/data-format.feature.md) is flagged
      // before anything below writes to it; the pull further down re-checks.
      await checkDataFormat(pickedDir);
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
    // One entry per repository (specs/app/spec-folders.feature.md): the
    // picked folder replaces the url or folder it shares a repository with.
    state.recentDataRepos = await onePerRepo(state.recentDataRepos ?? [], getAppRoot());
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
    // Any other name the list kept for that repository goes with it, so it
    // never comes back in its place — the open folder excepted.
    const open = state.dataRepo && normalizeDataRepo(state.dataRepo);
    for (const entry of await sameRepoAs(target, state.recentDataRepos ?? [], getAppRoot())) {
      if (entry !== open) forgetDataRepo(state, entry);
    }
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
  // Use the GitHub CLI account while signed out
  // (specs/user-info-settings.feature.md): default ON, stored as an absent
  // key; signing out stores it OFF.
  if (body.useGhAccount !== undefined) {
    if (typeof body.useGhAccount !== "boolean") {
      return json({ error: "useGhAccount must be a boolean" }, 400);
    }
    if (body.useGhAccount) delete state.useGhAccount;
    else state.useGhAccount = false;
    setGhAccountEnabled(body.useGhAccount);
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
    // `qTest` is the program the test case links are written under
    // (specs/external-links/qtest-test-cases.feature.md).
    if (tool.toLowerCase() === QTEST_PROGRAM.toLowerCase()) {
      return json(
        { error: "qTest links test cases, not tickets — switch on qTest links instead" },
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
  // Aha! and Figma links (specs/external-links/aha-and-figma-links
  // .feature.md): opt-in — the default OFF is an absent key. Off only takes
  // the chips and fields away; links already recorded stay in the documents.
  // qTest test case links (specs/external-links/qtest-test-cases.feature.md)
  // and Import from Aha! (specs/external-links/aha-import.feature.md) switch
  // the same way.
  for (const key of ["ahaLinks", "ahaImport", "figmaLinks", "qtestLinks"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return json({ error: `${key} must be a boolean` }, 400);
    if (value) state[key] = true;
    else delete state[key];
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
    const target = normalizeCodeGenTarget(body.codeGenTarget, agentIds());
    if (target === null) {
      return json({ error: `codeGenTarget must be ${codeGenTargetList(agentIds())}` }, 400);
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
  // Feature flags (specs/app/feature-flags.feature.md): opt-in, the default
  // OFF an absent key. Off only hides the chips; flag lines stay in the files.
  if (body.featureFlags !== undefined) {
    if (typeof body.featureFlags !== "boolean") {
      return json({ error: "featureFlags must be a boolean" }, 400);
    }
    if (body.featureFlags) state.featureFlags = true;
    else delete state.featureFlags;
  }
  if (body.scenarioPolarity !== undefined) {
    if (typeof body.scenarioPolarity !== "boolean") {
      return json({ error: "scenarioPolarity must be a boolean" }, 400);
    }
    if (body.scenarioPolarity) state.scenarioPolarity = true;
    else delete state.scenarioPolarity;
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
  // A plugin's own settings (src/plugins/host/pluginSettings.ts): a patch
  // per id, checked for shape only — the plugin's route checks the keys.
  if (body.pluginSettings !== undefined) {
    if (!body.pluginSettings || typeof body.pluginSettings !== "object" || Array.isArray(body.pluginSettings)) {
      return json({ error: "pluginSettings must be an object of patches by plugin id" }, 400);
    }
    for (const [id, patch] of Object.entries(body.pluginSettings as Record<string, unknown>)) {
      const refusal = pluginPatchRefusal(patch);
      if (refusal) return json({ error: `pluginSettings.${id}: ${refusal}` }, 400);
    }
    for (const [id, patch] of Object.entries(body.pluginSettings as Record<string, unknown>)) {
      applyPluginPatch(raw, id, patch as Record<string, unknown>);
    }
  }
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
      if (incompatibility(dir)) throw new Error(incompatibility(dir)!.reason);
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
      if (incompatibility(dir)) throw new Error(incompatibility(dir)!.reason);
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

// Personal access token (git-operations.md "Personal access token"): the
// token is checked against the host's /user and becomes the app's sign-in.
// The first-run "Clone from GitHub" form and Settings both post here.
const postAuthToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; host?: unknown };
  if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
    return json({ error: "Paste a GitHub token" }, 400);
  }
  const host = normalizeGitHubHost(body.host);
  if (!host) return json({ error: "host must be a GitHub host name, like github.com or github.acme.com" }, 400);
  try {
    const identity = await signInWithToken(body.token, host);
    return json({ signedIn: true, login: identity.login, name: identity.name, email: identity.email, host });
  } catch {
    return json({ error: "GitHub did not accept this token — check it and its expiry" }, 400);
  }
};

/** A posted GitHub host: github.com when absent, a bare `name[:port]` otherwise; null when malformed. */
function normalizeGitHubHost(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return GITHUB_HOST;
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (host === "www.github.com") return GITHUB_HOST;
  return /^[a-z0-9.-]+(:\d+)?$/.test(host) ? host : null;
}

// Confluence (specs/external-links/confluence-wiki.feature.md): one personal
// access token per wiki, kept on this device (src/server/confluenceTokens.ts),
// checked against the wiki before it is kept. The list never carries a token.
const getConfluenceTokens: Handler = async () => json({ tokens: await listConfluenceTokens() });

const postConfluenceToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown; token?: unknown };
  if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
    return json({ error: "Paste a Confluence personal access token" }, 400);
  }
  const base = typeof body.base === "string" ? normalizeConfluenceBase(body.base) : null;
  if (!base) {
    return json({ error: "Enter the wiki's url, like https://wiki.acme.com or https://acme.com/wiki" }, 400);
  }
  try {
    const { user } = await validateToken(base, body.token.trim());
    await saveConfluenceToken({ base, token: body.token.trim(), user });
    return json({ base, user });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
};

const deleteConfluenceToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown };
  if (typeof body.base !== "string" || !body.base.trim()) return json({ error: "base is required" }, 400);
  await clearConfluenceToken(body.base);
  return json({ tokens: await listConfluenceTokens() });
};

// qTest (specs/external-links/qtest-test-cases.feature.md "A qTest token is
// kept per site on this device"): one bearer token per qTest site, kept on
// this device (src/server/qtestTokens.ts), checked against the site before
// it is kept. The list never carries a token.
const getQtestTokens: Handler = async () => json({ tokens: await listQtestTokens() });

const postQtestToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown; token?: unknown };
  const token = typeof body.token === "string" ? bareQtestToken(body.token) : "";
  if (!token || token.length > 1024) {
    return json({ error: "Paste a qTest Bearer token" }, 400);
  }
  const base = typeof body.base === "string" ? normalizeQtestBase(body.base) : null;
  if (!base) {
    return json({ error: "Enter the qTest site's url, like https://acme.qtestnet.com" }, 400);
  }
  try {
    const { user } = await validateQtestToken(base, token);
    await saveQtestToken({ base, token, user });
    return json({ base, user });
  } catch (e) {
    // What qTest answered goes along, for the error's detail box.
    const details = e instanceof QtestError ? e.details : undefined;
    return json({ error: (e as Error).message, ...(details ? { details } : {}) }, 400);
  }
};

const deleteQtestToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown };
  if (typeof body.base !== "string" || !body.base.trim()) return json({ error: "base is required" }, 400);
  await clearQtestToken(body.base);
  return json({ tokens: await listQtestTokens() });
};

// Aha! (specs/external-links/aha-import.feature.md "An Aha! API key is kept
// per site on this device"): one API key per Aha! site, kept on this device
// (src/server/ahaTokens.ts), checked against the site before it is kept.
// The list never carries a key.
const getAhaTokens: Handler = async () => json({ tokens: await listAhaTokens() });

const postAhaToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown; token?: unknown };
  if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
    return json({ error: "Paste an Aha! API key" }, 400);
  }
  const base = typeof body.base === "string" ? normalizeAhaBase(body.base) : null;
  if (!base) {
    return json({ error: "Enter the Aha! site's url, like https://acme.aha.io" }, 400);
  }
  try {
    const { user } = await validateAhaKey(base, body.token.trim());
    await saveAhaToken({ base, token: body.token.trim(), user });
    return json({ base, user });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
};

const deleteAhaToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown };
  if (typeof body.base !== "string" || !body.base.trim()) return json({ error: "base is required" }, 400);
  await clearAhaToken(body.base);
  return json({ tokens: await listAhaTokens() });
};

// (specs/external-links/aha-import.feature.md "Import a feature by its url",
// "Requirements become scenarios", "The feature links its Aha! record"): the
// Aha! feature the user names by its url — or its reference number against
// a site with a key — becomes a new feature file in the chosen folder, its
// requirements the scenarios, written the way createFeature writes a
// plugin's scaffold. The feature and each scenario then link their Aha!
// record on the document, like links added by hand, and Aha! links are
// switched on so the chips show. Only while Import from Aha! is switched on
// in Settings.
const postAhaImport = withDataDir(async (dir, req) => {
  if (!normalizeAhaImport((await readState(getAppRoot())).ahaImport)) {
    return json({ error: "Import from Aha! is off; switch it on in Settings → Aha!." }, 403);
  }
  const body = (await req.json().catch(() => ({}))) as {
    url?: unknown;
    base?: unknown;
    folder?: unknown;
    scope?: unknown;
  };
  const scope = body.scope ?? "requirements";
  if (!isAhaImportScope(scope)) return json({ error: "scope must be requirements or description" }, 400);
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  const ref = parseAhaRecordUrl(raw) ?? (typeof body.base === "string" ? parseAhaRef(raw, body.base) : null);
  if (!ref) {
    return json({ error: "Paste an Aha! feature url, like https://acme.aha.io/features/APP-123" }, 400);
  }
  if (ref.kind !== "feature") {
    return json({ error: `Only Aha! features can be imported for now; ${ref.ref} is an ${ref.kind}` }, 400);
  }
  const record = await ahaToken(ref.base);
  if (!record) {
    return json({ error: `No Aha! API key for ${ref.base} — add one in Settings → Aha!` }, 401);
  }
  const folder = typeof body.folder === "string" ? body.folder.trim().replace(/^\/+|\/+$/g, "") : "";
  let ahaFeature: Awaited<ReturnType<typeof getAhaFeature>>;
  try {
    ahaFeature = await getAhaFeature(ref.base, record.token, ref.ref);
  } catch (e) {
    if (e instanceof AhaError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 502);
  }
  const plan = planAhaImport(ahaFeature, scope);
  let fileName: string;
  try {
    fileName = await createFeature(
      dir,
      folder ? `${folder}/${plan.name}` : plan.name,
      plan.text,
      (n) => `Import feature from Aha!: ${n} (${ahaFeature.referenceNum})`,
    );
  } catch (e) {
    const message = (e as Error).message;
    const exists = message.match(/^Feature file already exists: (.+)$/);
    if (exists) return json({ error: `Already imported as ${exists[1]} — open it instead.`, fileName: exists[1] }, 409);
    return json({ error: message }, 400);
  }
  const warnings: string[] = [];
  try {
    await saveResourceLinks(dir, fileName, null, "aha", [plan.featureLink]);
    for (const s of plan.scenarioLinks) {
      await saveResourceLinks(dir, fileName, { name: s.name, version: s.version }, "aha", [s.link]);
    }
  } catch (e) {
    // The file is there; only the links back could not be written.
    warnings.push(`The Aha! links were not saved: ${(e as Error).message}`);
  }
  const state = await readState(getAppRoot());
  if (state.ahaLinks !== true) {
    state.ahaLinks = true;
    await writeState(state, getAppRoot());
  }
  return json(
    {
      fileName,
      title: plan.name,
      url: ahaFeature.url,
      reference: ahaFeature.referenceNum,
      scenarios: plan.scenarioLinks.length,
      ahaLinks: true,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    },
    201,
  );
});


// Jira (specs/external-links/jira-wiki-import.feature.md "A Jira token is
// kept per site on this device"): one personal access token per Jira site,
// kept on this device (src/server/jiraTokens.ts), checked against the site
// before it is kept. The list never carries a token.
const getJiraTokens: Handler = async () => json({ tokens: await listJiraTokens() });

const postJiraToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown; token?: unknown };
  if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 1024) {
    return json({ error: "Paste a Jira personal access token" }, 400);
  }
  const base = typeof body.base === "string" ? normalizeJiraBase(body.base) : null;
  if (!base) {
    return json({ error: "Enter the Jira site's url, like https://jira.acme.com or https://acme.com/jira" }, 400);
  }
  try {
    const { user } = await validateJiraToken(base, body.token.trim());
    await saveJiraToken({ base, token: body.token.trim(), user });
    return json({ base, user });
  } catch (e) {
    const details = e instanceof JiraError ? e.details : undefined;
    return json({ error: (e as Error).message, ...(details ? { details } : {}) }, 400);
  }
};

const deleteJiraToken: Handler = async (req) => {
  const body = (await req.json().catch(() => ({}))) as { base?: unknown };
  if (typeof body.base !== "string" || !body.base.trim()) return json({ error: "base is required" }, 400);
  await clearJiraToken(body.base);
  return json({ tokens: await listJiraTokens() });
};

// Import from Jira/Wiki (specs/external-links/jira-wiki-import.feature.md
// "A proposed title and scenarios, reviewed before the feature is written"):
// the urls the dialog collected — up to five Jira issues and five
// Confluence pages — are read with this device's tokens and handed to an
// agent plugin's one-shot turn, which proposes a title and up to fifteen
// scenarios; `exclude` names the ones already shown when the dialog asks
// for the rest. Nothing is written here: the review step creates the file.
// Not in the demo (no tokens, no agent) nor the hosted app.
const postImportPropose = withDataDir(async (dir, req) => {
  if (isDemoMode()) return json({ error: "Importing from Jira or Confluence is off in demo mode" }, 403);
  const body = (await req.json().catch(() => ({}))) as {
    sources?: unknown;
    agent?: unknown;
    model?: unknown;
    exclude?: unknown;
  };
  const urls = Array.isArray(body.sources) ? body.sources.filter((u): u is string => typeof u === "string") : [];
  if (urls.length === 0) return json({ error: "Add at least one Jira issue or Confluence page url" }, 400);
  if (urls.length > MAX_JIRA_SOURCES + MAX_WIKI_SOURCES) {
    return json({ error: `At most ${MAX_JIRA_SOURCES} Jira issues and ${MAX_WIKI_SOURCES} Confluence pages` }, 400);
  }
  const refs: SourceRef[] = [];
  for (const url of urls) {
    const ref = classifySource(url);
    if (!ref) return json({ error: `Not a Jira issue or Confluence page url: ${url}` }, 400);
    refs.push(ref);
  }
  const exclude = Array.isArray(body.exclude) ? body.exclude.filter((n): n is string => typeof n === "string") : [];
  const agent = typeof body.agent === "string" && body.agent ? body.agent : undefined;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !/^(?!-)[\w.:/@[\]-]{1,100}$/.test(model)) {
    return json({ error: `Not a model name: ${model.slice(0, 100)}` }, 400);
  }
  try {
    const sources = await readSources(refs);
    const proposal = await proposeFeature(sources, dir, { agent, exclude, ...(model ? { model } : {}) });
    const links: SourceLink[] = sources.map((s) => ({ kind: s.kind, url: s.url, title: s.title }));
    return json({ ...proposal, sources: links });
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 502);
  }
});

// The review step's "Create feature": the title and the scenarios the user
// kept become a new feature file in the chosen folder, each scenario
// proposed, the sources named under the title; committed and opened.
const postImportCreate = withDataDir(async (dir, req) => {
  if (isDemoMode()) return json({ error: "Importing from Jira or Confluence is off in demo mode" }, 403);
  const body = (await req.json().catch(() => ({}))) as {
    folder?: unknown;
    title?: unknown;
    scenarios?: unknown;
    sources?: unknown;
  };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return json({ error: "Give the feature a title" }, 400);
  const scenarios = Array.isArray(body.scenarios)
    ? (body.scenarios as { name?: unknown; body?: unknown; sources?: unknown }[]).flatMap((s) =>
        s && typeof s.name === "string" && s.name.trim()
          ? [
              {
                name: s.name,
                body: typeof s.body === "string" ? s.body : "",
                sources: Array.isArray(s.sources) ? s.sources.filter((x): x is string => typeof x === "string") : [],
              },
            ]
          : [],
      )
    : [];
  if (scenarios.length === 0) return json({ error: "Keep at least one scenario" }, 400);
  const sources: SourceLink[] = Array.isArray(body.sources)
    ? (body.sources as Partial<SourceLink>[]).flatMap((s) =>
        s && (s.kind === "jira" || s.kind === "wiki") && typeof s.url === "string" && typeof s.title === "string"
          ? [{ kind: s.kind, url: s.url, title: s.title }]
          : [],
      )
    : [];
  const folder = typeof body.folder === "string" ? body.folder.trim().replace(/^\/+|\/+$/g, "") : "";
  const plan = planImportedFeature(title, scenarios, sources);
  try {
    const fileName = await createFeature(
      dir,
      folder ? `${folder}/${plan.name}` : plan.name,
      plan.text,
      (n) => `Import feature from Jira/Wiki: ${n}`,
    );
    return json({ fileName, title: plan.name, scenarios: scenarios.length }, 201);
  } catch (e) {
    const message = (e as Error).message;
    const exists = message.match(/^Feature file already exists: (.+)$/);
    if (exists) return json({ error: `Already there as ${exists[1]} — open it instead.`, fileName: exists[1] }, 409);
    return json({ error: message }, 400);
  }
});


// Publish a feature as a Confluence page under a parent page: created the
// first time, a new version after that. The page is then linked from the
// feature — a `[Confluence:<id>](url)` line under its heading, saved the way
// the editor saves the qTest link. The page's version, and the parent it
// went under, are recorded in the feature's document — each feature its
// own parent, offered again next time, never in the markdown — so a page
// changed in Confluence since (its version past the record) is not replaced
// unless `force` says the user chose to: the conflict is answered as a 409
// the dialog turns into a question.
const postPublishConfluence = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => ({}))) as { parentUrl?: unknown; scope?: unknown; force?: unknown };
  const scope = body.scope ?? "all";
  const force = body.force === true;
  if (!isPublishScope(scope)) return json({ error: "scope must be all or published" }, 400);
  const parentUrl = typeof body.parentUrl === "string" ? body.parentUrl.trim() : "";
  const ref = parseParentPageUrl(parentUrl);
  if (!ref) {
    return json(
      { error: "Paste the parent page's url, like https://wiki.acme.com/spaces/ABC/pages/99999/Parent" },
      400,
    );
  }
  const record = await confluenceToken(ref.base);
  if (!record) {
    return json({ error: `No Confluence token for ${ref.base} — add one in Settings → Confluence` }, 401);
  }
  const view = await readFeatureView(dir, params.file!);
  if (!view) return json({ error: "Feature not found" }, 404);
  const feature = view.parsed;
  const title = (feature.name.trim() || titleFromFileName(params.file!)).slice(0, 255);
  const linked = feature.confluence;
  const existingPageId =
    linked && /^\d+$/.test(linked.ticket) && onBase(linked.url, ref.base) ? linked.ticket : undefined;
  // The version the app last published, when the record is that page's.
  const lastVersion =
    existingPageId !== undefined && feature.confluencePage?.id === existingPageId
      ? feature.confluencePage.version
      : undefined;
  // The page groups by polarity when the setting says so
  // (specs/ui/scenario-polarity.feature.md).
  const state = await readState(getAppRoot());
  const polarity = normalizeScenarioPolarity(state.scenarioPolarity);
  // The images the page shows (specs/images.feature.md) go up as its
  // attachments, each named by the bytes it holds: a stored name carries a
  // hash of the file as it was stored, and one edited in place since keeps
  // that name, so the page refers to such a file by the name its current
  // bytes earn. An attachment already there under the name is the same
  // file and is left alone.
  const rendered = renderFeatureStorage(feature, scope, { polarity });
  const images = await Promise.all(
    attachmentNames(rendered).map(async (stored) => {
      const bytes = await readImage(dir, stored);
      const name = bytes ? currentImageName(stored, bytes) : stored;
      return { stored, name, mime: imageMime(name), bytes };
    }),
  );
  const xhtml = renameAttachments(rendered, new Map(images.map((i) => [i.stored, i.name])));
  let page: PublishedPage;
  try {
    const parent = await resolveParent(ref.base, record.token, ref);
    page = await publishFeaturePage({
      base: ref.base,
      token: record.token,
      parent,
      title,
      body: xhtml,
      existingPageId,
      lastVersion,
      force,
    });
  } catch (e) {
    if (e instanceof ConfluenceConflict) return json({ error: e.message, conflict: e.conflict }, 409);
    // The client already logged the call that failed; the details go to the
    // dialog's detail box.
    if (e instanceof ConfluenceError) return json({ error: e.message, ...(e.details ? { details: e.details } : {}) }, e.status);
    confluenceLog.error("Publishing to Confluence failed", { "feature.file": params.file!, ...errorAttributes(e) });
    return json({ error: (e as Error).message }, 502);
  }
  // The page is published whether or not its images can be attached: a
  // failure here is reported as a warning, not an error.
  const warnings: string[] = [];
  const missing = images.filter((i) => i.bytes === null).map((i) => i.stored);
  if (missing.length > 0) warnings.push(`Not stored in the data repo, so not attached: ${missing.join(", ")}`);
  try {
    await attachFiles(
      ref.base,
      record.token,
      page.id,
      images.flatMap((i) => (i.bytes ? [{ name: i.name, mime: i.mime, bytes: i.bytes }] : [])),
    );
  } catch (e) {
    warnings.push(`The page's images were not attached: ${(e as Error).message}`);
  }
  const result = { id: page.id, url: page.url, created: page.created, version: page.version, title, parentUrl };
  const link = { program: CONFLUENCE_PROGRAM, ticket: page.id, url: page.url };
  const warned = () => (warnings.length > 0 ? { warning: warnings.join(" ") } : {});
  // The page's version now, kept in the document for the next publish's
  // check, with the parent for the next dialog; the link line is saved
  // first, as before, when it changed.
  const recorded = () => saveConfluencePage(dir, params.file!, { id: page.id, version: page.version, parentUrl });
  try {
    if (linked && linked.ticket === link.ticket && linked.url === link.url) {
      return json({ ...(await recorded()), ...result, ...warned(), message: "page link unchanged" });
    }
    const next: Feature = { ...feature, confluence: link };
    const saved = await saveFeature(dir, params.file!, serializeFeature(next));
    return json({ ...saved, ...(await recorded()), ...result, ...warned() });
  } catch (e) {
    // The page is in Confluence; only the link back could not be written.
    warnings.push(`The page link was not saved: ${(e as Error).message}`);
    return json({ ...view, ...result, ...warned() });
  }
});

// What "Publish to Confluence…" on a folder needs to know of its features
// (specs/external-links/confluence-wiki.feature.md "Publish a folder's
// features to Confluence"): each feature under the folder, its subfolders'
// included, with the page it links and the parent it was last published
// under. The dialog then publishes them one by one through the feature's
// own route.
const getFolderConfluence = withDataDir(async (dir, _req, params) => {
  const prefix = `${params.path!.replace(/\/+$/, "")}/`;
  const listed = (await listFeatures(dir)).filter((f) => f.fileName.startsWith(prefix));
  const features = await Promise.all(
    listed.map(async (f) => {
      const parsed = (await readFeatureView(dir, f.fileName))?.parsed;
      return {
        file: f.fileName,
        name: f.name,
        ...(parsed?.confluence ? { linkedUrl: parsed.confluence.url } : {}),
        ...(parsed?.confluencePage?.parentUrl ? { parentUrl: parsed.confluencePage.parentUrl } : {}),
      };
    }),
  );
  return json({ features });
});

// Create a feature's scenarios as qTest test cases
// (specs/external-links/qtest-test-cases.feature.md "Create qTest test cases
// from a feature"): one module named after the feature under the parent
// module the user names by its url, one test case per scenario — created
// the first time, updated after that. Each scenario then links its test
// case, and the feature its module, as `[qTest:…](url)` lines, saved the way
// the editor saves those links; the parent is remembered for next time.
const postPublishQtest = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => ({}))) as { parentUrl?: unknown; scope?: unknown };
  const scope = body.scope ?? "all";
  if (!isPublishScope(scope)) return json({ error: "scope must be all or published" }, 400);
  const parentUrl = typeof body.parentUrl === "string" ? body.parentUrl.trim() : "";
  const ref = parseModuleUrl(parentUrl);
  if (!ref) {
    return json(
      {
        error:
          "Paste the parent module's url from qTest, like https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901",
      },
      400,
    );
  }
  const record = await qtestToken(ref.base);
  if (!record) {
    return json({ error: `No qTest token for ${ref.base} — add one in Settings → qTest` }, 401);
  }
  const view = await readFeatureView(dir, params.file!);
  if (!view) return json({ error: "Feature not found" }, 404);
  const feature = view.parsed;
  const title = (feature.name.trim() || titleFromFileName(params.file!)).slice(0, 255);
  const linked = feature.qtest;
  const existingModuleId =
    linked && onQtestBase(linked.url, ref.base) ? (moduleIdFromUrl(linked.url) ?? undefined) : undefined;
  let result: Awaited<ReturnType<typeof publishFeatureTestCases>>;
  try {
    result = await publishFeatureTestCases({
      base: ref.base,
      token: record.token,
      projectId: ref.projectId,
      parentModuleId: ref.moduleId,
      feature,
      file: params.file!,
      title,
      scope,
      existingModuleId,
    });
  } catch (e) {
    if (e instanceof QtestError) return json({ error: e.message, ...(e.details ? { details: e.details } : {}) }, e.status);
    return json({ error: (e as Error).message }, 502);
  }
  const state = await readState(getAppRoot());
  if (state.qtestParentUrl !== parentUrl) {
    state.qtestParentUrl = parentUrl;
    await writeState(state, getAppRoot());
  }
  // What kept the test cases from being tied to the Jira issue's requirement
  // is a warning: the test cases are written and linked back either way.
  const warnings: string[] = [...result.notices];
  const summary = {
    module: { id: result.module.id, pid: result.module.pid, url: result.module.url, created: result.module.created },
    cases: result.cases.map(({ scenarioName, id, pid, url, created }) => ({ scenarioName, id, pid, url, created })),
    created: result.cases.filter((c) => c.created).length,
    updated: result.cases.filter((c) => !c.created).length,
    // The test cases left in the module for no scenario — deleted, so the module is the feature's scenarios.
    deleted: result.deleted.length,
    deletedCases: result.deleted.map(({ id, pid, name }) => ({ id, pid, name })),
    // The requirements of the feature's Jira issues the test cases cover, those that were found.
    ...(result.requirements.length > 0 ? { requirements: result.requirements } : {}),
    title,
    parentUrl,
    // The test case qTest refused: the dialog stays open on it, with its details.
    ...(result.failed
      ? {
          failure: {
            scenarioName: result.failed.scenarioName,
            message: `${result.cases.length} of the test cases were written; “${result.failed.scenarioName}” was not: ${result.failed.error}`,
            ...(result.failed.details ? { details: result.failed.details } : {}),
          },
        }
      : {}),
  };
  const warned = () => (warnings.length > 0 ? { warning: warnings.join(" ") } : {});
  // The links back: the module on the feature, each test case on its scenario.
  const moduleLink = { program: QTEST_PROGRAM, ticket: result.module.pid, url: result.module.url };
  // A scenario left out of scope whose test case was deleted from the module loses its link.
  const scenarios = feature.scenarios.map((s, index) => {
    const written = result.cases.find((c) => c.index === index);
    if (written) return { ...s, qtest: { program: QTEST_PROGRAM, ticket: written.pid, url: written.url } };
    if (!result.unlinked.includes(index)) return s;
    const { qtest: _gone, ...rest } = s;
    return rest;
  });
  const next: Feature = { ...feature, qtest: moduleLink, scenarios };
  // The module and the parent it went under, kept in the document so the
  // dialog offers this feature that parent next time; the link lines are
  // saved first, as before, when they changed.
  const recorded = () => saveQtestModule(dir, params.file!, { id: result.module.id, parentUrl });
  if (serializeFeature(next) === serializeFeature(feature)) {
    return json({ ...(await recorded()), ...summary, ...warned(), message: "test case links unchanged" });
  }
  try {
    await saveFeature(dir, params.file!, serializeFeature(next));
    return json({ ...(await recorded()), ...summary, ...warned() });
  } catch (e) {
    // The test cases are in qTest; only the links back could not be written.
    warnings.push(`The test case links were not saved: ${(e as Error).message}`);
    return json({ ...view, ...summary, ...warned() });
  }
});

// Signing out (specs/user-info-settings.feature.md "sign out from the user
// menu") also stops the app falling back to the GitHub CLI's account, so the
// app is signed out rather than quietly signed in as gh's user; Settings
// turns it back on.
const deleteAuth: Handler = async () => {
  await signOut();
  const state = await readState(getAppRoot());
  state.useGhAccount = false;
  await writeState(state, getAppRoot());
  setGhAccountEnabled(false);
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
    // What each described folder's display-name.txt says (specs/ui/
    // folders.feature.md "describe a folder") — the sidebar's label for it.
    folderDescriptions: await listFolderDescriptions(dir),
    // Each folder's subfolder order, from its folder-order.txt (specs/ui/
    // folders.feature.md "order folders") — how the sidebar sorts them.
    folderOrders: await listFolderOrders(dir),
    // Each folder's feature order, from its feature-order.txt (specs/ui/
    // folders.feature.md "order features") — how the sidebar sorts them.
    featureOrders: await listFeatureOrders(dir),
    members: settings.members,
    codeRepo: settings.codeRepo,
    // Every code repo (specs/app/project-settings.feature.md), the default
    // first — the folders the agent pane offers a session.
    codeRepos: [...settings.codeRepos].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map((r) => r.dir),
    // Authorship in the feature files (specs/app/specs-authorship.feature.md)
    // — a setting of the data repo, so it comes with the repo's listing.
    authorsInMarkdown: settings.authorsInMarkdown,
    // GitHub issue tracking (specs/app/github-issues.feature.md): the
    // repository the code repo pushes to, when it is a GitHub one — the
    // Issues tab shows for it, and only for it. readIssuesRepo answers for
    // the demo too, which names its repo outright (demo.ts).
    issuesRepo: await readIssuesRepo(dir),
    // The custom attribute definitions (specs/app/custom-attributes.feature.md):
    // the data repo's custom-attributes.txt as written, so a teammate's
    // definitions arriving with a pull reach the editors on the next tick.
    customAttributes: await readCustomAttributes(dir),
  });
});

// The data repo's own settings (specs/app/project-settings.feature.md): its
// project-settings.json as the Project settings page shows it — the members,
// each code repo with whether its folder is there and the state of its
// `specs` symlink, which one is the default, and the authorship switch.
async function projectSettingsPayload(dir: string, settings?: ProjectSettings) {
  const current = settings ?? (await readProjectSettings(dir));
  const codeRepos = await Promise.all(
    current.codeRepos.map(async (repo) => ({
      path: repo.path,
      dir: repo.dir,
      isDefault: repo.isDefault,
      // A folder a clone is still making is not there yet: git makes it
      // first and fills it in after.
      exists: (await directoryExists(repo.dir)) && codeRepoCloneJob(repo.dir)?.state !== "running",
      specsLink: await specsLinkStatus(repo.dir, dir),
    })),
  );
  // A folder that is not there can be cloned (codeRepoClone.ts): the url
  // the app suggests, and the clone running or failed, if any.
  const cloneRows = await Promise.all(
    codeRepos.map(async (repo) => {
      if (repo.exists) return repo;
      const job = codeRepoCloneJob(repo.dir);
      return { ...repo, cloneUrl: job?.url ?? (await suggestedCloneUrl(dir, repo.dir)), clone: job };
    }),
  );
  return {
    file: `${dir}/${PROJECT_SETTINGS_FILE}`,
    members: current.members,
    codeRepos: cloneRows,
    defaultCodeRepo: current.defaultCodeRepo,
    authorsInMarkdown: current.authorsInMarkdown,
    // The demo's dataset and the read-only site's snapshot are nobody's to
    // edit; a hosted worker has no code checkout to link.
    canEdit: !isDemoMode() && !isReadOnlyMode(),
    canLink: !isDemoMode() && !isReadOnlyMode() && !isHostedMode(),
    canChooseFolder: canChooseFolder() && !isHostedMode(),
    canClone: !isDemoMode() && !isReadOnlyMode() && !isHostedMode(),
  };
}

const getProjectSettings = withDataDir(async (dir) => json(await projectSettingsPayload(dir)));

// Change the data repo's settings: any of `authorsInMarkdown`
// (specs/app/specs-authorship.feature.md — every `.feature.md` is
// reprojected on the spot, as the "Publish external links" switch does),
// `members`, `codeRepos` with `defaultCodeRepo`. Written into the repo, so
// every teammate's app sees the same; the reload cron commits and pushes it
// like any saved change. The demo keeps its authorship switch alone.
const putProjectSettings = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as {
    authorsInMarkdown?: unknown;
    members?: unknown;
    codeRepos?: unknown;
    defaultCodeRepo?: unknown;
  } | null;
  if (!body || typeof body !== "object") return json({ error: "a JSON object is required" }, 400);
  const hasAuthors = body.authorsInMarkdown !== undefined;
  const hasMembers = body.members !== undefined;
  const hasRepos = body.codeRepos !== undefined || body.defaultCodeRepo !== undefined;
  if (!hasAuthors && !hasMembers && !hasRepos) {
    return json({ error: "nothing to change: authorsInMarkdown, members or codeRepos" }, 400);
  }
  if (hasAuthors && typeof body.authorsInMarkdown !== "boolean") {
    return json({ error: "authorsInMarkdown must be a boolean" }, 400);
  }
  if (hasMembers && !Array.isArray(body.members)) return json({ error: "members must be a list" }, 400);
  if (body.codeRepos !== undefined && !(Array.isArray(body.codeRepos) && body.codeRepos.every((p) => typeof p === "string"))) {
    return json({ error: "codeRepos must be a list of paths" }, 400);
  }
  if (body.defaultCodeRepo !== undefined && body.defaultCodeRepo !== null && typeof body.defaultCodeRepo !== "string") {
    return json({ error: "defaultCodeRepo must be a path or null" }, 400);
  }
  if ((hasMembers || hasRepos) && (isDemoMode() || isReadOnlyMode())) {
    return json({ error: "The demo's project settings cannot be changed" }, 403);
  }
  try {
    if (hasAuthors && (await writeAuthorsInMarkdown(dir, body.authorsInMarkdown as boolean))) {
      const changed = await reprojectFeatures(dir);
      reloadLog.info(
        `authors ${body.authorsInMarkdown ? "written into" : "withheld from"} ${changed} feature file(s)`,
      );
    }
    if (hasMembers) await writeMembers(dir, body.members as unknown[]);
    if (hasRepos) {
      const current = await readProjectSettings(dir);
      const paths = (body.codeRepos as string[] | undefined) ?? current.codeRepos.map((r) => r.path);
      const main =
        body.defaultCodeRepo === undefined ? current.defaultCodeRepo : (body.defaultCodeRepo as string | null);
      await writeCodeRepos(dir, paths, main);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  return json(await projectSettingsPayload(dir));
});

// A code repo's `specs` symlink (src/server/specsLink.ts): `create` or
// `remove` it for the repo `codeRepo` names, as the settings hold the path.
const postSpecsLink = withDataDir(async (dir, req) => {
  if (isDemoMode() || isReadOnlyMode()) return json({ error: "Symlinks cannot be changed in demo mode" }, 403);
  const body = (await req.json().catch(() => null)) as { codeRepo?: unknown; action?: unknown } | null;
  if (typeof body?.codeRepo !== "string" || (body.action !== "create" && body.action !== "remove")) {
    return json({ error: "codeRepo and action (create or remove) are required" }, 400);
  }
  const settings = await readProjectSettings(dir);
  const repo = settings.codeRepos.find((r) => r.path === body.codeRepo || r.dir === body.codeRepo);
  if (!repo) return json({ error: `Not one of the project's code repos: ${body.codeRepo}` }, 404);
  try {
    if (body.action === "create") await createSpecsLink(repo.dir, dir);
    else await removeSpecsLink(repo.dir, dir);
  } catch (e) {
    if (e instanceof SpecsLinkError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
  return json(await projectSettingsPayload(dir, settings));
});

// Clone a code repo that is not on this computer (src/server/codeRepoClone.ts)
// into the folder its path resolves to, from `url`. Answers at once with the
// clone running; the page polls GET until the folder is there or it failed.
const postCodeRepoClone = withDataDir(async (dir, req) => {
  if (isDemoMode() || isReadOnlyMode()) return json({ error: "Code repos cannot be cloned in demo mode" }, 403);
  const body = (await req.json().catch(() => null)) as { codeRepo?: unknown; url?: unknown } | null;
  if (typeof body?.codeRepo !== "string" || typeof body.url !== "string") {
    return json({ error: "codeRepo and url are required" }, 400);
  }
  const settings = await readProjectSettings(dir);
  const repo = settings.codeRepos.find((r) => r.path === body.codeRepo || r.dir === body.codeRepo);
  if (!repo) return json({ error: `Not one of the project's code repos: ${body.codeRepo}` }, 404);
  try {
    await startCodeRepoClone(repo.dir, body.url);
  } catch (e) {
    if (e instanceof CodeRepoCloneError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
  return json(await projectSettingsPayload(dir, settings));
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

// Settings → Custom attributes' autosave (specs/app/custom-attributes.feature.md
// "Custom attributes are defined in Settings"): a local write the reload
// cron commits and pushes, like the README's. `from` folds in a disk edit
// the editor has not shown. A file with problems is saved too.
const putCustomAttributes = withDataDir(async (dir, req) => {
  const body = (await req.json().catch(() => null)) as { content?: unknown; from?: unknown } | null;
  if (typeof body?.content !== "string") return json({ error: "content is required" }, 400);
  const from = typeof body.from === "string" ? body.from : undefined;
  try {
    return json({ content: await writeCustomAttributes(dir, body.content, from) });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// An agent's model list in Settings (specs/agents/agent-plugins.feature.md "Each agent
// offers the models the data repo lists"): one agent's list, replaced whole.
// A local write the reload cron commits and pushes, like custom attributes.
const putAgentModels = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => null)) as { models?: unknown } | null;
  try {
    return json({ agentModels: checkedAgentModels(await writeAgentModels(dir, params.agent ?? "", body?.models)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
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

// specs/external-links/project-management-jira-linear-etc.feature.md
// "Several tickets on a feature": the whole list of a feature's tickets.
// The rows are checked for shape here; the cap, repeats and the kinds that
// are not tickets are saveFeatureTickets' to refuse.
const putTickets = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => ({}))) as { links?: unknown };
  const rows = body.links;
  const wellFormed =
    Array.isArray(rows) &&
    rows.every(
      (r) =>
        r &&
        typeof r === "object" &&
        typeof (r as ExternalLink).program === "string" &&
        typeof (r as ExternalLink).ticket === "string" &&
        typeof (r as ExternalLink).url === "string" &&
        /^https?:\/\//.test((r as ExternalLink).url.trim()),
    );
  if (!wellFormed) {
    return json({ error: "links must be a list of { program, ticket, url } tickets with http(s) urls" }, 400);
  }
  const links = (rows as ExternalLink[]).map((r) => ({
    program: r.program.trim(),
    ticket: r.ticket.trim(),
    url: r.url.trim(),
  }));
  try {
    return json(await saveFeatureTickets(dir, params.file!, links));
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

// specs/external-links/aha-and-figma-links.feature.md: the Aha! records or
// Figma designs linked to a feature (no `scenario` in the body) or to one of
// its scenarios — `:kind` is `aha` or `figma`. A document-only write like
// the pull requests': the whole list is sent and the document brought to it
// by url.
const putResourceLinks = withDataDir(async (dir, req, params) => {
  const kind = params.kind;
  if (!isResourceLinkKind(kind)) {
    return json({ error: `kind must be ${RESOURCE_LINK_KINDS.join(" or ")}` }, 404);
  }
  const body = (await req.json()) as {
    scenario?: { name?: string; version?: number; id?: string } | null;
    links?: unknown;
  };
  // The same rows a pull request list takes: an http(s) url and a title.
  const links = validPullRequests(body.links);
  if (links === null) {
    return json({ error: "links must be a list of { url, title } with http(s) urls" }, 400);
  }
  let target: ScenarioTarget | null = null;
  if (body.scenario) {
    const { name, version, id } = body.scenario;
    if (typeof name !== "string" || typeof version !== "number") {
      return json({ error: "scenario needs a name and a version" }, 400);
    }
    target = { name: name.trim(), version, ...(typeof id === "string" ? { id } : {}) };
  }
  try {
    return json(await saveResourceLinks(dir, params.file!, target, kind, links));
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

// specs/ui/navigation.feature.md "delete several scenarios at once": the
// scenarios picked in the sidebar tree, all of one feature, removed in one
// go — each by what it is, as its own Delete would. Published ones only
// while the Settings switch is on, the same gate delete-published keeps.
const postDeleteScenarios = withDataDir(async (dir, req, params) => {
  const body = (await req.json().catch(() => ({}))) as { scenarios?: unknown };
  const rows = body.scenarios;
  const wellFormed =
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (r) =>
        r &&
        typeof r === "object" &&
        typeof (r as { name?: unknown }).name === "string" &&
        typeof (r as { version?: unknown }).version === "number",
    );
  if (!wellFormed) return json({ error: "scenarios must be a list of { name, version }" }, 400);
  const targets = (rows as { name: string; version: number }[]).map((r) => ({
    name: r.name.trim(),
    version: r.version,
  }));
  const allowPublished = normalizeDeletePublished((await readState(getAppRoot())).deletePublished);
  try {
    return json(await deleteScenarios(dir, params.file!, targets, allowPublished));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof PublishedLockedError ? 403 : 400);
  }
});

// specs/editor/spec-editor.feature.md "Unpublish a Spec": moving a published
// scenario back to [proposed] is allowed on the same terms as deleting one —
// only while the Settings switch is on, enforced here as delete-published
// enforces it. The demotion is committed and pushed right away.
const postUnpublish = withDataDir(async (dir, req, params) => {
  if (!normalizeDeletePublished((await readState(getAppRoot())).deletePublished)) {
    return json({ error: "Changing published scenarios is switched off in Settings" }, 403);
  }
  const body = (await req.json()) as { scenario?: ScenarioBody };
  const target = scenarioTarget(body.scenario);
  if (!target) return json({ error: "scenario needs a name and a version" }, 400);
  try {
    return json(await unpublishScenario(dir, params.file!, target));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/navigation.feature.md "move a scenario to another feature": the
// scenario menu's Move to…, and a drag onto another feature ("drag a scenario
// to another feature") — offered on the same terms as its Delete, so a
// published scenario moves only while Settings allows deleting published
// ones, enforced here as delete-published enforces it.
const postMoveScenario = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { scenario?: ScenarioBody; to?: unknown; at?: unknown };
  const target = scenarioTarget(body.scenario);
  if (!target) return json({ error: "scenario needs a name and a version" }, 400);
  if (typeof body.to !== "string") return json({ error: "to is required" }, 400);
  // Where a drag dropped it in the target (optional): next to a scenario there.
  const place = scenarioTargetOf(body.at);
  const at = place && {
    name: place.name,
    version: place.version,
    after: (body.at as { after?: unknown }).after === true,
  };
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
    return json(await moveScenario(dir, params.file!, target, body.to, at ?? undefined));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/navigation.feature.md "clone a scenario": the scenario menus'
// Clone — a draft copy right after the scenario, saved locally like any
// edit. Answers the feature's editor view and the copy's name and version.
const postCloneScenario = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { scenario?: ScenarioBody };
  const target = scenarioTarget(body.scenario);
  if (!target) return json({ error: "scenario needs a name and a version" }, 400);
  try {
    return json(await cloneScenario(dir, params.file!, target));
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

// `?force=true` deletes a folder with features in it — a `git rm -r`,
// committed and pushed (specs/ui/folders.feature.md "delete a folder with
// features in it"); without it only an empty folder goes.
const deleteFolderRoute = withDataDir(async (dir, req, params) => {
  try {
    const force = new URL(req.url).searchParams.get("force") === "true";
    return json(await deleteFolder(dir, params.path!, { force }));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Move a folder under another parent (specs/ui/folders.feature.md "move a
// folder"): a `git mv` of the directory and its features' documents,
// committed and pushed. A blank parent is the top level.
const postMoveFolder = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { parent?: string };
  try {
    return json(await moveFolder(dir, params.path!, body.parent ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// Rename a folder (specs/ui/folders.feature.md "rename a folder"): a `git
// mv` of the directory and its features' documents, committed and pushed.
const postRenameFolder = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { name?: string };
  try {
    return json(await renameFolder(dir, params.path!, body.name ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/folders.feature.md "edit a folder's display name": writes the
// folder's display-name.txt (or removes it for a blank name), committed and
// pushed.
const putFolderDescription = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { description?: string };
  try {
    return json(await setFolderDescription(dir, params.path!, body.description ?? ""));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/folders.feature.md "order folders": writes the folder's
// folder-order.txt — its subfolders, one per line, in the order the sidebar
// shows them — committed and pushed. `specs` orders the top level.
const putFolderOrder = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { folders?: unknown };
  if (!Array.isArray(body.folders)) return json({ error: "folders must be a list of folder names" }, 400);
  try {
    return json(await setFolderOrder(dir, params.path!, body.folders as string[]));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});

// specs/ui/folders.feature.md "order features": writes the folder's
// feature-order.txt — its features' file names, one per line, in the order
// the sidebar shows them — committed and pushed. `specs` orders the top level.
const putFeatureOrder = withDataDir(async (dir, req, params) => {
  const body = (await req.json()) as { features?: unknown };
  if (!Array.isArray(body.features)) return json({ error: "features must be a list of feature file names" }, 400);
  try {
    return json(await setFeatureOrder(dir, params.path!, body.features as string[]));
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

// Unused images (specs/app/unused-images.feature.md): every stored image
// with the files that reference it, and a delete of the ones the user picked
// — refused, 409, for any a file references by the time the request lands.
const getImages = withDataDir(async (dir) => json({ images: await listImages(dir) }));

const deleteImagesRoute = withDataDir(async (dir, req) => {
  try {
    const body = await bodyOf(req);
    const names = body.names;
    if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string")) {
      throw new Error("A non-empty 'names' list is required");
    }
    return json(await deleteImages(dir, names as string[]));
  } catch (e) {
    if (e instanceof StillReferenced) return json({ error: e.message, referenced: e.referenced }, 409);
    return json({ error: (e as Error).message }, 400);
  }
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

/** The registered agents' ids, by rank. */
function agentIds(): string[] {
  return agents.list().map((p) => p.id);
}

/** The agents as an error message lists them: "claude, codex or pi". */
function chatAgentList(): string {
  const ids = agentIds();
  if (ids.length === 0) return "(no agent plugin is installed)";
  return ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(", ")} or ${ids.at(-1)}`;
}

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
      { error: `Code repo not found: ${codeRepo} (the default code repo in Project settings)` },
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
  const target = normalizeCodeGenTarget(body.target, agentIds());
  if (target === null) return json({ error: `target must be ${codeGenTargetList(agentIds())}` }, 400);
  const { name, specs, place, sections } = resolved;
  // The pane (specs/agents/agent-pane.feature.md): the prompt opens a
  // live chat in the app with the named agent; the client shows it and the
  // conversation goes on.
  if (target !== "desktop") {
    const missing = missingAgent(target);
    if (missing) return missing;
    try {
      const meta = await createChatSession({
        place,
        name,
        agent: target,
        prompt: buildSessionPrompt(name, specs, place, sections),
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

/** The refusal for an agent no plugin provides or whose CLI is not on PATH, or null. */
function missingAgent(agent?: ChatAgent): Response | null {
  try {
    resolveProvider(agent);
    return null;
  } catch (e) {
    return chatError(e);
  }
}

/** Where a pane session runs, or the refusal: switched off, no CLI, no repo. */
async function agentPanePlace(
  dir: string,
  agent: ChatAgent | undefined,
  cwd?: string,
): Promise<SessionPlace | Response> {
  if (!normalizeCodeGen((await readState(getAppRoot())).codeGen)) {
    return json({ error: "Code generation is switched off in Settings" }, 403);
  }
  const missing = missingAgent(agent);
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
      { error: `Code repo not found: ${codeRepo} (the default code repo in Project settings)` },
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
    cwd?: unknown;
    model?: unknown;
    effort?: unknown;
    images?: unknown;
    worktree?: unknown;
  };
  if (body.worktree !== undefined && typeof body.worktree !== "boolean") {
    return json({ error: "worktree must be true or false" }, 400);
  }
  // Which agent drives the chat; absent is the first one whose CLI is there.
  let agent: ChatAgent | undefined;
  if (body.agent !== undefined) {
    if (typeof body.agent !== "string" || !agents.get(body.agent)) {
      return json({ error: `agent must be ${chatAgentList()}` }, 400);
    }
    agent = body.agent;
  }
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
  // The model and effort the pane picked; absent, the agent's defaults.
  let model: string | null = null;
  if (body.model !== undefined && body.model !== null && body.model !== "") {
    model = normalizeModel(body.model);
    if (model === null) return json({ error: MODEL_ERROR }, 400);
  }
  let effort: ReturnType<typeof normalizeEffort> = null;
  if (body.effort !== undefined && body.effort !== null) {
    effort = normalizeEffort(body.effort);
    if (effort === null) return json({ error: EFFORT_ERROR }, 400);
  }
  try {
    // Pasted with the first message; checked (and refused) by the engine.
    const images = checkImages(body.images);
    const meta = await createChatSession({
      place,
      name,
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
      ...(images.length ? { images: images.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name ? { name } : {}) })) } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      sessionsDir: await sessionsDirectory(getAppRoot()),
      // A worktree of its own (src/server/agentWorktree.ts), beside the
      // session records and outside every repo.
      ...(body.worktree === true ? { worktreesDir: join(await settingsDirectory(getAppRoot()), WORKTREES_SUBDIR) } : {}),
    });
    return json(meta);
  } catch (e) {
    return chatError(e);
  }
});

const MODE_ERROR = `permissionMode must be one of ${PERMISSION_MODES.join(", ")}`;
const MODEL_ERROR = "model must be a model alias such as sonnet, or a model id, with no spaces";
const EFFORT_ERROR = `effort must be one of ${EFFORT_LEVELS.join(", ")}`;

/** A model in a body: a model id, null or "" for the agent's default, or the refusal. */
function modelOf(value: unknown): { model: string | null } | Response {
  if (value === null || value === "") return { model: null };
  const model = normalizeModel(value);
  return model === null ? json({ error: MODEL_ERROR }, 400) : { model };
}

/** An effort in a body: a level, null for the agent's default, or the refusal. */
function effortOf(value: unknown): { effort: ReturnType<typeof normalizeEffort> } | Response {
  if (value === null) return { effort: null };
  const effort = normalizeEffort(value);
  return effort === null ? json({ error: EFFORT_ERROR }, 400) : { effort };
}

// A hosted worker runs no agents; its pane lists none rather than refusing,
// so the client's boot-time restore stays quiet (src/server/hostedMode.ts).
const getAgentChats: Handler = () =>
  json({ sessions: isHostedMode() || isReadOnlyMode() ? [] : listChatSessions() });

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
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; images?: unknown };
  // Images may come without text (specs/agents/agent-pane.feature.md "Paste
  // an image into the message").
  if (typeof body.text !== "string" && body.images === undefined) return json({ error: "text is required" }, 400);
  if (body.text !== undefined && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
  try {
    return json({ event: await sendChatMessage(params.id!, (body.text as string | undefined) ?? "", body.images) });
  } catch (e) {
    return chatError(e);
  }
};

// An image pasted into a session's message: the user bubble shows it. The
// id is the engine's; the file never changes once written.
const getAgentChatImage: Handler = async (_req, params) => {
  let image: ReturnType<typeof getChatImage>;
  try {
    image = getChatImage(params.id!, params.imageId!);
  } catch (e) {
    return chatError(e);
  }
  if (!image) return json({ error: "image not found" }, 404);
  const bytes = await readFile(image.path).catch(() => null);
  if (bytes === null) return json({ error: "image not found" }, 404);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": image.mediaType,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
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

const putAgentChatModel: Handler = async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as { model?: unknown };
  const parsed = modelOf(body.model);
  if (parsed instanceof Response) return parsed;
  try {
    await setChatModel(params.id!, parsed.model);
    return json({ meta: getChatSession(params.id!) });
  } catch (e) {
    return chatError(e);
  }
};

const putAgentChatEffort: Handler = async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as { effort?: unknown };
  const parsed = effortOf(body.effort);
  if (parsed instanceof Response) return parsed;
  try {
    await setChatEffort(params.id!, parsed.effort);
    return json({ meta: getChatSession(params.id!) });
  } catch (e) {
    return chatError(e);
  }
};

// The models an agent offers and what a new session starts on, for the
// pane's model and effort pickers; null for an agent with none.
const getAgentChoices: Handler = async (_req, params) => {
  try {
    return json({ choices: await agentChoices(params.agent!, await currentDataDir()) });
  } catch (e) {
    return chatError(e);
  }
};

// A pick in the new-session bar: what the agent's next sessions start on.
const putAgentDefaults: Handler = async (req, params) => {
  const body = (await req.json().catch(() => null)) as { model?: unknown; effort?: unknown } | null;
  const patch: AgentDefaultsPatch = {};
  if (body && body.model !== undefined) {
    const parsed = modelOf(body.model);
    if (parsed instanceof Response) return parsed;
    patch.model = parsed.model;
  }
  if (body && body.effort !== undefined) {
    const parsed = effortOf(body.effort);
    if (parsed instanceof Response) return parsed;
    patch.effort = parsed.effort;
  }
  if (Object.keys(patch).length === 0) return json({ error: "model or effort is required" }, 400);
  try {
    await setAgentDefaults(params.agent!, patch);
    return json({ choices: await agentChoices(params.agent!, await currentDataDir()) });
  } catch (e) {
    return chatError(e);
  }
};

// What the new-session bar needs to offer a worktree for a folder: whether
// it is in a git repo with a commit, and the branch checked out there.
const getAgentFolder: Handler = async (req) => {
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  if (!isAbsolute(raw)) return json({ error: "path must be an absolute path" }, 400);
  if (!(await directoryExists(raw))) return json({ error: `Folder not found: ${raw}` }, 404);
  return json(await folderGitInfo(resolve(raw)));
};

const deleteAgentChat: Handler = async (_req, params) => {
  try {
    // With a worktree, whether it was removed or kept for its changes.
    return json({ ok: true, ...(await endChatSession(params.id!)) });
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

// Add the spec repo to a code repo as a git submodule
// (specs/app/code-repo-submodule.feature.md; src/server/submodule.ts).
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

/** 403 in demo mode — the demo cannot change itself. */
const unlessDemoUpdate =
  (handler: Handler): Handler =>
  (req, params) =>
    isDemoMode() ? json({ error: "The demo cannot update itself" }, 403) : handler(req, params);

const appUpdate = appUpdateHandlers();

/** 403 in demo mode — the demo has no Claude to sign in. */
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
  if (isReadOnlyMode()) return json({ name: null, reason: "Test names are not read from GitHub here." });
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
  // The read-only site spends no GitHub rate limit on a visitor's page.
  if (isReadOnlyMode()) {
    const answer: PullRequestLookup = { title: null, reason: "Pull requests are not read from GitHub here." };
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
    return json({ error: "No code repo: add one in Project settings (the user menu)" }, 400);
  }
  if (!(await directoryExists(codeRepo))) {
    return json({ error: `Code repo not found: ${codeRepo} (the default code repo in Project settings)` }, 400);
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
  // Check for Updates (src/server/appUpdate.ts): the desktop app updating
  // itself. Neither the demo nor a hosted worker installs anything.
  ["GET", "/api/app-update", unlessHosted(unlessDemoUpdate(appUpdate.index!))],
  ["POST", "/api/app-update/check", unlessHosted(unlessDemoUpdate(appUpdate.check!))],
  ["POST", "/api/app-update/install", unlessHosted(unlessDemoUpdate(appUpdate.install!))],
  ["POST", "/api/app-update/restart", unlessHosted(unlessDemoUpdate(appUpdate.restart!))],
  ["GET", "/api/plugins/marketplaces", market.getMarketplaces],
  ["POST", "/api/plugins/marketplaces/:name/reclone", unlessHosted(market.postReclone)],
  ["POST", "/api/plugins/install", unlessHosted(market.postInstall)],
  ["POST", "/api/plugins/:id/update", unlessHosted(market.postUpdate)],
  ["DELETE", "/api/plugins/:id", unlessHosted(market.deletePlugin)],
  ["POST", "/api/choose-folder", unlessHosted(postChooseFolder)],
  ["GET", "/api/confluence/tokens", unlessHosted(getConfluenceTokens)],
  ["POST", "/api/confluence/tokens", unlessHosted(postConfluenceToken)],
  ["DELETE", "/api/confluence/tokens", unlessHosted(deleteConfluenceToken)],
  ["GET", "/api/qtest/tokens", unlessHosted(getQtestTokens)],
  ["POST", "/api/qtest/tokens", unlessHosted(postQtestToken)],
  ["DELETE", "/api/qtest/tokens", unlessHosted(deleteQtestToken)],
  ["GET", "/api/aha/tokens", unlessHosted(getAhaTokens)],
  ["POST", "/api/aha/tokens", unlessHosted(postAhaToken)],
  ["DELETE", "/api/aha/tokens", unlessHosted(deleteAhaToken)],
  ["POST", "/api/aha/import", unlessHosted(postAhaImport)],
  ["GET", "/api/jira/tokens", unlessHosted(getJiraTokens)],
  ["POST", "/api/jira/tokens", unlessHosted(postJiraToken)],
  ["DELETE", "/api/jira/tokens", unlessHosted(deleteJiraToken)],
  ["POST", "/api/import/propose", unlessHosted(postImportPropose)],
  ["POST", "/api/import/create", unlessHosted(postImportCreate)],
  // Claude sign-in: the Claude agent plugin's routes (/api/claude/*),
  // there while the plugin is installed and on.
  ["POST", "/api/reload", postReload],
  // Observability (src/server/logs.ts): the app's own log, and its verbosity.
  ["GET", "/api/logs", getLogs],
  ["GET", "/api/logs/settings", getLogSettings],
  ["PUT", "/api/logs/settings", putLogSettings],
  // Data viewer (src/server/dataViewer.ts): the Automerge store browsed
  // read-only as tables, documents and their history.
  ["GET", "/api/data/tables", withDataDir(getDataTables)],
  ["GET", "/api/data/tables/:table", withDataDir(getDataTable)],
  ["GET", "/api/data/doc", withDataDir(getDataDoc)],
  ["GET", "/api/data/doc/history", withDataDir(getDataDocHistory)],
  ["GET", "/api/data/doc/at", withDataDir(getDataDocAt)],
  ["POST", "/api/auth/github/start", unlessHosted(unlessDemo(postAuthStart))],
  ["POST", "/api/auth/github/poll", unlessHosted(unlessDemo(postAuthPoll))],
  ["POST", "/api/auth/github/web/start", unlessHosted(unlessDemo(postAuthWebStart))],
  ["POST", "/api/auth/github/web/poll", unlessHosted(unlessDemo(postAuthWebPoll))],
  ["GET", "/api/auth/github/callback", unlessHosted(unlessDemo(getAuthWebCallback))],
  ["POST", "/api/auth/github/token", unlessHosted(unlessDemo(postAuthToken))],
  ["DELETE", "/api/auth/github", unlessHosted(unlessDemo(deleteAuth))],
  ["GET", "/api/features", getFeatures],
  ["POST", "/api/features", postFeatures],
  ["GET", "/api/images", getImages],
  ["POST", "/api/images", postImage],
  ["DELETE", "/api/images", deleteImagesRoute],
  ["GET", "/api/images/:name", getImage],
  ["GET", "/api/scenario-files/:name", getScenarioFile],
  ["GET", "/api/search", getSearch],
  ["GET", "/api/project-settings", getProjectSettings],
  ["PUT", "/api/project-settings", putProjectSettings],
  ["POST", "/api/project-settings/specs-link", unlessHosted(postSpecsLink)],
  ["POST", "/api/project-settings/clone", unlessHosted(postCodeRepoClone)],
  ["GET", "/api/readme", getReadme],
  ["PUT", "/api/readme", putReadme],
  ["PUT", "/api/custom-attributes", putCustomAttributes],
  ["PUT", "/api/agent-models/:agent", unlessHosted(putAgentModels)],
  ["GET", "/api/test-name", getTestName],
  ["GET", "/api/entity-fields", getEntityFields],
  ["GET", "/api/pull-request", getPullRequestRoute],
  ["POST", "/api/tests/open-in-idea", unlessHosted(postOpenTestInIdea)],
  ["POST", "/api/code-repo/submodule", unlessHosted(postCodeRepoSubmodule)],
  ["GET", "/api/features/:file", getFeature],
  ["PUT", "/api/features/:file", putFeature],
  ["POST", "/api/features/:file/confluence", unlessHosted(postPublishConfluence)],
  ["GET", "/api/folders/:path/confluence", unlessHosted(getFolderConfluence)],
  ["POST", "/api/features/:file/qtest", unlessHosted(postPublishQtest)],
  ["DELETE", "/api/features/:file", deleteFeatureRoute],
  ["POST", "/api/folders", postFolders],
  ["DELETE", "/api/folders/:path", deleteFolderRoute],
  ["POST", "/api/folders/:path/rename", postRenameFolder],
  ["POST", "/api/folders/:path/move", postMoveFolder],
  ["PUT", "/api/folders/:path/description", putFolderDescription],
  ["PUT", "/api/folders/:path/order", putFolderOrder],
  ["PUT", "/api/folders/:path/feature-order", putFeatureOrder],
  ["POST", "/api/features/:file/move", postMove],
  ["POST", "/api/features/:file/rename-file", postRenameFile],
  ["POST", "/api/features/:file/rename", postRename],
  ["POST", "/api/features/:file/delete-draft", postDeleteDraft],
  ["PUT", "/api/features/:file/tickets", putTickets],
  ["PUT", "/api/features/:file/pull-requests", putPullRequests],
  ["PUT", "/api/features/:file/links/:kind", putResourceLinks],
  ["POST", "/api/features/:file/scenario-files", postScenarioFile],
  ["PUT", "/api/features/:file/scenario-files", putScenarioFiles],
  ["POST", "/api/features/:file/delete-published", postDeletePublished],
  ["POST", "/api/features/:file/delete-scenarios", postDeleteScenarios],
  ["POST", "/api/features/:file/unpublish", postUnpublish],
  ["POST", "/api/features/:file/move-scenario", postMoveScenario],
  ["POST", "/api/features/:file/clone-scenario", postCloneScenario],
  ["POST", "/api/agent/session", unlessHosted(postAgentSession)],
  ["POST", "/api/agent/session/prompt", postAgentSessionPrompt],
  ["POST", "/api/agent/chat", unlessHosted(postAgentChat)],
  ["GET", "/api/agent/chat", getAgentChats],
  ["GET", "/api/agent/chat/:id", unlessHosted(getAgentChat)],
  ["GET", "/api/agent/chat/:id/events", unlessHosted(getAgentChatEvents)],
  ["POST", "/api/agent/chat/:id/message", unlessHosted(postAgentChatMessage)],
  ["GET", "/api/agent/chat/:id/images/:imageId", unlessHosted(getAgentChatImage)],
  ["POST", "/api/agent/chat/:id/permission", unlessHosted(postAgentChatPermission)],
  ["POST", "/api/agent/chat/:id/interrupt", unlessHosted(postAgentChatInterrupt)],
  ["PUT", "/api/agent/chat/:id/mode", unlessHosted(putAgentChatMode)],
  ["PUT", "/api/agent/chat/:id/model", unlessHosted(putAgentChatModel)],
  ["PUT", "/api/agent/chat/:id/effort", unlessHosted(putAgentChatEffort)],
  ["GET", "/api/agent/agents/:agent/choices", unlessHosted(getAgentChoices)],
  ["PUT", "/api/agent/agents/:agent/defaults", unlessHosted(putAgentDefaults)],
  ["DELETE", "/api/agent/chat/:id", unlessHosted(deleteAgentChat)],
  ["GET", "/api/agent/folder", unlessHosted(getAgentFolder)],
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

/**
 * Requests that still work while the open folder holds data a newer app
 * wrote: switching folders, re-checking, signing in, and the app's own log —
 * none of them writes to the data repo. The data viewer reads the store's
 * bytes as they are, migrating nothing, so it is exactly what helps then.
 */
const OUTDATED_ALLOWED = /^\/api\/(state|reload|choose-folder|logs|auth|data)(\/|$)/;

/** Serve an API request, or null when the path is not an API route. */
export async function handleApi(req: Request): Promise<Response | null> {
  const pathname = new URL(req.url).pathname;
  const match = matchApi(req.method, pathname);
  // The read-only site (src/server/readOnlyMode.ts) answers its allowlist
  // alone; every other route — a write above all — is refused unrun.
  if (isReadOnlyMode() && !(match && readOnlyAllows(req.method, match.pattern))) {
    return pathname.startsWith("/api/") ? json({ error: READ_ONLY_REFUSAL }, 403) : null;
  }
  if (!match) return null;
  if (!anyIncompatible()) return match.handler(req, match.params);
  // specs/app/data-format.feature.md: nothing writes to data a newer app
  // wrote, and every answer says so in a header, so the client's routine
  // reads find out too and put up the blocking screen.
  const dir = await currentDataDir();
  const found = dir ? incompatibility(dir) : null;
  if (!found) return match.handler(req, match.params);
  // The requests that still work answer as usual: /api/state says it in
  // its body, and a folder switch must not read as the old folder's verdict.
  if (OUTDATED_ALLOWED.test(pathname)) return match.handler(req, match.params);
  const header = { [DATA_TOO_NEW_HEADER]: found.minAppVersion ?? "" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json(
      {
        status: "app-outdated",
        error: found.reason,
        minAppVersion: found.minAppVersion,
        appVersion: found.appVersion,
      },
      { status: 409, headers: header },
    );
  }
  const res = await match.handler(req, match.params);
  const marked = new Response(res.body, res);
  marked.headers.set(DATA_TOO_NEW_HEADER, header[DATA_TOO_NEW_HEADER]);
  return marked;
}
