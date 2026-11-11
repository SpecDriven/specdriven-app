// Local state lives in .specdriven/settings.yaml — in the project root, or in
// the user's home directory as a fallback (specs/ui/app-start.feature.md). A
// settings.json from before the file was YAML is still read, and converted
// when the app starts (src/server/settingsUpgrade.ts).
// Per specs/ui/app-start.feature.md: if it doesn't name the last data repo,
// the UI must ask the user for one.

import { readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { replaceTextFile } from "./fsx";
import { isYamlPath, parseSettingsText, serializeSettings } from "./settingsFormat";
import type { GitEngine } from "./git";
import { CONFLUENCE_PROGRAM, QTEST_PROGRAM } from "./parser";

export interface SpecDrivenState {
  /**
   * The settings file's format (SETTINGS_VERSION): which upgrade steps it
   * has had. A file without one is version 0.
   */
  settingsVersion?: number;
  dataRepo?: string;
  /**
   * The plugins' own settings, by plugin id (src/plugins/host/
   * pluginSettings.ts): each an object the plugin alone reads and writes,
   * through its HostConfig.settings or its own route.
   */
  pluginSettings?: Record<string, Record<string, unknown>>;
  /**
   * Every folder opened before, newest first, each with its kind — a
   * specifications folder or a code repository (specs/app/spec-folders
   * .feature.md "Manage specification folders", specs/ui/ui.feature.md
   * "Recent folder list"): what the folder dialog and the ▾ beside the
   * folder name list. The order is the recency; at most
   * MAX_RECENT_DATA_REPOS entries of each kind. The same path may be on it
   * twice, once per kind. Replaces `recentDataRepos`, `recentCodeRepos` and
   * `recentFolderOpenedAt` (settings version 1, migrateRecentFolders).
   */
  recentFolders?: RecentFolder[];
  /**
   * A code repository opened directly (specs/app/code-repo-mode.feature.md),
   * as an absolute path. While it is set the app runs in code repository
   * mode: no specifications folder is open and nothing syncs. `dataRepo`
   * keeps the last specifications folder, for the way back.
   */
  openCodeRepo?: string;
  /** How often (seconds) the data repo is git-pulled; 0 disables the reload. */
  reloadFrequencySeconds?: number;
  /**
   * Max Markdown lines rendered per scenario in the list
   * (specs/ui/ui.feature.md).
   */
  scenarioPreviewLines?: number;
  /**
   * How often (seconds) the open editor saves itself
   * (specs/editor/editor-autosave.feature.md). At least 3 seconds; absent means
   * the 6 second default.
   */
  autosaveIntervalSeconds?: number;
  /**
   * Git engine (git-operations.md): "gh" authenticates through
   * the GitHub CLI, "cli" through the app's own sign-in, "js" is the
   * bundled JavaScript git; absent means the default — gh when it is
   * installed, then cli, then js on a machine with no git at all.
   */
  gitEngine?: GitEngine;
  /**
   * Retired fallback to the GitHub CLI's account while signed out: the
   * GitHub CLI is a Git access of its own now (gitAccess). Older files may
   * still carry it; it is ignored.
   */
  useGhAccount?: boolean;
  /**
   * Which of the app's sign-ins the system git and built-in engines use
   * (specs/app/user-info-settings.feature.md "Git access"): "account" for
   * the browser or device-code sign-in, absent for the personal access
   * token. The GitHub CLI access is `gitEngine: "gh"`.
   */
  gitAccess?: "token" | "account";
  /** Show the test-links table on scenario cards
      (specs/traceability.feature.md); absent means ON. */
  showTestLinks?: boolean;
  /**
   * Open test links in IntelliJ IDEA instead of the browser
   * (specs/traceability.feature.md "Open test in idea"); absent means OFF.
   * On, a click on a test link runs `idea --line <n> <file>` on the file
   * under the project's code repo (src/server/idea.ts).
   */
  openTestsInIdea?: boolean;
  /**
   * Open a coding agent session's worktree in a Ghostty shell
   * (specs/agents/agent-pane.feature.md "A worktree session opens in a
   * Ghostty shell"); absent means OFF. On, a click on a worktree session's
   * branch in the pane's bar opens Ghostty in the folder the agent works in
   * (src/server/ghostty.ts).
   */
  ghostty?: boolean;
  /**
   * Track tickets at all
   * (specs/external-links/project-management-jira-linear-etc.feature.md);
   * absent means ON. Off takes the ticket fields out of the feature and spec
   * editors — nothing in the app asks for a ticket, and the links already
   * recorded stay untouched.
   */
  projectManagement?: boolean;
  /**
   * The project management tool the tickets live in — the `<program>` half
   * of `[Jira:ABC-123](url)`. Chosen once here rather than per link, so the
   * editors need only the ticket's url. Absent means the default, Jira.
   */
  projectManagementTool?: string;
  /**
   * Write external links — the Jira/Linear ticket of a feature or scenario
   * — into the `.feature.md` files
   * (specs/external-links/project-management-jira-linear-etc.feature.md);
   * absent means ON. Off keeps the links in the app's documents only.
   */
  publishExternalLinks?: boolean;
  /**
   * Offer Aha! links on features and scenarios
   * (specs/external-links/aha-and-figma-links.feature.md); absent means OFF.
   * Off hides the Aha! chip, field and lists; the links already recorded
   * stay in the documents.
   */
  ahaLinks?: boolean;
  /**
   * Offer "Import from Aha!" (specs/external-links/aha-import.feature.md
   * "Import from Aha! is switched on in Settings"); absent means OFF. Off
   * hides the import from the folder menu, the header and the palette, and
   * the import route refuses; the API keys already kept stay.
   */
  ahaImport?: boolean;
  /** Offer Figma links on features and scenarios, the same way as `ahaLinks`. */
  figmaLinks?: boolean;
  /**
   * Offer qTest test case links on features and scenarios
   * (specs/external-links/qtest-test-cases.feature.md); absent means OFF.
   * Off hides the qTest chip and field; the links already recorded stay in
   * the documents — and, like the ticket links, in the `.feature.md` while
   * "Publish external links" is on.
   */
  qtestLinks?: boolean;
  /**
   * Turn the Jira import on (specs/external-links/jira-wiki-import.feature.md
   * "Jira and Confluence imports are switched on in Settings"); absent means
   * OFF. Off hides the Jira import from the folder menu — and, with Confluence
   * off too, the whole import — and the import route refuses a Jira source.
   * The Jira tokens already saved stay.
   */
  jiraEnabled?: boolean;
  /**
   * Turn Confluence on (specs/external-links/confluence-wiki.feature.md,
   * jira-wiki-import.feature.md); absent means OFF. Off hides "Publish to
   * Confluence…" and the Confluence import, the publish and import routes
   * refuse, and the Confluence MCP server is not handed to agent sessions.
   * The Confluence tokens already saved stay.
   */
  confluenceEnabled?: boolean;
  /**
   * The last parent module a feature's test cases were created under in
   * qTest (specs/external-links/qtest-test-cases.feature.md), offered again
   * by the dialog. Per device, like the qTest tokens it goes with.
   */
  qtestParentUrl?: string;
  /** Offer code gen sessions (specs/agents/claude.feature.md); absent means ON.
      Off hides the selection checkboxes and refuses the session endpoint, so
      nothing in the app can hand a spec to a coding agent. */
  codeGen?: boolean;
  /**
   * Where "Start session" runs (specs/agents/claude.feature.md): "desktop"
   * opens a new session in Claude Code Desktop; a provider id ("claude",
   * "codex", "pi", …) opens one in the app's own coding agent pane
   * (specs/agents/agent-pane.feature.md) driven by that agent plugin
   * (specs/agents/agent-plugins.feature.md). Absent means desktop when
   * Claude.app is installed, else the first usable agent by rank — the
   * client resolves that from canOpenClaudeDesktop and `agents`.
   */
  codeGenTarget?: CodeGenTarget;
  /**
   * Offer feature assignment — the "Assigned" dropdown of project members
   * (src/server/members.ts); absent means OFF. Off hides the dropdown; an
   * assignment already written into a `.feature.md` is left alone, so
   * turning the switch back on finds it again.
   */
  assignments?: boolean;
  /**
   * Show feature flags (specs/app/feature-flags.feature.md) — the
   * `[ff:<name>:on|off]` chips and their editors; absent means OFF. Off only
   * hides them: flag lines already in a `.feature.md` are kept as written.
   */
  featureFlags?: boolean;
  /**
   * Mark scenarios positive or negative (specs/ui/scenario-polarity.feature.md)
   * — the green/red pill on each scenario and the Positive / Negative
   * sections of its Confluence page; absent means OFF. Off only hides the
   * pill: a `[negative]` line already in a `.feature.md` is kept as written.
   */
  scenarioPolarity?: boolean;
  /**
   * Show the GitHub account (specs/app/user-info-settings.feature.md "GitHub
   * account behind a switch"): the Settings sign-in block and the user
   * menu's sign-in entries. Not ready yet, so absent means OFF; off only
   * hides them — a sign-in already made keeps working.
   */
  githubAccount?: boolean;
  /** Allow deleting or moving published scenarios (specs/editor/spec-editor.feature.md
      "Delete Published Spec"); absent means OFF — published scenarios are
      immutable unless this is explicitly turned on. */
  deletePublished?: boolean;
  /**
   * The plugin profile (specs/app/plugins.feature.md "The profile lists
   * enabled plugins in tab order", "Each data folder keeps its own
   * plugins"): per data folder, the enabled plugins in the order their tabs
   * follow Specs; a folder without a list shows Specs alone. Device-local
   * like the switches it replaces (src/plugins/profile.ts).
   */
  plugins?: {
    /** Each data folder's list, keyed by the folder as `dataRepo` saves it. */
    repos?: Record<string, { enabled?: string[] }>;
    /**
     * @deprecated The device-wide list from before the per-folder ones,
     * still used while no folder is open. An older file's is copied to the
     * folders it knows and dropped.
     */
    enabled?: string[];
    /** Explicit plugin folders, `{ path }` rows. */
    sources?: { path: string }[];
    /** Data-repo plugin folders trusted to load. */
    trusted?: string[];
    /** Folder plugins already adopted once, so switching one off sticks. */
    seen?: string[];
    /** The marketplaces to browse, `{ name, source }`; absent, the SpecDriven index. */
    marketplaces?: { name: string; source: string }[];
  };
  /**
   * @deprecated The per-module switches from before the profile: `roadmap`,
   * `tasks`, `notebook` (the one that was on unless turned off), `models`,
   * `testing` and `issues`. A file that still has them is read as the
   * matching profile once; `PUT /api/state` takes them as aliases for one
   * release. Never written any more.
   */
  roadmap?: boolean;
  /** @deprecated See `roadmap`. */
  tasks?: boolean;
  /** @deprecated See `roadmap`. */
  notebook?: boolean;
  /** @deprecated See `roadmap`. */
  models?: boolean;
  /** @deprecated See `roadmap`. */
  testing?: boolean;
  /**
   * Google Calendar (specs/app/tasks.feature.md "Add task to Google
   * Calendar"): an "Add to calendar" button on every task that estimates the
   * task and opens a prefilled Google Calendar event; absent means OFF. Off,
   * no task carries the button and the estimate route is closed.
   */
  googleCalendar?: boolean;
  /** @deprecated See `roadmap`. */
  issues?: boolean;
  /**
   * Log verbosity (the Observability page, src/server/logs.ts): the least
   * severe level written, and per-component overrides of it. Absent means
   * SPECDRIVEN_LOG_LEVEL, else everything (debug).
   */
  logLevel?: "debug" | "info" | "warn" | "error";
  logLevels?: Record<string, "debug" | "info" | "warn" | "error">;
  /**
   * Optional websocket sync server for near-real-time document sync
   * (specs/datastore/automerge-store.feature.md), e.g.
   * wss://sync.automerge.org. Absent or empty means OFF — git stays the only
   * transport. On a public server, anyone holding a document's id can read that
   * document.
   */
  syncServerUrl?: string;
}

/** Effective sync server url for a stored value; null means off. */
export function normalizeSyncServerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return url.startsWith("ws://") || url.startsWith("wss://") ? url : null;
}

/** Directory holding the settings, in the project root or in $HOME. */
export const STATE_DIR = ".specdriven";
export const STATE_FILE = "settings.yaml";
/** What the settings file was called while it was JSON. */
export const LEGACY_JSON_STATE_FILE = "settings.json";
/** Where settings used to live: a plain .specdriven file in the root. */
export const LEGACY_STATE_FILE = ".specdriven";

/** The settings file inside a project root: ./.specdriven/settings.yaml. */
export function statePath(rootDir: string): string {
  return join(rootDir, STATE_DIR, STATE_FILE);
}

/**
 * The fallback settings file: ~/.specdriven/settings.yaml. SPECDRIVEN_HOME
 * overrides the directory — the variable install.sh uses for that prefix.
 */
export function homeStatePath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), STATE_FILE);
}

/**
 * The root is a checkout of this app's own source — the specdriven-app repo or
 * one of its worktrees, known by its package.json name. A dev server run from
 * there always keeps its settings in the home file
 * (specs/ui/app-start.feature.md "Settings file"), so every checkout and
 * worktree shares the user's one settings file instead of growing its own.
 */
export async function isAppCheckout(rootDir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
    return typeof pkg === "object" && pkg !== null && pkg.name === APP_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** package.json name of this app's own source tree. */
export const APP_PACKAGE_NAME = "specdriven";

/**
 * Set to "1" by the desktop app's main process (src/electron/main.ts): its
 * settings are the home file only, never one under its app-data root.
 */
export const HOME_SETTINGS_ENV = "SPECDRIVEN_HOME_SETTINGS";

/**
 * The home file is the only settings file for this root: in the desktop app,
 * and in a run from the app's own source checkout
 * (specs/ui/app-start.feature.md "Settings file").
 */
export async function homeSettingsOnly(rootDir: string): Promise<boolean> {
  return process.env[HOME_SETTINGS_ENV] === "1" || (await isAppCheckout(rootDir));
}

function legacyPath(rootDir: string): string {
  return join(rootDir, LEGACY_STATE_FILE);
}

/** The settings.json beside a settings.yaml path: the file from before YAML. */
export function jsonStatePath(yamlPath: string): string {
  return join(dirname(yamlPath), LEGACY_JSON_STATE_FILE);
}

/** Where a settings.json is kept once its settings are in settings.yaml. */
export function jsonBackupPath(jsonPath: string): string {
  return `${jsonPath}.bak`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The settings file a folder holds, given its settings.yaml path: that file,
 * or the settings.json from before it while it has not been converted. A
 * settings.json beside a settings.yaml is not read. Null when neither is there.
 */
async function settingsAt(yamlPath: string): Promise<string | null> {
  if (await isFile(yamlPath)) return yamlPath;
  const json = jsonStatePath(yamlPath);
  return (await isFile(json)) ? json : null;
}

/** Parsed settings at path, or null when there is no settings file there.
    A file that exists but doesn't parse is empty state, not a reason to look
    elsewhere — the user's own settings must not be silently overridden. */
async function readFrom(path: string): Promise<SpecDrivenState | null> {
  if (!(await isFile(path))) return null;
  try {
    const parsed = parseSettingsText(await readFile(path, "utf8"), path);
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as SpecDrivenState;
    // A folder saved before normalizing may still carry its trailing slash.
    if (typeof state.dataRepo === "string") state.dataRepo = normalizeDataRepo(state.dataRepo);
    if (typeof state.openCodeRepo === "string") state.openCodeRepo = normalizeDataRepo(state.openCodeRepo);
    // An older file is read in this app's format (SETTINGS_UPGRADES); the
    // next save writes it that way. One a newer app wrote is left as it is.
    upgradeSettings(state as Record<string, unknown>);
    if (state.recentFolders !== undefined) state.recentFolders = normalizeRecentFolders(state.recentFolders);
    return state;
  } catch {
    return {};
  }
}

/**
 * Saves settings as the settings.yaml at yamlPath. A settings.json the folder
 * still kept its settings in is then set aside as settings.json.bak, so one
 * file holds the settings; one lying beside a settings.yaml that was already
 * there was not being read, and stays as it is.
 */
async function saveSettings(yamlPath: string, state: SpecDrivenState): Promise<void> {
  const hadYaml = await isFile(yamlPath);
  // In one step: requests read the file while others write it.
  await replaceTextFile(yamlPath, serializeSettings(state));
  if (hadYaml) return;
  const json = jsonStatePath(yamlPath);
  if (await isFile(json)) await rename(json, jsonBackupPath(json));
}

export const DEFAULT_SCENARIO_PREVIEW_LINES = 8;

/** Effective scenario-list preview length for a stored value; at least 1 line. */
export function normalizeScenarioPreviewLines(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SCENARIO_PREVIEW_LINES;
  return Math.floor(n);
}

// Editor autosave (specs/editor/editor-autosave.feature.md): the interval the
// open editor is saved at. Autosave is always on — the setting is how often,
// and the floor keeps a save from firing between two keystrokes.
export const DEFAULT_AUTOSAVE_SECONDS = 6;
export const MIN_AUTOSAVE_SECONDS = 3;

/** Effective autosave interval for a stored value; anything absent, unusable
    or below the 3 second minimum falls back to the 6 second default. */
export function normalizeAutosaveSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < MIN_AUTOSAVE_SECONDS) return DEFAULT_AUTOSAVE_SECONDS;
  return Math.floor(n);
}

/** Effective test-links display setting: ON unless explicitly turned off
    (specs/traceability.feature.md "default is ON"). */
export function normalizeShowTestLinks(value: unknown): boolean {
  return value !== false;
}

/** Effective "open test links in IntelliJ IDEA" setting: OFF unless
    explicitly turned on (specs/traceability.feature.md "Open test in idea"). */
export function normalizeOpenTestsInIdea(value: unknown): boolean {
  return value === true;
}

/** Effective Ghostty setting: OFF unless explicitly turned on
    (specs/agents/agent-pane.feature.md). */
export function normalizeGhostty(value: unknown): boolean {
  return value === true;
}

/** Effective code gen setting: ON unless explicitly turned off
    (specs/agents/claude.feature.md). */
export function normalizeCodeGen(value: unknown): boolean {
  return value !== false;
}

/** Where a code gen session runs (specs/agents/claude.feature.md): Claude
    Code Desktop, or the coding agent pane driven by the provider the id
    names (specs/agents/agent-plugins.feature.md). */
export type CodeGenTarget = "desktop" | string;

/** The targets as an error message lists them: "desktop, claude, codex or pi". */
export function codeGenTargetList(agentIds: readonly string[]): string {
  const all = ["desktop", ...agentIds];
  return all.length === 1 ? all[0]! : `${all.slice(0, -1).join(", ")} or ${all.at(-1)}`;
}

/** Stored session target, or null when absent or unusable — the client
    then picks desktop when Claude.app is installed, else the first agent. */
export function normalizeCodeGenTarget(value: unknown, agentIds: readonly string[]): CodeGenTarget | null {
  if (typeof value !== "string") return null;
  return value === "desktop" || agentIds.includes(value) ? value : null;
}

/**
 * The directory holding the settings file writeState would write to:
 * <root>/.specdriven, unless only ~/.specdriven/settings.yaml exists (same
 * rule as writeState). Local, non-git session records live beside the
 * settings (src/server/agent.ts). No legacy-file migration here: a stale
 * plain `.specdriven` file blocks creating the directory until the next
 * settings save moves it aside.
 */
export async function settingsDirectory(rootDir: string = process.cwd()): Promise<string> {
  const local = statePath(rootDir);
  const home = homeStatePath();
  if (await homeSettingsOnly(rootDir)) return dirname(home);
  const target = !(await settingsAt(local)) && (await settingsAt(home)) ? home : local;
  return dirname(target);
}

/** Effective published-deletion setting: OFF unless explicitly turned on
    (specs/editor/spec-editor.feature.md "Delete Published Spec"). */
export function normalizeDeletePublished(value: unknown): boolean {
  return value === true;
}

/** Effective assignment setting: OFF unless explicitly turned on — a project
    that doesn't assign features never sees the dropdown
    (src/server/members.ts). */
export function normalizeAssignments(value: unknown): boolean {
  return value === true;
}

/** Effective feature-flags setting: OFF unless explicitly turned on
    (specs/app/feature-flags.feature.md). */
export function normalizeFeatureFlags(value: unknown): boolean {
  return value === true;
}

/** Effective scenario-polarity setting: OFF unless explicitly turned on
    (specs/ui/scenario-polarity.feature.md). */
export function normalizeScenarioPolarity(value: unknown): boolean {
  return value === true;
}

/** Effective GitHub-account setting: OFF unless explicitly turned on
    (specs/app/user-info-settings.feature.md). */
export function normalizeGithubAccount(value: unknown): boolean {
  return value === true;
}

/** Effective Google Calendar setting: OFF unless explicitly turned on —
    opt-in like the other modules (specs/app/tasks.feature.md). */
export function normalizeGoogleCalendar(value: unknown): boolean {
  return value === true;
}

/** Effective "Publish external links" setting: ON unless explicitly turned
    off (specs/external-links/project-management-jira-linear-etc.feature.md). */
export function normalizePublishExternalLinks(value: unknown): boolean {
  return value !== false;
}

/** Effective Aha! and Figma link settings
    (specs/external-links/aha-and-figma-links.feature.md): OFF unless
    explicitly turned on — a team that doesn't use the tool never sees it. */
export function normalizeResourceLinks(value: unknown): boolean {
  return value === true;
}

/** Effective "Import from Aha!" setting
    (specs/external-links/aha-import.feature.md): OFF unless explicitly
    turned on, like the Aha! links. */
export function normalizeAhaImport(value: unknown): boolean {
  return value === true;
}

/** The remembered qTest parent module url, or null when there is none usable. */
export function normalizeQtestParentUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return url.length <= 2048 && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/** Effective qTest test case link setting
    (specs/external-links/qtest-test-cases.feature.md): OFF unless explicitly
    turned on, like the Aha! and Figma ones. */
export function normalizeQtestLinks(value: unknown): boolean {
  return value === true;
}

/** Effective Jira import setting (specs/external-links/jira-wiki-import
    .feature.md): OFF unless explicitly turned on, like the Aha! import. */
export function normalizeJiraEnabled(value: unknown): boolean {
  return value === true;
}

/** Effective Confluence setting (specs/external-links/confluence-wiki
    .feature.md, jira-wiki-import.feature.md): OFF unless explicitly turned on,
    like the Aha! import. */
export function normalizeConfluenceEnabled(value: unknown): boolean {
  return value === true;
}

// Project management (specs/external-links/project-management-jira-linear-
// etc.feature.md): which tool the tickets live in, chosen in Settings once
// instead of on every link. Jira is the default so a fresh install can link
// a ticket without visiting Settings first.
export const DEFAULT_PROJECT_MANAGEMENT_TOOL = "Jira";

/** Effective project-management setting: ON unless explicitly turned off. */
export function normalizeProjectManagement(value: unknown): boolean {
  return value !== false;
}

/** Effective tool name for a stored value; anything absent or unusable as a
    `<program>` — empty, or carrying ':' or brackets — falls back to Jira. */
export function normalizeProjectManagementTool(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROJECT_MANAGEMENT_TOOL;
  const name = value.trim();
  // `qTest` is the program of the test case links
  // (specs/external-links/qtest-test-cases.feature.md) and `Confluence` that
  // of a published page (specs/external-links/confluence-wiki.feature.md),
  // never a ticket's.
  const reserved = [QTEST_PROGRAM, CONFLUENCE_PROGRAM].some((p) => p.toLowerCase() === name.toLowerCase());
  return name && !/[:[\]]/.test(name) && !reserved ? name : DEFAULT_PROJECT_MANAGEMENT_TOOL;
}

/**
 * The project settings file wins; the home one is the fallback, so one
 * settings file can serve every checkout (specs/ui/app-start.feature.md). A
 * leftover .specdriven file from the old layout still reads, and is migrated
 * on the next write.
 */
export async function readState(rootDir: string = process.cwd()): Promise<SpecDrivenState> {
  const path = await settingsFile(rootDir);
  return (path && (await readFrom(path))) || {};
}

/** The settings file readState reads, or null when there is none anywhere. */
export async function settingsFile(rootDir: string = process.cwd()): Promise<string | null> {
  // The desktop app and the app's own checkout read the home file first; an
  // old project file is read only while there is no home file yet, and the
  // next save moves it home.
  const legacy = legacyPath(rootDir);
  const order = (await homeSettingsOnly(rootDir))
    ? [homeStatePath(), statePath(rootDir), legacy]
    : [statePath(rootDir), legacy, homeStatePath()];
  for (const path of order) {
    // Each folder's settings.yaml, or its settings.json from before YAML.
    const found = path === legacy ? ((await isFile(path)) ? path : null) : await settingsAt(path);
    if (found) return found;
  }
  return null;
}

/**
 * The user's settings file, ~/.specdriven/settings.yaml, as the User info
 * dialog's "View settings file…" shows it (specs/app/user-info-settings
 * .feature.md "view the settings file"): the file as written — no upgrade,
 * no normalizing — so the view matches what is on disk. Always the home
 * file, never a project one — its settings.json while that has not been
 * converted; `activePath` names the file readState reads when that is a
 * different one.
 */
export interface SettingsFileView {
  path: string;
  /** The user's home directory, so the view can write paths from `~`. */
  home: string;
  exists: boolean;
  settings: Record<string, unknown>;
  /** The file the app reads its settings from, when it is not `path`. */
  activePath?: string;
  /** Set when the file is there but does not hold a settings object. */
  error?: string;
}

export async function readSettingsFileView(rootDir: string = process.cwd()): Promise<SettingsFileView> {
  const found = await settingsAt(homeStatePath());
  const path = found ?? homeStatePath();
  const active = await settingsFile(rootDir);
  const view: SettingsFileView = { path, home: homedir(), exists: found !== null, settings: {} };
  if (active && active !== path) view.activePath = active;
  if (!view.exists) return view;
  try {
    const parsed = parseSettingsText(await readFile(path, "utf8"), path);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      view.settings = parsed as Record<string, unknown>;
    } else view.error = "The file does not hold a settings object.";
  } catch {
    view.error = isYamlPath(path) ? "The file is not valid YAML." : "The file is not valid JSON.";
  }
  return view;
}

/**
 * Writes back to whichever settings file readState would pick up, so
 * settings stay where the user keeps them; with none anywhere, the project
 * one is created.
 */
export async function writeState(
  state: SpecDrivenState,
  rootDir: string = process.cwd(),
): Promise<void> {
  if (await homeSettingsOnly(rootDir)) {
    await saveSettings(homeStatePath(), state);
    return;
  }
  const local = statePath(rootDir);
  const legacy = legacyPath(rootDir);
  if (await isFile(legacy)) {
    // The .specdriven directory can't be created while a file of that name is
    // in the way. Move it aside rather than delete it, so an interrupted
    // migration leaves the old settings recoverable instead of gone.
    const aside = `${legacy}.migrating`;
    await rename(legacy, aside);
    await saveSettings(local, state);
    await rm(aside, { force: true });
    return;
  }
  const home = homeStatePath();
  const target = !(await settingsAt(local)) && (await settingsAt(home)) ? home : local;
  await saveSettings(target, state);
}

/**
 * Code repository mode (specs/app/code-repo-mode.feature.md): a code
 * repository is open in place of a specifications folder.
 */
export function codeRepoMode(state: SpecDrivenState): boolean {
  return typeof state.openCodeRepo === "string" && state.openCodeRepo.trim() !== "";
}

/** A specifications folder is open: one is named, and no code repository took its place. */
export function specsOpen(state: SpecDrivenState): boolean {
  return typeof state.dataRepo === "string" && state.dataRepo.trim() !== "" && !codeRepoMode(state);
}

/**
 * No specifications folder is open — none was ever picked, or a code
 * repository is open instead. Every route, sync tick and plugin pass that
 * reads or writes specifications stops here, so a code repository is never
 * pulled, committed to or pushed (specs/app/code-repo-mode.feature.md "The
 * app runs no git in a code repository").
 */
export function needsDataRepo(state: SpecDrivenState): boolean {
  return !specsOpen(state);
}

/** No folder of either kind is open: the first-run screen asks for one. */
export function needsFolder(state: SpecDrivenState): boolean {
  return !specsOpen(state) && !codeRepoMode(state);
}

// Settings file format (specs/ui/app-start.feature.md "Settings file"). The
// file carries `settingsVersion`; a file without one is version 0. Each
// change to what the file stores — a key renamed, split, merged or dropped,
// a value in a new shape — raises SETTINGS_VERSION by one and adds the step
// that rewrites a file of the version before into it. A new app runs the
// steps the file has not had, in order, when it reads it, and on start
// saves the result, keeping the file as it was beside it
// (src/server/settingsUpgrade.ts). A key that is only added needs no step:
// a file without it reads as the default.
//
// A file a newer app wrote is read as it is and never lowered: the keys this
// app knows still work, the ones it does not stay untouched, and the newer
// app finds its version unchanged.

/** The settings file format this app reads and writes. */
export const SETTINGS_VERSION = 1;

/** One upgrade step: rewrites a file of version - 1 into `version`. */
export interface SettingsUpgrade {
  version: number;
  /** What the step changes, for the log. */
  summary: string;
  upgrade(state: Record<string, unknown>): void;
}

/** Every step, oldest first — one per version, 1 to SETTINGS_VERSION. */
export const SETTINGS_UPGRADES: readonly SettingsUpgrade[] = [
  {
    version: 1,
    summary: "recentDataRepos, recentCodeRepos and recentFolderOpenedAt become one recentFolders list",
    upgrade: (state) => void migrateRecentFolders(state),
  },
];

/** The version a settings file says it is in: 0 for none, or for anything but a whole number ≥ 0. */
export function settingsVersionOf(state: Record<string, unknown>): number {
  const v = state.settingsVersion;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

export interface SettingsUpgradeResult {
  /** The version the file was in. */
  from: number;
  /** The version it is in now: SETTINGS_VERSION, or `from` when that is newer. */
  to: number;
  /** A newer app wrote the file; it was left as it is. */
  tooNew: boolean;
  /** What the steps that ran change, oldest first. */
  steps: string[];
}

/**
 * Runs the steps a settings object has not had and stamps it with this
 * app's version. One from a newer app is left as it is.
 */
export function upgradeSettings(state: Record<string, unknown>): SettingsUpgradeResult {
  const from = settingsVersionOf(state);
  if (from > SETTINGS_VERSION) return { from, to: from, tooNew: true, steps: [] };
  const steps: string[] = [];
  for (const step of SETTINGS_UPGRADES) {
    if (step.version <= from) continue;
    step.upgrade(state);
    steps.push(step.summary);
  }
  state.settingsVersion = SETTINGS_VERSION;
  return { from, to: SETTINGS_VERSION, tooNew: false, steps };
}

// Recent folder list (specs/ui/ui.feature.md "Recent folder list"): the
// folders opened before, most recent first, up to 10 of each kind.
export const MAX_RECENT_DATA_REPOS = 10;

/**
 * A data folder as saved: trimmed, without trailing separators, so
 * "/specs/a/" and "/specs/a" are one folder (and so are a GitHub url with
 * and without its slash). A root ("/", "C:\") stays.
 */
export function normalizeDataRepo(repo: string): string {
  return repo.trim().replace(/(?<=[^\\/:])[\\/]+$/, "");
}

/** Cleaned, deduplicated, capped list of folder paths. */
export function normalizeRecentDataRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const repo = normalizeDataRepo(entry);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    out.push(repo);
    if (out.length === MAX_RECENT_DATA_REPOS) break;
  }
  return out;
}

/** The two kinds of folder the app opens: a specifications folder, or a code repository. */
export type FolderKind = "spec" | "code";

/** One entry on the folder list. */
export interface RecentFolder {
  path: string;
  kind: FolderKind;
}

const isKind = (value: unknown): value is FolderKind => value === "spec" || value === "code";

/**
 * A stored folder list, cleaned: entries that are not a path and a kind go,
 * paths are normalized, each path is kept once per kind (its newest place),
 * and each kind keeps its newest MAX_RECENT_DATA_REPOS.
 */
export function normalizeRecentFolders(value: unknown): RecentFolder[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const count: Record<FolderKind, number> = { spec: 0, code: 0 };
  const out: RecentFolder[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, kind } = entry as { path?: unknown; kind?: unknown };
    if (typeof path !== "string" || !isKind(kind)) continue;
    const clean = normalizeDataRepo(path);
    const key = `${kind}\0${clean}`;
    if (!clean || seen.has(key) || count[kind] === MAX_RECENT_DATA_REPOS) continue;
    seen.add(key);
    count[kind]++;
    out.push({ path: clean, kind });
  }
  return out;
}

/**
 * Settings from before the one folder list kept three keys: a list of
 * specification folders, a list of code repositories, and when each entry
 * was last opened. They become the one list, in the order the folder
 * dialog showed them — newest first by open time, entries with no time
 * behind, spec folders before code repositories — and the old keys go, so
 * the next save writes the list alone. A file that already has the list
 * keeps it. Returns whether anything changed. Settings upgrade step 1.
 */
export function migrateRecentFolders(state: Record<string, unknown>): boolean {
  const legacy = ["recentDataRepos", "recentCodeRepos", "recentFolderOpenedAt"] as const;
  if (!legacy.some((key) => key in state)) return false;
  if (!Array.isArray(state.recentFolders)) {
    const times = legacyOpenedAt(state.recentFolderOpenedAt);
    const entries = [
      ...normalizeRecentDataRepos(state.recentDataRepos).map((path): RecentFolder => ({ path, kind: "spec" })),
      ...normalizeRecentDataRepos(state.recentCodeRepos).map((path): RecentFolder => ({ path, kind: "code" })),
    ];
    const at = (e: RecentFolder) => times[e.kind][e.path] ?? 0;
    // Array.prototype.sort is stable, so equal times keep the list order.
    state.recentFolders = entries.sort((a, b) => at(b) - at(a));
  }
  for (const key of legacy) delete state[key];
  return true;
}

/** The old per-kind open-time map, every non-time value dropped. */
function legacyOpenedAt(value: unknown): Record<FolderKind, Record<string, number>> {
  const out: Record<FolderKind, Record<string, number>> = { spec: {}, code: {} };
  if (typeof value !== "object" || value === null) return out;
  for (const kind of ["spec", "code"] as const) {
    const times = (value as Record<string, unknown>)[kind];
    if (typeof times !== "object" || times === null) continue;
    for (const [path, at] of Object.entries(times)) {
      if (typeof at === "number" && Number.isFinite(at)) out[kind][normalizeDataRepo(path)] = at;
    }
  }
  return out;
}

/** The stored paths of one kind, newest first. */
function storedPaths(state: SpecDrivenState, kind: FolderKind): string[] {
  return normalizeRecentFolders(state.recentFolders)
    .filter((e) => e.kind === kind)
    .map((e) => e.path);
}

/** The list with `path` of `kind` moved (or added) to the front, the oldest of that kind past 10 dropped. */
function remember(state: SpecDrivenState, kind: FolderKind, path: string): void {
  state.recentFolders = normalizeRecentFolders([{ path, kind }, ...normalizeRecentFolders(state.recentFolders)]);
}

/** Takes `path` of `kind` off the list. Returns whether it was there. */
function forget(state: SpecDrivenState, kind: FolderKind, path: string): boolean {
  const target = normalizeDataRepo(path);
  const before = normalizeRecentFolders(state.recentFolders);
  const after = before.filter((e) => e.kind !== kind || e.path !== target);
  state.recentFolders = after;
  return after.length !== before.length;
}

/**
 * The recent specifications folders as shown: the current folder first,
 * then the stored entries. A settings file from before the list still
 * offers the one folder it names.
 */
export function recentDataRepos(state: SpecDrivenState): string[] {
  const current = state.dataRepo && normalizeDataRepo(state.dataRepo);
  const stored = storedPaths(state, "spec");
  return current ? normalizeRecentDataRepos([current, ...stored]) : stored;
}

/**
 * The code repositories as the folder dialog lists them
 * (specs/app/code-repo-mode.feature.md "Open a code repository"): the open
 * one first, then the stored entries.
 */
export function recentCodeRepos(state: SpecDrivenState): string[] {
  const current = codeRepoMode(state) ? normalizeDataRepo(state.openCodeRepo!) : null;
  const stored = storedPaths(state, "code");
  return current ? normalizeRecentDataRepos([current, ...stored]) : stored;
}

/** Moves (or adds) a code repository to the front of the list, dropping the oldest past 10. */
export function rememberCodeRepo(state: SpecDrivenState, repo: string): void {
  remember(state, "code", repo);
}

/** Takes a code repository off the list — the folder stays on disk. Returns whether it was there. */
export function forgetCodeRepo(state: SpecDrivenState, repo: string): boolean {
  return forget(state, "code", repo);
}

/** Moves (or adds) a specifications folder to the front of the list, dropping the oldest past 10. */
export function rememberDataRepo(state: SpecDrivenState, repo: string): void {
  remember(state, "spec", repo);
}

/**
 * Takes a folder out of the list (specs/app/spec-folders.feature.md "Manage
 * specification folders"): the app forgets it, the folder itself stays on
 * disk. Returns whether it was there. The current folder is not removable —
 * the list always offers the folder that is open — so callers refuse that
 * before getting here.
 */
export function forgetDataRepo(state: SpecDrivenState, repo: string): boolean {
  return forget(state, "spec", repo);
}

/** Keeps only the specifications folders among `keep`, every entry where it was. */
export function keepDataRepos(state: SpecDrivenState, keep: readonly string[]): void {
  const on = new Set(keep.map(normalizeDataRepo));
  state.recentFolders = normalizeRecentFolders(state.recentFolders).filter((e) => e.kind !== "spec" || on.has(e.path));
}

/**
 * Every folder the app knows, spec and code together, newest first
 * (specs/app/spec-folders.feature.md "Manage specification folders"): what
 * the folder dialog lists and the recent ▾ menu draws from. The open folder
 * comes first, then the stored list in its order; `spec` and `code` say
 * which paths of each kind to show (one entry per repository, none in the
 * demo), and any of them the stored list lacks follow it. The same path may
 * be on it twice, once per kind.
 */
export function mergeRecentFolders(
  state: SpecDrivenState,
  spec: readonly string[],
  code: readonly string[],
): RecentFolder[] {
  const shown: Record<FolderKind, readonly string[]> = { spec, code };
  const open = openFolder(state);
  const out: RecentFolder[] = [];
  const add = (e: RecentFolder) => {
    if (!shown[e.kind].includes(e.path)) return;
    if (out.some((o) => o.kind === e.kind && o.path === e.path)) return;
    out.push(e);
  };
  if (open) add(open);
  for (const e of normalizeRecentFolders(state.recentFolders)) add(e);
  for (const path of spec) add({ path, kind: "spec" });
  for (const path of code) add({ path, kind: "code" });
  return out;
}

/** The folder open now — a code repository, or the specifications folder — or null. */
export function openFolder(state: SpecDrivenState): RecentFolder | null {
  if (codeRepoMode(state)) return { path: normalizeDataRepo(state.openCodeRepo!), kind: "code" };
  if (specsOpen(state)) return { path: normalizeDataRepo(state.dataRepo!), kind: "spec" };
  return null;
}
