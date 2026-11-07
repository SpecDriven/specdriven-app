// The read-only site's data (src/server/readOnlyMode.ts): a shallow clone
// of the public spec repo — the mirror, which only this module touches —
// and, served from beside it, a .git-less snapshot of the mirror's tree. The
// snapshot takes the app's "plain directory" path for every git operation
// (src/server/git/cli.ts isRepoRoot guards), as the demo's dataset does, so
// nothing the app does there can commit or push.
//
// Every refresh fetches the branch; when it moved, the mirror follows and a
// NEW snapshot directory is made, absorbed (the sync tick's drift passes, so
// a markdown edit pushed without its document still shows) and only then
// put in the settings — the switch is atomic, and requests already resolved
// against the old snapshot finish against a complete tree, deleted after a
// grace period. Open pages refresh on the cadence /api/state reports.

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { setFolderChooser } from "./folderChooser";
import { getAppRoot } from "./paths";
import { READ_ONLY_PLUGINS, readReadOnlyConfig, setReadOnlySite, type ReadOnlyConfig } from "./readOnlyMode";
import { syncDataDir } from "./reload";
import { resetSearchCache } from "./search";
import { readState, writeState, type SpecDrivenState } from "./state";

export { isReadOnlyMode, READ_ONLY_REFUSAL, READ_ONLY_USER, readOnlyAllows } from "./readOnlyMode";

/**
 * Settings the site cannot run without, stamped on every snapshot: the
 * bundled git engine (no gh or credentials probed), no sync cron, no coding
 * agents, test links to GitHub rather than IntelliJ, and the plugin profile
 * of the open snapshot naming the roadmap alone — no other built-in, and
 * every plugin seen, so the loader adopts nothing it finds.
 */
function siteSettings(dir: string): Partial<SpecDrivenState> {
  return {
    dataRepo: dir,
    recentDataRepos: [dir],
    gitEngine: "js",
    reloadFrequencySeconds: 0,
    codeGen: false,
    openTestsInIdea: false,
    ghostty: false,
    showTestLinks: true,
    plugins: { seen: [...READ_ONLY_PLUGINS], repos: { [dir]: { enabled: [...READ_ONLY_PLUGINS] } } },
  };
}

/** How long in-flight requests may keep using a replaced snapshot. */
const OLD_SNAPSHOT_TTL_MS = 30_000;

let config: ReadOnlyConfig | null = null;
let snapshot = 0;
let currentDir: string | null = null;
/** The mirror commit the open snapshot was made from. */
let currentCommit: string | null = null;
/** Refreshes run one at a time. */
let turn: Promise<unknown> = Promise.resolve();

const mirrorDir = () => join(getAppRoot(), "mirror");

/**
 * Git without a prompt — a repo that wants credentials fails at once — and
 * a failure that says what git said. Resolves to its trimmed stdout.
 */
async function git(...args: string[]): Promise<string> {
  const out = await $`git ${args}`.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" }).nothrow().quiet();
  if (out.exitCode !== 0) throw new Error(out.stderr.toString().trim() || `git ${args[0]} exited ${out.exitCode}`);
  return out.stdout.toString().trim();
}

async function cloneMirror(cfg: ReadOnlyConfig): Promise<void> {
  await rm(mirrorDir(), { recursive: true, force: true });
  await git("clone", "--quiet", "--depth", "1", "--single-branch", "--branch", cfg.branch, "--", cfg.repo, mirrorDir());
}

/** Fetch the branch; true when the mirror moved to a commit not yet shown. */
async function fetchMirror(cfg: ReadOnlyConfig): Promise<boolean> {
  await git("-C", mirrorDir(), "fetch", "--quiet", "--depth", "1", "origin", cfg.branch);
  const fetched = await git("-C", mirrorDir(), "rev-parse", "FETCH_HEAD");
  if (fetched === currentCommit) return false;
  await git("-C", mirrorDir(), "reset", "--quiet", "--hard", fetched);
  return true;
}

/** Copy the mirror's tree, .git left out, into a new snapshot and open it. */
async function takeSnapshot(): Promise<string> {
  const commit = await git("-C", mirrorDir(), "rev-parse", "HEAD");
  const dir = join(getAppRoot(), `snapshot-${++snapshot}`);
  const gitDir = join(mirrorDir(), ".git");
  await cp(mirrorDir(), dir, { recursive: true, filter: (src) => src !== gitDir });
  // Absorbed before anyone is shown it: the drift passes bring documents in
  // step with markdown pushed without them. Pull and push are skipped — the
  // copy is no repository.
  await syncDataDir(dir);
  const state = await readState(getAppRoot());
  await writeState({ ...state, ...siteSettings(dir) }, getAppRoot());
  const old = currentDir;
  currentDir = dir;
  currentCommit = commit;
  resetSearchCache();
  if (old) {
    setTimeout(() => void rm(old, { recursive: true, force: true }), OLD_SNAPSHOT_TTL_MS).unref?.();
  }
  return commit;
}

/**
 * One refresh: fetch, and when the branch moved, a new snapshot. A failure
 * is logged and the site keeps showing the snapshot it has.
 */
export function refreshReadOnly(): Promise<void> {
  const run = turn.then(async () => {
    if (!config) return;
    try {
      if (!(await fetchMirror(config))) return;
      const commit = await takeSnapshot();
      console.log(`[read-only] showing ${config.repo}@${commit.slice(0, 7)}`);
    } catch (e) {
      console.error(`[read-only] refresh failed: ${(e as Error).message}`);
    }
  });
  turn = run;
  return run;
}

/**
 * The site's bootstrap, before applyStartupState() so startup reads the
 * snapshot's settings: every file under the site root, no native folder
 * chooser, the repo cloned and its first snapshot open. A repo that cannot
 * be cloned stops the start — the platform restarts the service — rather
 * than serve a site with no specs.
 */
export async function setupReadOnly(env: Record<string, string | undefined> = process.env): Promise<void> {
  config = readReadOnlyConfig(env);
  setReadOnlySite(config);
  process.env.SPECDRIVEN_ROOT ||= "/tmp/specdriven-readonly";
  process.env.SPECDRIVEN_HOME = join(getAppRoot(), "home");
  await mkdir(getAppRoot(), { recursive: true });
  // A restart keeps /tmp: the last run's snapshots go, the mirror is cloned anew.
  for (const name of await readdir(getAppRoot())) {
    if (name.startsWith("snapshot-")) await rm(join(getAppRoot(), name), { recursive: true, force: true });
  }
  setFolderChooser(null);
  try {
    await cloneMirror(config);
  } catch (e) {
    throw new Error(`Could not clone ${config.repo} (${config.branch}): ${(e as Error).message}`);
  }
  const commit = await takeSnapshot();
  console.log(`[read-only] showing ${config.repo}@${commit.slice(0, 7)}`);
  if (config.refreshSeconds > 0) {
    setInterval(() => void refreshReadOnly(), config.refreshSeconds * 1000).unref?.();
  }
}
