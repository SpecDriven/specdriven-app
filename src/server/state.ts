// Local state lives in .specdriven/settings.json — in the project root, or in
// the user's home directory as a fallback (specs/app-start.spec.md).
// Per specs/app-start.spec.md: if it doesn't name the last data repo,
// the UI must ask the user for one.

import { readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import type { GitEngine } from "./git";

export interface SpecDrivenState {
  dataRepo?: string;
  /** How often (seconds) the data repo is git-pulled; 0 disables the reload. */
  reloadFrequencySeconds?: number;
  /** Max Markdown lines rendered per scenario in the list (specs/ui.spec.md). */
  scenarioPreviewLines?: number;
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

/** Effective test-links display setting: ON unless explicitly turned off
    (specs/traceability.spec.md "default is ON"). */
export function normalizeShowTestLinks(value: unknown): boolean {
  return value !== false;
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
