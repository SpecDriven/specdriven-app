// Local state lives in .specdriven/settings.json — in the project root, or in
// the user's home directory as a fallback (specs/app-start.spec.md).
// Per specs/app-start.spec.md: if it doesn't name the last data repo,
// the UI must ask the user for one.

import { readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeTextFile } from "./fsx";
import type { GitEngine } from "./git";

export interface SpecDrivenState {
  dataRepo?: string;
  /**
   * Data folders used before, most recent first (specs/ui/ui.feature.md
   * "Recent folder list"): what the ▾ beside the folder name offers. Holds
   * the current folder too; at most MAX_RECENT_DATA_REPOS entries.
   */
  recentDataRepos?: string[];
  /** How often (seconds) the data repo is git-pulled; 0 disables the reload. */
  reloadFrequencySeconds?: number;
  /** Max Markdown lines rendered per scenario in the list (specs/ui.spec.md). */
  scenarioPreviewLines?: number;
  /**
   * How often (seconds) the open editor saves itself
   * (specs/editor-autosave.feature.md). At least 3 seconds; absent means the
   * 6 second default.
   */
  autosaveIntervalSeconds?: number;
  /**
   * Git engine (specs/git-operations.spec.md): "gh" authenticates through
   * the GitHub CLI, "cli" through the app's own sign-in, "js" is the
   * bundled JavaScript git; absent means the default — gh when it is
   * installed, then cli, then js on a machine with no git at all.
   */
  gitEngine?: GitEngine;
  /** Show the test-links table on scenario cards
      (specs/traceability.spec.md); absent means ON. */
  showTestLinks?: boolean;
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
  /** Offer code gen sessions (specs/agents/claude.spec.md); absent means ON.
      Off hides the selection checkboxes and refuses the session endpoint, so
      nothing in the app can hand a spec to a coding agent. */
  codeGen?: boolean;
  /**
   * Where "Start session" runs (specs/agents/claude.feature.md): "desktop"
   * opens a new session in Claude Code Desktop, "pane" opens one in the
   * app's own coding agent pane (specs/agents/coding-agent-ui.feature.md),
   * "pi" the same pane driven by Pi
   * (specs/agents/integration-with-pi-dev-agent.feature.md), "codex" the
   * same pane driven by Codex (src/server/codexChat.ts). Absent means
   * desktop when Claude.app is installed, else pane when the Claude CLI is —
   * the client resolves that from canOpenClaudeDesktop, canRunAgentPane,
   * canRunCodex and canRunPi.
   */
  codeGenTarget?: CodeGenTarget;
  /**
   * Offer feature assignment — the "Assigned" dropdown of project members
   * (src/server/members.ts); absent means OFF. Off hides the dropdown; an
   * assignment already written into a `.feature.md` is left alone, so
   * turning the switch back on finds it again.
   */
  assignments?: boolean;
  /** Allow deleting published scenarios (specs/editor/spec-editor.feature.md
      "Delete Published Spec"); absent means OFF — published scenarios are
      immutable unless this is explicitly turned on. */
  deletePublished?: boolean;
  /**
   * Show the data repo's `roadmap` folder — the markdown pages above the
   * feature folders (specs/app/roadmap.feature.md); absent means OFF. On, the
   * folder is created if the repo has none, and the sidebar lists its pages;
   * off, the folder and its pages are simply not shown.
   */
  roadmap?: boolean;
  /**
   * Show the data repo's `tasks` folder — the same markdown pages as the
   * roadmap's, called tasks and listed on their own sidebar tab
   * (specs/app/tasks.feature.md); absent means OFF. On, the folder is created
   * if the repo has none, and the sidebar lists its tasks; off, the folder
   * and its tasks are simply not shown.
   */
  tasks?: boolean;
  /**
   * Show the data repo's `notebook` folder — the engineering notebook's
   * dated entries on their own sidebar tab
   * (specs/app/engineering-notebook.feature.md). Absent means ON: this is the
   * one module that ships switched on, stored as `false` when a user turns it
   * off. Nothing is created by the switch — the folder appears with the first
   * entry — so a default-on module never touches a data repo by itself.
   */
  notebook?: boolean;
  /**
   * Show the data repo's `models` folder — Event Models on their own Models
   * tab and canvas (roadmap/support-event-modeling.md); absent means OFF.
   * On, the folder is created if the repo has none; off, the folder and its
   * models are simply not shown.
   */
  models?: boolean;
  /**
   * Show the test management module (specs/app/tests.feature.md) —
   * test cases, plans and executions on their own sidebar tab and pane;
   * absent means OFF. On, the tab appears and the module's document is
   * made in the data repo on its first write; off, the tab is simply not
   * shown and the document, if any, is left alone.
   */
  testing?: boolean;
  /**
   * GitHub issue tracking (specs/app/github-issues.feature.md): an Issues
   * tab and pane for the issues of the GitHub repo the data repo's
   * code-repo pushes to; absent means OFF. On, the tab appears once the
   * project-settings.json names such a repo; off, nothing in the app asks
   * GitHub for issues.
   */
  issues?: boolean;
  /**
   * Optional websocket sync server for near-real-time document sync
   * (specs/automerge-store.spec.md), e.g. wss://sync.automerge.org. Absent
   * or empty means OFF — git stays the only transport. On a public server,
   * anyone holding a document's id can read that document.
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
export const STATE_FILE = "settings.json";
/** Where settings used to live: a plain .specdriven file in the root. */
export const LEGACY_STATE_FILE = ".specdriven";

/** The settings file inside a project root: ./.specdriven/settings.json. */
export function statePath(rootDir: string): string {
  return join(rootDir, STATE_DIR, STATE_FILE);
}

/**
 * The fallback settings file: ~/.specdriven/settings.json. SPECDRIVEN_HOME
 * overrides the directory — the variable install.sh uses for that prefix.
 */
export function homeStatePath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), STATE_FILE);
}

function legacyPath(rootDir: string): string {
  return join(rootDir, LEGACY_STATE_FILE);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Parsed settings at path, or null when there is no settings file there.
    A file that exists but doesn't parse is empty state, not a reason to look
    elsewhere — the user's own settings must not be silently overridden. */
async function readFrom(path: string): Promise<SpecDrivenState | null> {
  if (!(await isFile(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as SpecDrivenState) : {};
  } catch {
    return {};
  }
}

function serialize(state: SpecDrivenState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

export const DEFAULT_SCENARIO_PREVIEW_LINES = 8;

/** Effective scenario-list preview length for a stored value; at least 1 line. */
export function normalizeScenarioPreviewLines(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SCENARIO_PREVIEW_LINES;
  return Math.floor(n);
}

// Editor autosave (specs/editor-autosave.feature.md): the interval the open
// editor is saved at. Autosave is always on — the setting is how often, and
// the floor keeps a save from firing between two keystrokes.
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
    (specs/traceability.spec.md "default is ON"). */
export function normalizeShowTestLinks(value: unknown): boolean {
  return value !== false;
}

/** Effective code gen setting: ON unless explicitly turned off
    (specs/agents/claude.spec.md). */
export function normalizeCodeGen(value: unknown): boolean {
  return value !== false;
}

/** The agents a code gen session can run in (specs/agents/claude.feature.md,
    specs/agents/coding-agent-ui.feature.md,
    specs/agents/integration-with-pi-dev-agent.feature.md; "codex" is the
    same pane driven by Codex, src/server/codexChat.ts). */
export type CodeGenTarget = "desktop" | "pane" | "pi" | "codex";

export const CODE_GEN_TARGETS: readonly CodeGenTarget[] = ["desktop", "pane", "pi", "codex"];

/** The targets as the error messages list them, in one place. */
export const CODE_GEN_TARGET_LIST = "desktop, pane, pi or codex";

/** Stored session target, or null when absent or unusable — the client
    then picks desktop when Claude.app is installed, else the pane. */
export function normalizeCodeGenTarget(value: unknown): CodeGenTarget | null {
  return (CODE_GEN_TARGETS as readonly unknown[]).includes(value) ? (value as CodeGenTarget) : null;
}

/**
 * The directory holding the settings file writeState would write to:
 * <root>/.specdriven, unless only ~/.specdriven/settings.json exists (same
 * rule as writeState). Local, non-git session records live beside the
 * settings (src/server/agent.ts). No legacy-file migration here: a stale
 * plain `.specdriven` file blocks creating the directory until the next
 * settings save moves it aside.
 */
export async function settingsDirectory(rootDir: string = process.cwd()): Promise<string> {
  const local = statePath(rootDir);
  const home = homeStatePath();
  const target = !(await isFile(local)) && (await isFile(home)) ? home : local;
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

/** Effective roadmap setting: OFF unless explicitly turned on — the roadmap
    folder is opt-in (specs/app/roadmap.feature.md). */
export function normalizeRoadmap(value: unknown): boolean {
  return value === true;
}

/** Effective tasks setting: OFF unless explicitly turned on — the tasks
    folder is opt-in like the roadmap's (specs/app/tasks.feature.md). */
export function normalizeTasks(value: unknown): boolean {
  return value === true;
}

/** Effective engineering notebook setting: ON unless explicitly turned off —
    the one module that ships on (specs/app/engineering-notebook.feature.md).
    It is safe to default on because the switch creates nothing: the notebook
    folder appears with the first entry, not when the app starts. */
export function normalizeNotebook(value: unknown): boolean {
  return value !== false;
}

/** Effective models setting: OFF unless explicitly turned on — the models
    folder is opt-in like the roadmap's (roadmap/support-event-modeling.md). */
export function normalizeModels(value: unknown): boolean {
  return value === true;
}

/** Effective test management setting: OFF unless explicitly turned on —
    opt-in like the roadmap and tasks (specs/app/tests.feature.md). */
export function normalizeTesting(value: unknown): boolean {
  return value === true;
}

/** Effective GitHub issues setting: OFF unless explicitly turned on —
    opt-in like the other modules (specs/app/github-issues.feature.md). */
export function normalizeIssues(value: unknown): boolean {
  return value === true;
}

/** Effective "Publish external links" setting: ON unless explicitly turned
    off (specs/external-links/project-management-jira-linear-etc.feature.md). */
export function normalizePublishExternalLinks(value: unknown): boolean {
  return value !== false;
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
  return name && !/[:[\]]/.test(name) ? name : DEFAULT_PROJECT_MANAGEMENT_TOOL;
}

/**
 * The project settings file wins; the home one is the fallback, so one
 * settings file can serve every checkout (specs/app-start.spec.md). A
 * leftover .specdriven file from the old layout still reads, and is migrated
 * on the next write.
 */
export async function readState(rootDir: string = process.cwd()): Promise<SpecDrivenState> {
  for (const path of [statePath(rootDir), legacyPath(rootDir), homeStatePath()]) {
    const state = await readFrom(path);
    if (state) return state;
  }
  return {};
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
  const local = statePath(rootDir);
  const legacy = legacyPath(rootDir);
  if (await isFile(legacy)) {
    // The .specdriven directory can't be created while a file of that name is
    // in the way. Move it aside rather than delete it, so an interrupted
    // migration leaves the old settings recoverable instead of gone.
    const aside = `${legacy}.migrating`;
    await rename(legacy, aside);
    await writeTextFile(local, serialize(state));
    await rm(aside, { force: true });
    return;
  }
  const home = homeStatePath();
  const target = !(await isFile(local)) && (await isFile(home)) ? home : local;
  await writeTextFile(target, serialize(state));
}

export function needsDataRepo(state: SpecDrivenState): boolean {
  return !state.dataRepo || state.dataRepo.trim() === "";
}

// Recent folder list (specs/ui/ui.feature.md "Recent folder list"): the
// data folders picked before, most recent first, up to 10.
export const MAX_RECENT_DATA_REPOS = 10;

/** Cleaned, deduplicated, capped list for a stored value. */
export function normalizeRecentDataRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const repo = entry.trim();
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    out.push(repo);
    if (out.length === MAX_RECENT_DATA_REPOS) break;
  }
  return out;
}

/**
 * The recent list as shown: the current folder first, then the stored
 * entries. A settings file from before the list still offers the one
 * folder it names.
 */
export function recentDataRepos(state: SpecDrivenState): string[] {
  const current = state.dataRepo?.trim();
  const stored = normalizeRecentDataRepos(state.recentDataRepos);
  return current ? normalizeRecentDataRepos([current, ...stored]) : stored;
}

/** Moves (or adds) repo to the front of the list, dropping the oldest past 10. */
export function rememberDataRepo(state: SpecDrivenState, repo: string): void {
  state.recentDataRepos = normalizeRecentDataRepos([
    repo,
    ...normalizeRecentDataRepos(state.recentDataRepos),
  ]);
}
