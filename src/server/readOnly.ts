// The read-only site's data (src/server/readOnlyMode.ts): for each project
// a shallow clone of its public spec repo — the mirror, which only this
// module touches — and, served from beside it, a .git-less snapshot of the
// mirror's tree. The snapshot takes the app's "plain directory" path for
// every git operation (src/server/git/cli.ts isRepoRoot guards), as the
// demo's dataset does, so nothing the app does there can commit or push.
//
// Each project is a workspace (src/server/workspace.ts) whose folder is its
// open snapshot; a visitor's request runs in the one their cookie names
// (readOnlyMode.ts readOnlyWorkspace). Every refresh fetches each project's
// branch; when it moved, the mirror follows and a NEW snapshot directory is
// made, absorbed (the sync tick's drift passes, so a markdown edit pushed
// without its document still shows) and only then made the workspace's
// folder — the switch is atomic, and requests already resolved against the
// old snapshot finish against a complete tree, deleted after a grace
// period. Open pages refresh on the cadence /api/state reports.

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { setFolderChooser } from "./folderChooser";
import { getAppRoot } from "./paths";
import {
  READ_ONLY_PLUGINS,
  readReadOnlyConfig,
  setReadOnlySite,
  setReadOnlyWorkspace,
  type ReadOnlyConfig,
  type ReadOnlyProject,
} from "./readOnlyMode";
import { PROFILE_FORMAT } from "../plugins/profile";
import { ungatePlugins } from "../plugins/host/loader";
import { syncDataDir } from "./reload";
import { resetSearchCache } from "./search";
import { readState, writeState, type SpecDrivenState } from "./state";
import { detached, openWorkspace, setWorkspaceFolder, type Workspace } from "./workspace";

export { isReadOnlyMode, READ_ONLY_REFUSAL, READ_ONLY_USER, readOnlyAllows } from "./readOnlyMode";

/**
 * Settings the site cannot run without, stamped on every snapshot: the
 * bundled git engine (no gh or credentials probed), no sync cron, no coding
 * agents, test links to GitHub rather than IntelliJ, and the plugin profile
 * of every open snapshot naming Specs and the roadmap alone — no other
 * built-in, and every plugin seen, so the loader adopts nothing it finds.
 * The first project's snapshot is the folder the settings file names.
 */
function siteSettings(dirs: string[]): Partial<SpecDrivenState> {
  return {
    dataRepo: dirs[0],
    recentFolders: dirs.map((path) => ({ path, kind: "spec" as const })),
    gitEngine: "js",
    reloadFrequencySeconds: 0,
    codeGen: false,
    openTestsInIdea: false,
    ghostty: false,
    showTestLinks: true,
    plugins: {
      seen: [...READ_ONLY_PLUGINS],
      repos: Object.fromEntries(dirs.map((dir) => [dir, { enabled: [...READ_ONLY_PLUGINS] }])),
      format: PROFILE_FORMAT,
    },
  };
}

/** How long in-flight requests may keep using a replaced snapshot. */
const OLD_SNAPSHOT_TTL_MS = 30_000;

/** A project as this module keeps it. */
interface Shown {
  project: ReadOnlyProject;
  /** The open snapshot. */
  dir: string | null;
  /** The mirror commit the open snapshot was made from. */
  commit: string | null;
  /** Where its visitors' requests run; registered once its first snapshot is open. */
  workspace: Workspace | null;
}

let config: ReadOnlyConfig | null = null;
let shown: Shown[] = [];
let snapshot = 0;
/** Refreshes run one at a time. */
let turn: Promise<unknown> = Promise.resolve();

const mirrorDir = (p: ReadOnlyProject) => join(getAppRoot(), "mirrors", p.id);

/**
 * Git without a prompt — a repo that wants credentials fails at once — and
 * a failure that says what git said. Resolves to its trimmed stdout.
 */
async function git(...args: string[]): Promise<string> {
  const out = await $`git ${args}`.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" }).nothrow().quiet();
  if (out.exitCode !== 0) throw new Error(out.stderr.toString().trim() || `git ${args[0]} exited ${out.exitCode}`);
  return out.stdout.toString().trim();
}

async function cloneMirror(p: ReadOnlyProject): Promise<void> {
  await rm(mirrorDir(p), { recursive: true, force: true });
  await mkdir(join(getAppRoot(), "mirrors"), { recursive: true });
  await git("clone", "--quiet", "--depth", "1", "--single-branch", "--branch", p.branch, "--", p.repo, mirrorDir(p));
}

/** Fetch the branch; true when the mirror moved to a commit not yet shown. */
async function fetchMirror(s: Shown): Promise<boolean> {
  await git("-C", mirrorDir(s.project), "fetch", "--quiet", "--depth", "1", "origin", s.project.branch);
  const fetched = await git("-C", mirrorDir(s.project), "rev-parse", "FETCH_HEAD");
  if (fetched === s.commit) return false;
  await git("-C", mirrorDir(s.project), "reset", "--quiet", "--hard", fetched);
  return true;
}

/** Copy a project's mirror tree, .git left out, into a new snapshot and open it. */
async function takeSnapshot(s: Shown): Promise<string> {
  const mirror = mirrorDir(s.project);
  const commit = await git("-C", mirror, "rev-parse", "HEAD");
  const dir = join(getAppRoot(), `snapshot-${s.project.id}-${++snapshot}`);
  const gitDir = join(mirror, ".git");
  await cp(mirror, dir, { recursive: true, filter: (src) => src !== gitDir });
  // Absorbed before anyone is shown it: the drift passes bring documents in
  // step with markdown pushed without them. Pull and push are skipped — the
  // copy is no repository. Nobody's work: no visitor's project is behind it.
  await detached(async () => {
    await syncDataDir(dir);
    const old = s.dir;
    s.dir = dir;
    s.commit = commit;
    const dirs = shown.flatMap((x) => x.dir ?? []);
    const state = await readState(getAppRoot());
    await writeState({ ...state, ...siteSettings(dirs) }, getAppRoot());
    if (s.workspace) setWorkspaceFolder(s.workspace, { dataRepo: dir });
    resetSearchCache();
    if (old) {
      setTimeout(() => void rm(old, { recursive: true, force: true }), OLD_SNAPSHOT_TTL_MS).unref?.();
    }
  });
  return commit;
}

/**
 * One refresh: fetch every project, and a new snapshot of each whose branch
 * moved. A failure is logged and that project keeps showing the snapshot
 * it has.
 */
export function refreshReadOnly(): Promise<void> {
  const run = turn.then(async () => {
    for (const s of shown) {
      try {
        if (!(await fetchMirror(s))) continue;
        const commit = await takeSnapshot(s);
        console.log(`[read-only] showing ${s.project.repo}@${commit.slice(0, 7)}`);
      } catch (e) {
        console.error(`[read-only] refresh of ${s.project.repo} failed: ${(e as Error).message}`);
      }
    }
  });
  turn = run;
  return run;
}

/**
 * The site's bootstrap, before applyStartupState() so startup reads the
 * snapshots' settings: every file under the site root, no native folder
 * chooser, every project's repo cloned, its first snapshot open and its
 * workspace registered. A repo that cannot be cloned stops the start — the
 * platform restarts the service — rather than serve a site missing specs.
 */
export async function setupReadOnly(env: Record<string, string | undefined> = process.env): Promise<void> {
  config = readReadOnlyConfig(env);
  setReadOnlySite(config);
  ungatePlugins();
  process.env.SPECDRIVEN_ROOT ||= "/tmp/specdriven-readonly";
  process.env.SPECDRIVEN_HOME = join(getAppRoot(), "home");
  await mkdir(getAppRoot(), { recursive: true });
  // A restart keeps /tmp: the last run's snapshots go, the mirrors are cloned anew.
  for (const name of await readdir(getAppRoot())) {
    if (name.startsWith("snapshot-")) await rm(join(getAppRoot(), name), { recursive: true, force: true });
  }
  setFolderChooser(null);
  shown = config.projects.map((project) => ({ project, dir: null, commit: null, workspace: null }));
  for (const s of shown) {
    try {
      await cloneMirror(s.project);
    } catch (e) {
      throw new Error(`Could not clone ${s.project.repo} (${s.project.branch}): ${(e as Error).message}`);
    }
    const commit = await takeSnapshot(s);
    s.workspace = openWorkspace(`read-only:${s.project.id}`, { dataRepo: s.dir! });
    setReadOnlyWorkspace(s.project.id, s.workspace);
    console.log(`[read-only] showing ${s.project.repo}@${commit.slice(0, 7)} as "${s.project.id}"`);
  }
  if (config.refreshSeconds > 0) {
    setInterval(() => void refreshReadOnly(), config.refreshSeconds * 1000).unref?.();
  }
}
