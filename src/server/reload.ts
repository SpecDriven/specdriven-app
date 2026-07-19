// Per specs/crud-feature.spec.md ("reload data on a cron job"): automatically
// reload (git pull) the data repo every n seconds. The frequency comes from
// the Settings dialog and is persisted in .specdriven (specs/ui.spec.md).
// After the pull, locally saved scenarios are committed and pushed
// ("Scenario is automatically saved locally and pushed to GitHub").

import { pull, syncSavedChanges } from "./git";
import { resolveDataRepo } from "./repo";
import { readState, needsDataRepo } from "./state";

export const DEFAULT_RELOAD_SECONDS = 60;

/** Effective reload frequency for a stored value; 0 disables the reload. */
export function normalizeReloadSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RELOAD_SECONDS;
  return Math.floor(n);
}

/**
 * One tick of the cron job: git pull the configured data repo, then commit
 * and push any locally saved scenarios.
 */
export async function reloadData(rootDir: string): Promise<string> {
  const state = await readState(rootDir);
  if (needsDataRepo(state)) return "data repo not configured; skipped reload";
  const dir = await resolveDataRepo(state.dataRepo!, rootDir);
  const pulled = await pull(dir);
  const synced = await syncSavedChanges(dir);
  return `${pulled.message}; ${synced.message}`;
}

export interface ReloadScheduler {
  /** Currently scheduled frequency in seconds; 0 when stopped. */
  readonly seconds: number;
  /** (Re)start the interval at the given frequency; <= 0 stops it. */
  set(seconds: number): void;
  stop(): void;
}

export function createReloadScheduler(task: () => void | Promise<void>): ReloadScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let current = 0;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    current = 0;
  };
  return {
    get seconds() {
      return current;
    },
    set(seconds: number) {
      stop();
      if (seconds <= 0) return;
      current = seconds;
      timer = setInterval(() => void task(), seconds * 1000);
      timer.unref?.();
    },
    stop,
  };
}
