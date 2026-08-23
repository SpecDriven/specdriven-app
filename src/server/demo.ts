// Demo mode (DEMO_MODE=1): the app runs against an ephemeral copy of the
// checked-in demo-data snapshot. The copy has no .git directory, so every
// git operation takes the existing "plain directory" path (src/server/git/
// cli.ts isRepoRoot guards) — saves land locally, pull/push are skipped, and
// nothing ever talks to GitHub. Each page load reseeds a fresh copy, so a
// browser refresh returns the demo to the default dataset.

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setFolderChooser } from "./folderChooser";
import { getAppRoot } from "./paths";
import { resetSearchCache } from "./search";
import { readState, writeState } from "./state";
import type { SpecDrivenState } from "./state";

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE;
  return v === "1" || v === "true";
}

/** The pristine snapshot shipped with the app; never written at runtime. */
function demoSource(): string {
  return process.env.DEMO_DATA_DIR || resolve(process.cwd(), "demo-data");
}

/**
 * Settings the demo cannot run without, re-stamped on every reseed so a
 * settings write racing a reseed can never unset them: the bundled git
 * engine (no gh/git binaries probed), no sync cron, no code gen sessions.
 */
const DEMO_SETTINGS: Partial<SpecDrivenState> = {
  gitEngine: "js",
  reloadFrequencySeconds: 0,
  codeGen: false,
};

/** How long in-flight requests may keep using a replaced generation dir. */
const OLD_GENERATION_TTL_MS = 30_000;

let generation = 0;
let currentDir: string | null = null;
/** Reseeds run one at a time; concurrent page loads share the queue. */
let turn: Promise<void> = Promise.resolve();

/**
 * Copy the pristine dataset into a NEW generation directory and point
 * settings at it. A fresh directory per reseed keeps the switch atomic:
 * requests already resolved against the old dir finish against a complete
 * tree, which is deleted only after a grace period.
 */
export function reseedDemo(): Promise<void> {
  const run = turn.then(async () => {
    const gen = ++generation;
    const dir = join(getAppRoot(), `data-${gen}`);
    await cp(demoSource(), dir, { recursive: true });
    const state = await readState(getAppRoot());
    await writeState(
      { ...state, ...DEMO_SETTINGS, dataRepo: dir, recentDataRepos: [dir] },
      getAppRoot(),
    );
    const old = currentDir;
    currentDir = dir;
    resetSearchCache();
    if (old) {
      setTimeout(() => void rm(old, { recursive: true, force: true }), OLD_GENERATION_TTL_MS)
        .unref?.();
    }
  });
  turn = run.catch(() => {});
  return run;
}

/**
 * Demo bootstrap, called before applyStartupState() so startup already reads
 * the demo settings. Confines every read/write — settings, token store, log
 * files — under the demo root, away from the user's real ~/.specdriven, and
 * removes the native folder chooser (Browse… hides, /api/choose-folder 501s).
 */
export async function setupDemo(): Promise<void> {
  process.env.SPECDRIVEN_ROOT ||= "/tmp/specdriven-demo";
  process.env.SPECDRIVEN_HOME = join(getAppRoot(), "home");
  await mkdir(getAppRoot(), { recursive: true });
  setFolderChooser(null);
  await reseedDemo();
}
