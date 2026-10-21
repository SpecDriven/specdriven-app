// Per crud-feature.md ("reload data on a cron job"): automatically
// reload (git pull) the data repo every n seconds. The frequency comes from
// the Settings dialog and is persisted in the settings file
// (specs/ui/ui.feature.md). After the pull, locally saved scenarios are
// committed and pushed ("Scenario is automatically saved locally and pushed to
// GitHub").
//
// With the Automerge documents as system of record, one tick also: resolves
// what a pull conflict left behind from the merged documents, and absorbs
// markdown drift (external edits, pre-document repos) into the documents —
// see src/server/automerge/driftSync.ts.

import { autoResolveMergeConflicts, importDrift, mergeInProgress } from "./automerge/driftSync";
import { commitAndPush, pull, syncSavedChanges } from "./git";
import { resolveDataRepo } from "./repo";
import { NOTEBOOK, importPageDrift } from "./pages";
import { ensureSpecsFolder } from "./features";
import { migrateAutomergeLayout, migrateToSpecsFolder } from "./migrate";
import { readState, needsDataRepo } from "./state";
import { checkDataFormat, stampDataFormat } from "./dataFormat";
import { AGENTS_FILE, installAgentsFile } from "./agentsFile";
import { isDemoMode } from "./demoMode";
import { getLogger, withSpan } from "./telemetry";
import { sync as pluginSync } from "../plugins/host/loader";

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
  return syncDataDir(dir);
}

/** The tick itself, on an already-resolved data dir (shared with tests). */
export async function syncDataDir(dir: string): Promise<string> {
  return withSpan("sync.tick", { "specdriven.dir": dir }, async (span) => {
    const pulled = await pull(dir);
    if (!pulled.ok) {
      log.warn(`pull needs attention: ${pulled.message}`, {
        "git.pull.conflicted_files": pulled.conflictedFiles.length,
      });
    }
    const parts = [pulled.message];
    // Data written by a newer app (specs/app/data-format.feature.md): stop
    // before anything below rewrites it, and push nothing. Later ticks keep
    // pulling, so a folder rolled back to a format this app reads recovers.
    const tooNew = await checkDataFormat(dir);
    if (tooNew) {
      span.setAttributes({ "sync.pull.ok": pulled.ok, "sync.data_too_new": true });
      parts.push(`${tooNew.reason}; skipped sync`);
      return parts.filter(Boolean).join("; ");
    }
    if (!pulled.ok && pulled.conflictedFiles.length > 0) {
      parts.push((await autoResolveMergeConflicts(dir, pulled.conflictedFiles)).message);
    }
    // Drift must not be read while conflict markers may sit in the files.
    const merging = await mergeInProgress(dir);
    if (!merging) {
      // The spec tree's folder, before anything reads it. Unlike the folders
      // below it is not opt-in: `specs/` is where features live.
      await ensureSpecsFolder(dir);
      // A repo written before the spec tree had its own folder is moved into
      // it once, here — features and their documents, with the plugins told
      // where each went (an Event Model's slice links name them) — so the
      // drift pass below sees the migrated tree.
      const migrated = await migrateToSpecsFolder(dir, {
        reserved: pluginSync.reserved(),
        moved: (at, moved) => pluginSync.runMoved(at, moved),
      });
      if (migrated > 0) parts.push(`moved ${migrated} feature(s) under specs/`);
      // Documents an older app version filed under the store's per-kind
      // roots are lifted into the mirrored layout, after the step above has
      // put their features under specs/ and before the drift passes look
      // for them.
      const lifted = await migrateAutomergeLayout(dir);
      if (lifted > 0) parts.push(`moved ${lifted} document(s) to the mirrored automerge layout`);
      const drifted = await importDrift(dir);
      if (drifted) parts.push(drifted);
      // The engineering notebook (specs/app/engineering-notebook.feature.md):
      // its entries drift like any page, but the folder is never made here.
      // The switch is on by default, and a default-on module that created a
      // folder would write to every data repo the app opens; the notebook
      // folder appears with the first entry instead. The pass costs nothing
      // when there is no folder to walk, and it runs whether the switch is on
      // or off — turning the tab off must not strip a teammate's entries of
      // their documents.
      const notebookDrift = await importPageDrift(dir, NOTEBOOK);
      if (notebookDrift) parts.push(notebookDrift);
      // The plugins' own drift passes (src/plugins/host/services.ts), in
      // mount order, after the core's — the roadmap and tasks folders, made
      // here when their switch is on and the repo has none
      // (src/plugins/builtin/pages/host.ts), and an installed plugin's, the
      // Event Models' among them.
      parts.push(...(await pluginSync.run(dir)));
      // The format marker, so an older app stops at this folder; written
      // after the passes above have brought the data up to this format.
      if (await stampDataFormat(dir)) parts.push("wrote the data format marker");
      // The agents' guide to the folder (specs/agents/agents-md.feature.md):
      // the app's template, installed once into a folder that has none and
      // never written over, since the team edits it. It goes in a commit of
      // its own, so the auto-save commit below still says what the user
      // changed rather than "1 feature, 1 file". The demo's copy is reseeded
      // on every page load from demo-data, which carries the file itself.
      if (!isDemoMode() && (await installAgentsFile(dir))) {
        await commitAndPush(dir, AGENTS_FILE, `Add ${AGENTS_FILE}`);
        parts.push(`installed ${AGENTS_FILE}`);
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
