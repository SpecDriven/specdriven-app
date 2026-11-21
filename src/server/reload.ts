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

import { resolve } from "node:path";
import { Semaphore, type Fiber } from "effect";
import { autoResolveMergeConflicts, importDrift, mergeInProgress } from "./automerge/driftSync";
import { fork, interrupt, promised, run as runProgram } from "./effect/runtime";
import { commitAndPush, pull, syncSavedChanges } from "./git";
import { resolveDataRepo } from "./repo";
import { NOTEBOOK, importPageDrift } from "./pages";
import { ensureSpecsFolder } from "./features";
import { ensureProjectSettings } from "./members";
import { migrateAutomergeLayout, migrateToSpecsFolder } from "./migrate";
import { codeRepoMode, readState, needsDataRepo } from "./state";
import { checkDataFormat, stampDataFormat } from "./dataFormat";
import { AGENTS_FILE, installAgentsFile } from "./agentsFile";
import { isDemoMode } from "./demoMode";
import { getLogger, withSpan } from "./telemetry";
import { RepoLocks } from "./sync/RepoLocks";
import { tickEvery } from "./sync/SyncLoop";
import { pluginGateFor, sync as pluginSync } from "../plugins/host/loader";

export const DEFAULT_RELOAD_SECONDS = 60;

/** Effective reload frequency for a stored value; 0 disables the reload. */
export function normalizeReloadSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RELOAD_SECONDS;
  return Math.floor(n);
}

const log = getLogger("reload");

// Why each data folder's last pull did not bring the remote's changes in,
// while it did not (specs/ui/navigation.feature.md "a link opens on synced
// data"): a link followed right after a failed pull may name a feature that
// has not arrived, and the note for a miss says so rather than "stale". A
// pull that only left conflicts for the documents to resolve is not one.
const pullProblems = new Map<string, string>();

/** Why a folder's last pull failed; null when it went through. */
export function pullProblem(dir: string): string | null {
  return pullProblems.get(dir) ?? null;
}

/**
 * One tick of the cron job: git pull the configured data repo, then commit
 * and push any locally saved scenarios.
 */
export async function reloadData(rootDir: string): Promise<string> {
  const state = await readState(rootDir);
  // A code repository opened directly is the developer's: the app pulls,
  // commits and pushes nothing there (specs/app/code-repo-mode.feature.md).
  if (codeRepoMode(state)) {
    log.debug("a code repository is open; skipped sync");
    return "a code repository is open; skipped sync";
  }
  if (needsDataRepo(state)) {
    log.debug("data repo not configured; skipped reload");
    return "data repo not configured; skipped reload";
  }
  const dir = await resolveDataRepo(state.dataRepo!, rootDir);
  return syncDataDir(dir);
}

// Each folder's sync that has been asked for and not begun: it waits for the
// one that is running.
const waiting = new Map<string, { tick: Promise<string> }>();

/**
 * The tick itself, on an already-resolved data dir (shared with tests). Ticks
 * on one folder take turns (git-operations.md "sync ticks never overlap"):
 * one asked for while another runs — the timer, a manual reload, the
 * start-up pull — waits for it, then runs. Every sync asked for while one
 * is already waiting is that one: a tick that begins after they were all
 * asked for serves each of them, so a row of requests costs one tick, not a
 * tick apiece.
 */
export function syncDataDir(dir: string): Promise<string> {
  const key = resolve(dir);
  const queued = waiting.get(key);
  if (queued) return queued.tick;
  const asked = Date.now();
  const mine = {} as { tick: Promise<string> };
  waiting.set(key, mine);
  mine.tick = runProgram(
    RepoLocks.use((locks) =>
      locks.withTick(
        dir,
        promised(() => {
          // Begun: whoever asks from here on wants a tick after this one.
          if (waiting.get(key) === mine) waiting.delete(key);
          return tick(dir, asked);
        }),
      ),
    ),
  );
  // A tick that never began — the app is shutting down — is nobody's to wait for.
  mine.tick.catch(() => {
    if (waiting.get(key) === mine) waiting.delete(key);
  });
  return mine.tick;
}

async function tick(dir: string, asked: number): Promise<string> {
  return withSpan("sync.tick", { "specdriven.dir": dir }, async (span) => {
    const pulled = await pull(dir, asked);
    if (pulled.ok || pulled.conflictedFiles.length > 0) pullProblems.delete(dir);
    else pullProblems.set(dir, pulled.message);
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
      // The project's settings file (specs/app/project-settings.feature.md
      // "The settings file is created for every data folder"): made empty
      // here when the folder has none, so the Project settings page always
      // has a file to edit; committed and pushed below like any saved
      // change. Not in the demo, whose dataset ships its own.
      if (!isDemoMode() && (await ensureProjectSettings(dir))) parts.push("created project-settings.json");
      // A repo written before the spec tree had its own folder is moved into
      // it once, here — features and their documents, with the plugins told
      // where each went (an Event Model's slice links name them) — so the
      // drift pass below sees the migrated tree.
      const migrated = await migrateToSpecsFolder(dir, {
        reserved: pluginSync.reserved(),
        moved: (at, moved) => pluginSync.runMoved(at, moved, pluginGateFor(at)),
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
      // The hooks of the plugins this folder has on — not of one mounted
      // for another open folder (specs/app/multiple-windows.feature.md).
      parts.push(...(await pluginSync.run(dir, pluginGateFor(dir))));
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

/**
 * Run `task` every `seconds` (sync/SyncLoop.ts): a task slower than the
 * interval is never entered twice, and a new frequency or a stop takes
 * effect after the running task ends instead of cutting it short.
 */
export function createReloadScheduler(task: () => void | Promise<void>): ReloadScheduler {
  const oneAtATime = Semaphore.makeUnsafe(1);
  let loop: Fiber.Fiber<never, never> | null = null;
  let current = 0;
  const stop = () => {
    if (loop) interrupt(loop);
    loop = null;
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
      loop = fork(tickEvery(seconds * 1000, promised(async () => task()), oneAtATime));
    },
    stop,
  };
}
