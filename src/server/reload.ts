// Per specs/crud-feature.spec.md ("reload data on a cron job"): automatically
// reload (git pull) the data repo every n seconds. The frequency comes from
// the Settings dialog and is persisted in the settings file (specs/ui.spec.md).
// After the pull, locally saved scenarios are committed and pushed
// ("Scenario is automatically saved locally and pushed to GitHub").
//
// With the Automerge documents as system of record, one tick also: resolves
// what a pull conflict left behind from the merged documents, and absorbs
// markdown drift (external edits, pre-document repos) into the documents —
// see src/server/automerge/driftSync.ts.

import { autoResolveMergeConflicts, importDrift, mergeInProgress } from "./automerge/driftSync";
import { pull, syncSavedChanges } from "./git";
import { resolveDataRepo } from "./repo";
import { ROADMAP, TASKS, ensurePageFolder, importPageDrift, type PageFolder } from "./pages";
import { ensureModelsFolder, importModelDrift } from "./models";
import { readState, needsDataRepo, normalizeModels, normalizeRoadmap, normalizeTasks } from "./state";
import { getLogger, withSpan } from "./telemetry";

export const DEFAULT_RELOAD_SECONDS = 60;

/** Effective reload frequency for a stored value; 0 disables the reload. */
export function normalizeReloadSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RELOAD_SECONDS;
  return Math.floor(n);
}

const log = getLogger("reload");

/**
 * One tick of the cron job: git pull the configured data repo, then commit
 * and push any locally saved scenarios.
 */
export async function reloadData(rootDir: string): Promise<string> {
  const state = await readState(rootDir);
  if (needsDataRepo(state)) {
    log.debug("data repo not configured; skipped reload");
    return "data repo not configured; skipped reload";
  }
  const dir = await resolveDataRepo(state.dataRepo!, rootDir);
  return syncDataDir(dir, {
    roadmap: normalizeRoadmap(state.roadmap),
    tasks: normalizeTasks(state.tasks),
    models: normalizeModels(state.models),
  });
}

/** What a tick does beyond pulling and pushing. */
export interface SyncOptions {
  /**
   * The Roadmap setting (specs/app/roadmap.feature.md): on, the tick makes
   * sure the `roadmap` folder exists and keeps its pages' documents in step
   * with their markdown. Off, the folder is none of the app's business.
   */
  roadmap?: boolean;
  /** The Tasks setting (specs/app/tasks.feature.md), the same for `tasks`. */
  tasks?: boolean;
  /** The Models setting (roadmap/support-event-modeling.md), the same for
      `models` — Event Model JSON files rather than markdown pages. */
  models?: boolean;
}

/** The tick itself, on an already-resolved data dir (shared with tests). */
export async function syncDataDir(
  dir: string,
  { roadmap = false, tasks = false, models = false }: SyncOptions = {},
): Promise<string> {
  return withSpan("sync.tick", { "specdriven.dir": dir }, async (span) => {
    const pulled = await pull(dir);
    if (!pulled.ok) {
      log.warn(`pull needs attention: ${pulled.message}`, {
        "git.pull.conflicted_files": pulled.conflictedFiles.length,
      });
    }
    const parts = [pulled.message];
    if (!pulled.ok && pulled.conflictedFiles.length > 0) {
      parts.push((await autoResolveMergeConflicts(dir, pulled.conflictedFiles)).message);
    }
    // Drift must not be read while conflict markers may sit in the files.
    const merging = await mergeInProgress(dir);
    if (!merging) {
      const drifted = await importDrift(dir);
      if (drifted) parts.push(drifted);
      // Scenario "Create roadmap folder if necessary", and its twin for the
      // tasks folder: the folder is made here when the setting asks for one
      // and the repo has none — and the push below commits everything in it,
      // like any other saved change.
      const shown: PageFolder[] = [
        ...(roadmap ? [ROADMAP] : []),
        ...(tasks ? [TASKS] : []),
      ];
      for (const kind of shown) {
        await ensurePageFolder(dir, kind);
        const drift = await importPageDrift(dir, kind);
        if (drift) parts.push(drift);
      }
      // The models folder (roadmap/support-event-modeling.md): the same,
      // for the Event Models' JSON files and their documents.
      if (models) {
        await ensureModelsFolder(dir);
        const drift = await importModelDrift(dir);
        if (drift) parts.push(drift);
      }
    }
    const synced = await syncSavedChanges(dir);
    parts.push(synced.message);
    span.setAttributes({
      "sync.pull.ok": pulled.ok,
      "sync.merge_in_progress": merging,
      "sync.pushed": synced.pushed,
    });
    return parts.filter(Boolean).join("; ");
  });
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
