// Local state lives in a .specdriven file (JSON) in the project root.
// Per specs/app-start.spec.md: if it doesn't name the last data repo,
// the UI must ask the user for one.

import type { GitScheme } from "./scheme";

export interface SpecDrivenState {
  dataRepo?: string;
  /** How often (seconds) the data repo is git-pulled; 0 disables the reload. */
  reloadFrequencySeconds?: number;
  /** Max Markdown lines rendered per scenario in the list (specs/ui.spec.md). */
  scenarioPreviewLines?: number;
  /**
   * Scheme git uses with GitHub (specs/git-operations.spec.md); absent
   * means auto-discover by probing (https, ssh, gh).
   */
  gitScheme?: GitScheme;
  /** Show the test-links table on scenario cards
      (specs/traceability.spec.md); absent means ON. */
  showTestLinks?: boolean;
}

export const STATE_FILE = ".specdriven";

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

export async function readState(rootDir: string = process.cwd()): Promise<SpecDrivenState> {
  const file = Bun.file(`${rootDir}/${STATE_FILE}`);
  if (!(await file.exists())) return {};
  try {
    const parsed = await file.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as SpecDrivenState) : {};
  } catch {
    return {};
  }
}

export async function writeState(
  state: SpecDrivenState,
  rootDir: string = process.cwd(),
): Promise<void> {
  await Bun.write(`${rootDir}/${STATE_FILE}`, JSON.stringify(state, null, 2) + "\n");
}

export function needsDataRepo(state: SpecDrivenState): boolean {
  return !state.dataRepo || state.dataRepo.trim() === "";
}
