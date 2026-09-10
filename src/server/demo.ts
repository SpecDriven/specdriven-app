// Demo mode (DEMO_MODE=1): the app runs against an ephemeral copy of the
// checked-in demo-data snapshot. The copy has no .git directory, so every
// git operation takes the existing "plain directory" path (src/server/git/
// cli.ts isRepoRoot guards) — saves land locally, pull/push are skipped, and
// nothing ever talks to GitHub. Each page load reseeds a fresh copy, so a
// browser refresh returns the demo to the default dataset.
//
// Code gen sessions run too, simulated (specs/roadmap/demo.md "Demo App"):
// setupDemo fills the pane's injection seams so the app reports one agent —
// Claude in a pane — and drives it with the script in src/server/demoAgent.ts
// instead of a subprocess. Claude Code Desktop, Pi and Codex report unavailable, so
// the session dialog offers no choice and nothing can reach a real CLI.

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  setClaudeAvailability,
  setCodexAvailability,
  setDesktopAvailability,
  setPiAvailability,
} from "./agent";
import { setQueryFactory } from "./agentChat";
import { simulatedQuery } from "./demoAgent";
import { setFolderChooser } from "./folderChooser";
import { getAppRoot } from "./paths";
import { resetSearchCache } from "./search";
import { readState, writeState } from "./state";
import type { SpecDrivenState } from "./state";

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE;
  return v === "1" || v === "true";
}

/**
 * The demo's stand-in identity. A public demo has no OS account worth
 * showing — in a container `os.userInfo()` reports whatever uid the process
 * happens to run as — so the User info dialog and the commits the demo
 * writes both name this fixed user instead.
 */
export const DEMO_USER = {
  username: "Test User",
  login: null,
  name: "Test User",
  email: "test-user@specdriven.demo",
} as const;

/** The pristine snapshot shipped with the app; never written at runtime. */
function demoSource(): string {
  return process.env.DEMO_DATA_DIR || resolve(process.cwd(), "demo-data");
}

/**
 * Settings the demo cannot run without, re-stamped on every reseed so a
 * settings write racing a reseed can never unset them: the bundled git
 * engine (no gh/git binaries probed), no sync cron, and code gen sessions on
 * and pinned to the pane, which here means the simulation (demoAgent.ts).
 * The roadmap folder stays opt-in here as everywhere else (specs/app/roadmap
 * .feature.md): the demo opens on Specs, and a visitor who wants the demo
 * dataset's roadmap pages turns the tab on in Settings. The Models tab is
 * on, though: the dataset ships an Event Model of the water damage claim
 * (demo-data/models/claims/home-claims/) whose slices link that feature
 * (demo-data/specs/claims/home-claims/), so the feature's page offers the
 * canvas and the canvas offers the spec — an example worth nothing behind a
 * setting a visitor would not know to flip.
 */
const DEMO_SETTINGS: Partial<SpecDrivenState> = {
  gitEngine: "js",
  reloadFrequencySeconds: 0,
  codeGen: true,
  codeGenTarget: "pane",
  models: true,
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
  // The coding agent pane, simulated: the app reports the Claude CLI present
  // (so the pane, its toggle and the session dialog are all live) and the
  // other agents absent, then answers every session with the script.
  // Nothing probes PATH and nothing is spawned — see src/server/demoAgent.ts.
  setClaudeAvailability(() => true);
  setPiAvailability(() => false);
  setCodexAvailability(() => false);
  setDesktopAvailability(() => false);
  setQueryFactory(simulatedQuery);
  await reseedDemo();
}
