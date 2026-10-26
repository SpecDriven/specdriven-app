// Demo mode (DEMO_MODE=1): the app runs against an ephemeral copy of the
// checked-in demo-data snapshot. The copy has no .git directory, so every
// git operation takes the existing "plain directory" path (src/server/git/
// cli.ts isRepoRoot guards) — saves land locally, pull/push are skipped, and
// nothing ever talks to GitHub. Each page load reseeds a fresh copy, so a
// browser refresh returns the demo to the default dataset.
//
// Code gen sessions run too, simulated (roadmap/demo.md "Demo App"):
// setupDemo registers a simulated provider under Claude's id, so the app
// reports one agent — Claude in a pane — and drives it with the script in
// src/server/demoAgent.ts instead of a subprocess. Claude Code Desktop, Pi and Codex report unavailable, so
// the session dialog offers no choice and nothing can reach a real CLI.
//
// Plugins from the marketplace load too (specs/app/plugins.feature.md): at
// start the demo installs the ones DEMO_MARKETPLACE_PLUGINS names — the
// Event Models — from the SpecDriven marketplace into its own home, the way
// Install does, and the profile lists them after the built-ins. Visitors
// browse the marketplace but cannot install, update or remove anything.

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setCodexAvailability, setDesktopAvailability, setPiAvailability } from "./agent";
import { agents } from "../plugins/host/agents";
import { simulatedProvider } from "./demoAgent";
import { setFolderChooser } from "./folderChooser";
import { getAppRoot } from "./paths";
import { resetSearchCache } from "./search";
import { readState, writeState } from "./state";
import { confirmInstall } from "../plugins/host/marketplace";
import { rescanPlugins } from "../plugins/host/loader";
import { discoverPlugins } from "../plugins/host/sources";
import { DEFAULT_MARKETPLACES, type MarketplaceRef } from "../plugins/marketplace";
import { version as appVersion } from "../../package.json";
import type { SpecDrivenState } from "./state";

export { DEMO_ISSUES_REPO, DEMO_USER, isDemoMode } from "./demoMode";

/** The pristine snapshot shipped with the app; never written at runtime. */
function demoSource(): string {
  return process.env.DEMO_DATA_DIR || resolve(process.cwd(), "demo-data");
}

/**
 * Settings the demo cannot run without, re-stamped on every reseed so a
 * settings write racing a reseed can never unset them: the bundled git
 * engine (no gh/git binaries probed), no sync cron, and code gen sessions on
 * and pinned to the pane, which here means the simulation (demoAgent.ts).
 *
 * Every optional module is on. A visitor has no reason to guess which
 * switches hide the rest of the app, and the demo dataset ships content for
 * each: roadmap and tasks pages, test cases, assignable members in
 * demo-data/project-settings.json, and the release repo's issues — and an
 * Event Model of the water damage claim (demo-data/models/claims/
 * home-claims/) for the Models plugin, which is not built in any more: the
 * demo installs it from the marketplace at start (installDemoPlugins) and
 * lists it here, so its tab shows as soon as it has loaded. The one
 * exception is "Open test links in IntelliJ IDEA" (openTestsInIdea): it runs
 * `idea` on the visitor's own machine, which a hosted demo has no business
 * doing and no server-side `idea` to do it with — so test links keep going
 * to GitHub, and that switch stays off (specs/traceability.feature.md).
 */
/**
 * The marketplace plugins the demo installs at start, by the index row's
 * name in the marketplace and the id its manifest declares.
 */
export const DEMO_MARKETPLACE_PLUGINS: readonly { marketplace: string; name: string; id: string }[] = [
  { marketplace: "specdriven", name: "models", id: "models" },
];

const DEMO_SETTINGS: Partial<SpecDrivenState> = {
  gitEngine: "js",
  reloadFrequencySeconds: 0,
  codeGen: true,
  codeGenTarget: "claude",
  // No plugin list: each reseed's fresh data folder shows Specs alone
  // (specs/app/plugins.feature.md "Each data folder keeps its own plugins"),
  // and a visitor switches plugins on in Settings → Plugins. The empty
  // `repos` says the file keeps per-folder lists, so it is not read as one
  // from before them (src/plugins/profile.ts startFolderLists). The ones the
  // demo installs from the marketplace count as seen, so the loader lists
  // them off rather than adopting them. No `marketplaces` key: the default
  // SpecDriven index.
  plugins: {
    seen: DEMO_MARKETPLACE_PLUGINS.map((p) => p.id),
    repos: {},
  },
  assignments: true,
  featureFlags: true,
  scenarioPolarity: true,
  deletePublished: true,
  googleCalendar: true,
  showTestLinks: true,
  projectManagement: true,
  publishExternalLinks: true,
  ahaLinks: true,
  figmaLinks: true,
  qtestLinks: true,
  openTestsInIdea: false,
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
  // The coding agent pane, simulated: the script stands in for the Claude
  // provider (so the pane, its toggle and the session dialog are all live)
  // and the other agents report absent. Nothing probes PATH and nothing is
  // spawned — see src/server/demoAgent.ts. The demo never auto-installs
  // agent plugins either: its agent is this one.
  agents.register(simulatedProvider);
  setPiAvailability(() => false);
  setCodexAvailability(() => false);
  setDesktopAvailability(() => false);
  await reseedDemo();
}

/**
 * Install the plugins DEMO_MARKETPLACE_PLUGINS names into the demo's home
 * (src/plugins/host/marketplace.ts: the marketplace cloned through the
 * app's git engine, the plugin staged, checked against this app and moved
 * into `plugins/`), skipping one already there — a restart keeps /tmp. The
 * operator chose them, so there is no consent step. Started after setupDemo
 * without being awaited: the server answers meanwhile, and the loader
 * mounts each plugin and tells open pages once its folder appears. A
 * plugin that cannot be fetched is logged and its tab stays away; the rest
 * of the demo is unaffected. `marketplaces` is for the tests.
 */
export async function installDemoPlugins(
  marketplaces: readonly MarketplaceRef[] = DEFAULT_MARKETPLACES,
): Promise<void> {
  const present = await discoverPlugins({ dataDir: null, paths: [], appVersion });
  for (const want of DEMO_MARKETPLACE_PLUGINS) {
    if (present.some((p) => p.id === want.id && !p.error)) continue;
    const entry = marketplaces.find((m) => m.name === want.marketplace);
    try {
      if (!entry) throw new Error(`no marketplace named "${want.marketplace}"`);
      await confirmInstall(entry, want.name);
    } catch (e) {
      console.error(`[demo] could not install ${want.name} from ${want.marketplace}: ${(e as Error).message}`);
    }
  }
  await rescanPlugins();
}
