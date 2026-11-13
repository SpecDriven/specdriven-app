// The marketplace on the host (specs/app/plugins.feature.md "The marketplace
// is a git repository with an index", "A plugin from the marketplace is
// installed with consent"): each marketplace the profile names is cloned
// (by the first way that works: system git, built-in git, gh) or pulled into
// `~/.specdriven/marketplaces/<name>` and its `marketplace.json` read; an
// install clones the plugin pinned to the ref the index names (or copies
// the marketplace's subdirectory) into a staging folder, reads its manifest
// and checks it against this app, and only a confirming call moves it into
// `~/.specdriven/plugins/<id>` — so a refused plugin leaves nothing behind
// and nothing runs before the user has seen what it is. Update fetches the
// ref the index names now; Remove deletes the folder; Reinstall — or Install
// of an id already installed, from this marketplace or another — stages a
// fresh copy the same way and, on a confirmation that says so, swaps it in
// for the folder that is there. The loader notices the folder change and
// mounts, remounts or unwinds the plugin.
//
// A plugin with a `release` folder (specs/app/plugins.feature.md "A plugin
// is released as a versioned zip in its release folder") is installed from
// a zip in it instead of from its source folder: the newest version this
// app can run, or the one asked for — its checksum checked against
// `releases.json` before it is unpacked. The zips are in the marketplace's
// clone already, so putting an older version back needs no network.

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { version as appVersion } from "../../../package.json";
import { checkoutRef, clonePluginRepo, commitAllAndPublish, headCommit, pull } from "../../server/git";
import { bodyOf, json, type Handler } from "../../server/http";
import { builtinManifests, profileManifests } from "../builtin/manifests";
import {
  INSTALL_RECORD_FILE,
  RELEASE_DIR,
  RELEASES_FILE,
  DEFAULT_MARKETPLACES,
  compareVersions,
  indexRowRefusal,
  isDefaultMarketplace,
  isPrerelease,
  marketplaceEntries,
  marketplaceNameFor,
  newestInstallable,
  parseMarketplaceIndex,
  parseReleases,
  permanentMarketplaces,
  releaseOf,
  releaseRefusal,
  subdirectorySource,
  type InstallRecord,
  type MarketplaceIndex,
  type MarketplacePlugin,
  type MarketplaceRef,
  type PluginRelease,
} from "../marketplace";
import { PROFILE_KEY, dropPlugin } from "../profile";
import { externalPlugin, notifyPluginChange, pluginStates, rebuildPlugin, rescanPlugins, type PluginState } from "./loader";
import { marketplacesHome, pluginsHome, readPluginFolder, safeId } from "./sources";
import { unzipInto } from "./zip";

/** A marketplace as Settings lists it: its cache, its index, or why it has none. */
export interface MarketplaceStatus extends MarketplaceRef {
  dir: string;
  index?: MarketplaceIndex;
  /** Reported beside the name; the other marketplaces still show. */
  error?: string;
}

/**
 * Every marketplace named, cloned when its cache is missing and pulled when
 * asked to refresh — cloned afresh when the pull fails, unless `reclone` is
 * false — with its index read. One that fails to clone, pull or
 * parse is reported on its own row and does not hide the others.
 */
export async function loadMarketplaces(
  entries: readonly MarketplaceRef[],
  opts: { refresh?: boolean; reclone?: boolean } = {},
): Promise<MarketplaceStatus[]> {
  return Promise.all(
    entries.map(async (entry): Promise<MarketplaceStatus> => {
      const dir = join(marketplacesHome(), entry.name);
      try {
        // A cache with no index yet — cloned before the index was pushed —
        // is pulled on Browse too, not only on Refresh.
        const stale = !(await exists(join(dir, "marketplace.json")));
        await cacheMarketplace(entry, dir, opts.refresh === true || stale, opts.reclone !== false);
        return { ...entry, dir, index: await readIndex(dir) };
      } catch (e) {
        return { ...entry, dir, error: (e as Error).message };
      }
    }),
  );
}

/** A marketplace's index from its cache, cloning first when there is none. */
export async function marketplaceIndex(entry: MarketplaceRef, refresh = false): Promise<MarketplaceStatus> {
  const [status] = await loadMarketplaces([entry], { refresh });
  return status!;
}

async function cacheMarketplace(
  entry: MarketplaceRef,
  dir: string,
  refresh: boolean,
  reclone: boolean,
): Promise<void> {
  const cached = await exists(join(dir, ".git"));
  if (!cached) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(marketplacesHome(), { recursive: true });
    await clonePluginRepo(entry.source, dir);
  } else if (refresh) {
    const res = await pull(dir);
    if (res.ok) return;
    if (!reclone) throw new Error(`Could not refresh ${entry.name}: ${res.message}`);
    try {
      await recloneMarketplace(entry, dir);
    } catch (e) {
      throw new Error(`Could not refresh ${entry.name}: ${res.message} — and cloning it afresh failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Throw a marketplace's cache away and clone it afresh: what Refresh does
 * when the cache can no longer be pulled — its upstream history rewritten
 * ("refusing to merge unrelated histories"), a checkout left half-done.
 * The clone goes into a folder beside the cache and takes its place only
 * once it is whole, so a remote that cannot be reached leaves the old copy
 * where it was. Installed plugins are not touched: a subdirectory plugin
 * was copied out of the cache, not linked to it.
 */
async function recloneMarketplace(entry: MarketplaceRef, dir: string): Promise<void> {
  await exclusive(`marketplace ${entry.name}`, "re-cloned", async () => {
    const fresh = join(marketplacesHome(), `.${entry.name}.reclone`);
    await rm(fresh, { recursive: true, force: true });
    await mkdir(marketplacesHome(), { recursive: true });
    try {
      await clonePluginRepo(entry.source, fresh);
    } catch (e) {
      await rm(fresh, { recursive: true, force: true });
      throw e;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rename(fresh, dir);
  });
}

/**
 * The indexes already on disk, without touching git: what a start that
 * cannot reach the marketplaces still knows. A marketplace with no cache
 * or a bad index is left out.
 */
export async function cachedMarketplaceIndexes(
  entries: readonly MarketplaceRef[],
): Promise<{ entry: MarketplaceRef; index: MarketplaceIndex }[]> {
  const out: { entry: MarketplaceRef; index: MarketplaceIndex }[] = [];
  for (const entry of entries) {
    try {
      out.push({ entry, index: await readIndex(join(marketplacesHome(), entry.name)) });
    } catch {
      // Nothing cached yet, or an index the app cannot read.
    }
  }
  return out;
}

async function readIndex(dir: string): Promise<MarketplaceIndex> {
  let text: string;
  try {
    text = await readFile(join(dir, "marketplace.json"), "utf8");
  } catch {
    throw new Error("the repository has no marketplace.json at its root");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`marketplace.json does not parse: ${(e as Error).message}`);
  }
  const index = parseMarketplaceIndex(raw);
  await Promise.all(index.plugins.map((row) => readReleases(dir, row)));
  return index;
}

/**
 * The versions a subdirectory plugin has released, onto its row: each with
 * why this app cannot install it, when it cannot. A plugin with no
 * `release` folder is left as it is — it installs from its source folder —
 * and a `releases.json` that cannot be read is reported on its row alone.
 */
async function readReleases(marketplaceDir: string, row: MarketplacePlugin): Promise<void> {
  const subdir = subdirectorySource(row.source);
  if (subdir === null) return;
  let text: string;
  try {
    text = await readFile(join(marketplaceDir, subdir, RELEASE_DIR, RELEASES_FILE), "utf8");
  } catch {
    return;
  }
  try {
    row.releases = parseReleases(JSON.parse(text), row.name).map((release) => {
      const refusal = releaseRefusal(release, appVersion);
      return refusal ? { ...release, refusal } : release;
    });
  } catch (e) {
    row.releasesError = `${RELEASE_DIR}/${RELEASES_FILE}: ${(e as Error).message}`;
  }
}

/**
 * The released version an install or update means: the one asked for, or
 * the newest this app can run. Throws with the reason when there is none —
 * no such version, one withdrawn, or one this app is too old for.
 */
function pickRelease(row: MarketplacePlugin, version: string | undefined): PluginRelease {
  if (row.releasesError) throw new Error(`${row.name}: ${row.releasesError}`);
  const releases = row.releases ?? [];
  if (version !== undefined) {
    const release = releaseOf(releases, version);
    if (!release) throw new Error(`${row.name} has no released version ${version}`);
    const refusal = releaseRefusal(release, appVersion);
    if (refusal) throw new Error(refusal);
    return release;
  }
  const newest = newestInstallable(releases, appVersion);
  if (newest) return newest;
  const stable = releases.filter((r) => !isPrerelease(r.version));
  const why = stable.map((r) => releaseRefusal(r, appVersion)).find((r) => r !== null);
  throw new Error(
    why ?? (releases.length ? `${row.name} has only pre-release versions; pick one` : `${row.name} has no released version`),
  );
}

/** A version picked on purpose that is older than the newest this app can run is held. */
function heldAt(row: MarketplacePlugin, release: PluginRelease | undefined, asked: string | undefined): boolean {
  if (!release || asked === undefined || !row.releases) return false;
  const newest = newestInstallable(row.releases, appVersion);
  return newest !== undefined && compareVersions(release.version, newest.version) < 0;
}

/** What a record remembers of the version it replaces: that one, when it differs. */
function previousOf(before: string | undefined, next: string | undefined, kept: string | undefined): string | undefined {
  return before && next && compareVersions(before, next) !== 0 ? before : kept;
}

// ---- installing ------------------------------------------------------------

/** What the consent step shows: the plugin as its manifest describes it. */
export interface InstallPreview {
  id: string;
  displayName: string;
  description: string;
  version: string;
  permissions: string[];
  marketplace: string;
  name: string;
  source: string;
  ref?: string;
  commit?: string;
  /**
   * The plugin already installed under this id, which a confirmation with
   * `replace` swaps out: what the consent step says a Reinstall replaces.
   */
  replaces?: InstalledPlugin;
}

/** An installed plugin as the consent step names it. */
export interface InstalledPlugin {
  id: string;
  version?: string;
  marketplace?: string;
  name?: string;
}

/** One install, update or removal at a time per plugin. */
const busy = new Set<string>();

async function exclusive<T>(key: string, what: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(key)) throw new Error(`${key} is already being ${what}`);
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

/** Where a plugin waits between the consent step and the confirmation. */
function stagingDir(name: string): string {
  return join(pluginsHome(), ".staging", safeId(name));
}

/**
 * Fetch a plugin the index names into the staging folder and read what it
 * is — nothing is added to the profile and nothing runs. A plugin the app
 * refuses (its api, its minimum app version, no manifest) is deleted again
 * with the reason. A plugin already installed under the id is named in the
 * preview as what a confirmation with `replace` swaps out; one linked from
 * a folder or shipped with the data folder cannot be replaced and is refused.
 * A released plugin is staged at `version`, or at the newest this app runs.
 */
export async function stageInstall(
  entry: MarketplaceRef,
  name: string,
  version?: string,
): Promise<InstallPreview> {
  return exclusive(name, "installed", async () => {
    const status = await marketplaceIndex(entry);
    if (!status.index) throw new Error(`${entry.name}: ${status.error}`);
    const row = status.index.plugins.find((p) => p.name === name);
    if (!row) throw new Error(`${entry.name} lists no plugin named "${name}"`);
    const early = indexRowRefusal(row);
    if (early) throw new Error(early);

    const staging = stagingDir(name);
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(pluginsHome(), ".staging"), { recursive: true });
    try {
      const { commit, release } = await fetchInto(row, status.dir, staging, version);
      const found = await readPluginFolder(staging, "home", appVersion);
      if (!found) throw new Error("the plugin has no package.json");
      if (found.error) throw new Error(found.error);
      const manifest = found.manifest!;
      if (builtinManifests.some((m) => m.id === manifest.id)) {
        throw new Error(`the id "${manifest.id}" belongs to a built-in plugin`);
      }
      refuseMislabelled(release, manifest.version);
      const replaces = await installedPlugin(manifest.id);
      const next = manifest.version ?? row.version;
      const was = externalPlugin(manifest.id)?.install;
      const previous = previousOf(replaces?.version, next, was?.previous);
      // A reinstall of the version that is there keeps it as it was: held or not.
      const same = replaces?.version !== undefined && next !== undefined && compareVersions(replaces.version, next) === 0;
      const held = same ? was?.held === true : heldAt(row, release, version);
      const record: InstallRecord = {
        marketplace: entry.name,
        name,
        source: row.source,
        ...(row.ref ? { ref: row.ref } : {}),
        ...(next ? { version: next } : {}),
        commit,
        ...(release ? { sha256: release.sha256 } : {}),
        ...(previous ? { previous } : {}),
        ...(held ? { held: true } : {}),
        installedAt: new Date().toISOString(),
      };
      await writeFile(join(staging, INSTALL_RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
      return {
        id: manifest.id,
        displayName: manifest.displayName,
        description: manifest.description,
        version: record.version ?? "",
        permissions: manifest.permissions ?? [],
        marketplace: entry.name,
        name,
        source: row.source,
        ...(row.ref ? { ref: row.ref } : {}),
        commit,
        ...(replaces ? { replaces } : {}),
      };
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  });
}

/** Throw away a staged plugin the user did not confirm. */
export async function discardStaged(name: string): Promise<void> {
  await rm(stagingDir(name), { recursive: true, force: true });
}

/**
 * The confirmation: move the staged plugin into `~/.specdriven/plugins`,
 * staging it first when the consent step's folder is gone. The loader's
 * rescan then adds it to the profile and mounts it. A folder already there
 * under the id is refused unless the confirmation says `replace`: then it is
 * deleted and the fresh copy takes its place — a reinstall — and the loader
 * remounts the plugin from the new folder.
 */
export async function confirmInstall(
  entry: MarketplaceRef,
  name: string,
  opts: { replace?: boolean; version?: string } = {},
): Promise<{ id: string; dir: string; replaced: boolean }> {
  const staging = stagingDir(name);
  // Staged at the version the consent step showed; anything else is staged afresh.
  const staged = await readFile(join(staging, INSTALL_RECORD_FILE), "utf8")
    .then((text) => JSON.parse(text) as InstallRecord)
    .catch(() => null);
  const asked = opts.version;
  if (!staged || (asked !== undefined && (!staged.version || compareVersions(staged.version, asked) !== 0))) {
    await stageInstall(entry, name, asked);
  }
  return exclusive(name, "installed", async () => {
    const found = await readPluginFolder(staging, "home", appVersion);
    if (!found?.manifest) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(found?.error ?? "the staged plugin has no manifest");
    }
    const id = found.manifest.id;
    const dir = join(pluginsHome(), safeId(id));
    const there = await installedPlugin(id).catch(async (e) => {
      await rm(staging, { recursive: true, force: true });
      throw e;
    });
    const present = there !== null || (await exists(dir));
    if (present && !opts.replace) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(`${id} is already installed; confirm with replace to reinstall it`);
    }
    if (present) {
      await assertUnderHome(dir);
      // Windows refuses a folder a handle is still open on for a moment
      // after the plugin unwinds: retry before giving up.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    await rename(staging, dir);
    return { id, dir, replaced: present };
  });
}

/**
 * The plugin at the ref the index names into `into`: a git source is
 * cloned and put at its ref, a subdirectory is copied out of the
 * marketplace's clone — or, when it has releases, the zip of one version is
 * unpacked from its `release` folder, once its checksum matches the one
 * `releases.json` lists. Symlinks that leave the plugin's folder are
 * refused. Answers the commit the plugin — or, for a subdirectory, the
 * marketplace — is at, and the release that was unpacked.
 */
async function fetchInto(
  row: MarketplacePlugin,
  marketplaceDir: string,
  into: string,
  version?: string,
): Promise<{ commit: string; release?: PluginRelease }> {
  const subdir = subdirectorySource(row.source);
  let commit: string;
  let release: PluginRelease | undefined;
  if (subdir === null) {
    if (version !== undefined) throw new Error(`${row.name} is not released in versions; it follows its repository`);
    await clonePluginRepo(row.source, into);
    commit = row.ref ? await checkoutRef(into, row.ref) : await headCommit(into);
  } else {
    const from = resolve(marketplaceDir, subdir);
    if (!(from + sep).startsWith(resolve(marketplaceDir) + sep)) {
      throw new Error(`the source "${row.source}" leaves the marketplace`);
    }
    if (row.releases || row.releasesError) {
      release = pickRelease(row, version);
      const zip = await readFile(join(from, RELEASE_DIR, release.file)).catch(() => {
        throw new Error(`${row.name} ${release!.version}: ${release!.file} is not in the marketplace's release folder`);
      });
      const sum = createHash("sha256").update(zip).digest("hex");
      if (sum !== release.sha256) {
        throw new Error(`${release.file} does not match its checksum in ${RELEASES_FILE}; nothing was installed`);
      }
      await unzipInto(zip, into);
    } else {
      if (version !== undefined) throw new Error(`${row.name} has no released versions to pick from`);
      if (!(await exists(join(from, "package.json")))) {
        throw new Error(`${row.source} in ${marketplaceDir} has no package.json`);
      }
      await cp(from, into, { recursive: true, verbatimSymlinks: true });
    }
    commit = await headCommit(marketplaceDir);
  }
  await refuseEscapingSymlinks(into);
  return { commit, ...(release ? { release } : {}) };
}

/** A zip must hold the version its row in `releases.json` says it does. */
function refuseMislabelled(release: PluginRelease | undefined, manifestVersion: string | undefined): void {
  if (release && (!manifestVersion || compareVersions(manifestVersion, release.version) !== 0)) {
    throw new Error(`${release.file} holds version ${manifestVersion ?? "none"}, not ${release.version}`);
  }
}

/** A symlink under a plugin's folder that points outside it is refused. */
async function refuseEscapingSymlinks(root: string): Promise<void> {
  const real = await realpath(root);
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch {
          throw new Error(`the plugin has a dangling symlink: ${name}`);
        }
        if (!(target + sep).startsWith(real + sep)) {
          throw new Error(`the plugin has a symlink that leaves its folder: ${name}`);
        }
      } else if (info.isDirectory()) {
        await walk(path);
      }
    }
  };
  await walk(root);
}

/**
 * The plugin installed under an id, or null. One the loader knows from a
 * linked folder or the data folder is not the marketplace's to replace, so
 * it throws.
 */
async function installedPlugin(id: string): Promise<InstalledPlugin | null> {
  const known = externalPlugin(id);
  if (known && known.source !== "home") {
    throw new Error(
      known.source === "path"
        ? `${id} is a linked folder; unlink it before installing it from the marketplace`
        : `${id} came with the data folder; delete it from the repository before installing it from the marketplace`,
    );
  }
  // A folder named by hand may carry the id too: the loader knows its dir.
  const dir = known?.dir ?? join(pluginsHome(), safeId(id));
  if (!(await exists(join(dir, "package.json")))) return null;
  const found = await readPluginFolder(dir, "home", appVersion);
  const install = found?.install ?? known?.install;
  return {
    id,
    ...(found?.manifest?.version ? { version: found.manifest.version } : {}),
    ...(install ? { marketplace: install.marketplace, name: install.name } : {}),
  };
}

// ---- updating and removing ---------------------------------------------------

/**
 * Fetch the ref the index names now for an installed plugin and put the
 * folder at it: a git source is fetched and checked out in place (and put
 * back where it was when the new manifest is refused), a subdirectory is
 * copied afresh from the refreshed marketplace and swapped in. Answers the
 * new record.
 *
 * A released plugin goes to the newest version this app can run, or to
 * `version` — an older one included, which is how it is rolled back: it is
 * then held there, offered no update, until an update without a version
 * moves it on. The record remembers the version it replaced. A version the
 * marketplace's copy already has is unpacked without reaching the network.
 */
export async function updatePlugin(
  id: string,
  entries: readonly MarketplaceRef[],
  opts: { version?: string } = {},
): Promise<InstallRecord> {
  return exclusive(id, "updated", async () => {
    const known = externalPlugin(id);
    if (!known) throw new Error(`No installed plugin has the id "${id}"`);
    if (!known.install) throw new Error(`${id} was not installed from a marketplace`);
    await assertUnderHome(known.dir);
    const record = known.install;
    const entry = entries.find((m) => m.name === record.marketplace);
    if (!entry) throw new Error(`the marketplace "${record.marketplace}" is no longer configured`);
    const asked = opts.version;
    // A version this machine already has the zip of needs no pull.
    let status = asked === undefined ? undefined : await marketplaceIndex(entry);
    const cached = status?.index?.plugins.find((p) => p.name === record.name);
    if (!cached?.releases || !releaseOf(cached.releases, asked!)) status = await marketplaceIndex(entry, true);
    if (!status?.index) throw new Error(`${entry.name}: ${status?.error}`);
    const row = status.index.plugins.find((p) => p.name === record.name);
    if (!row) throw new Error(`${entry.name} no longer lists "${record.name}"`);
    const early = indexRowRefusal(row);
    if (early) throw new Error(early);

    const before = (await readPluginFolder(known.dir, "home", appVersion))?.manifest?.version ?? record.version;
    let commit: string;
    let release: PluginRelease | undefined;
    if (subdirectorySource(row.source) === null) {
      if (asked !== undefined) throw new Error(`${record.name} is not released in versions; it follows its repository`);
      commit = row.ref ? await checkoutRef(known.dir, row.ref) : await pullDefault(known.dir);
      const found = await readPluginFolder(known.dir, "home", appVersion);
      const problem = !found ? "the plugin has no package.json" : found.error ?? (found.manifest!.id !== id ? `the update's manifest names "${found.manifest!.id}", not "${id}"` : null);
      if (problem) {
        if (record.commit) await checkoutRef(known.dir, record.commit).catch(() => {});
        throw new Error(problem);
      }
      await refuseEscapingSymlinks(known.dir);
    } else {
      const staging = stagingDir(record.name);
      await rm(staging, { recursive: true, force: true });
      await mkdir(join(pluginsHome(), ".staging"), { recursive: true });
      try {
        ({ commit, release } = await fetchInto(row, status.dir, staging, asked));
        const found = await readPluginFolder(staging, "home", appVersion);
        const problem = !found ? "the plugin has no package.json" : found.error ?? (found.manifest!.id !== id ? `the update's manifest names "${found.manifest!.id}", not "${id}"` : null);
        if (problem) throw new Error(problem);
        refuseMislabelled(release, found!.manifest!.version);
      } catch (e) {
        await rm(staging, { recursive: true, force: true });
        throw e;
      }
      await rm(known.dir, { recursive: true, force: true });
      await rename(staging, known.dir);
    }
    const manifest = (await readPluginFolder(known.dir, "home", appVersion))?.manifest;
    const version = manifest?.version ?? row.version;
    const { sha256: _sum, previous: kept, held: _held, ...carried } = record;
    const previous = previousOf(before, version, kept);
    const next: InstallRecord = {
      ...carried,
      source: row.source,
      ...(row.ref ? { ref: row.ref } : {}),
      ...(version ? { version } : {}),
      commit,
      ...(release ? { sha256: release.sha256 } : {}),
      ...(previous ? { previous } : {}),
      ...(heldAt(row, release, asked) ? { held: true } : {}),
      installedAt: new Date().toISOString(),
    };
    if (!row.ref) delete next.ref;
    await writeFile(join(known.dir, INSTALL_RECORD_FILE), JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

/** An unpinned git source follows its default branch: pull it. */
async function pullDefault(dir: string): Promise<string> {
  const res = await pull(dir);
  if (!res.ok) throw new Error(`Could not update: ${res.message}`);
  return headCommit(dir);
}

/**
 * Delete an installed plugin's folder. The caller has taken it out of the
 * profile and unmounted it first, so nothing of it is still running.
 */
export async function removePluginFolder(id: string): Promise<string> {
  return exclusive(id, "removed", async () => {
    const known = externalPlugin(id);
    if (!known) throw new Error(`No installed plugin has the id "${id}"`);
    if (known.source !== "home") {
      throw new Error(
        known.source === "path"
          ? `${id} is a linked folder; unlink it instead of removing it`
          : `${id} came with the data folder; delete it from the repository instead`,
      );
    }
    await assertUnderHome(known.dir);
    await rm(known.dir, { recursive: true, force: true });
    return known.dir;
  });
}

/** Only folders under `~/.specdriven/plugins` are ever deleted or rewritten. */
async function assertUnderHome(dir: string): Promise<void> {
  const home = resolve(pluginsHome());
  if (!(resolve(dir) + sep).startsWith(home + sep)) {
    throw new Error(`${dir} is not under ${home}`);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// ---- initializing ----------------------------------------------------------------

/**
 * What a new marketplace takes from the SpecDriven one, as its clone has
 * them: the CI that checks each plugin inside the app, and the scripts it
 * runs (specs/app/plugins.feature.md "An empty repository is initialized as
 * a marketplace"). A folder is copied whole.
 */
export const MARKETPLACE_TEMPLATE_FILES: readonly string[] = [".github/workflows/ci.yml", "scripts", ".gitignore"];

/** The branch a new marketplace is published on: the one every app reads. */
const MARKETPLACE_BRANCH = "main";

/**
 * Who owns a marketplace, from its git url: the path segment before the
 * repository's — `acme` in `https://github.com/acme/plugins` or
 * `git@github.com:acme/plugins.git` — with a link for one on github.com.
 */
export function marketplaceOwnerFor(source: string): { name: string; url?: string } | undefined {
  const parts = source
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/, "")
    .split(/[\\/:]/)
    .filter(Boolean);
  const name = parts.length >= 3 ? parts.at(-2) : undefined;
  // A host (`github.com`, `git@host`) is no owner: the url names none.
  if (!name || /[.@]/.test(name)) return undefined;
  const github = /(^|[@/])github\.com[:/]/i.test(source);
  return github ? { name, url: `https://github.com/${name}` } : { name };
}

/** The README a new marketplace starts with. */
export function marketplaceReadme(name: string, source: string): string {
  return `# ${name}

A SpecDriven plugin marketplace: a git repository with \`marketplace.json\`
at its root. To use it, open Settings → Plugins → Marketplaces in the app,
choose Add marketplace… and give it this repository's url:

\`\`\`
${source}
\`\`\`

Everyone who adds it needs read access to this repository through the app's
git access (Settings → Git).

## Layout

- \`marketplace.json\` — the index: the marketplace's name and owner, and one
  row per plugin with its \`name\` (the plugin's manifest id), \`source\`,
  \`description\`, \`version\`, \`category\` and plugin \`api\`.
- \`plugins/<name>/\` — a plugin's sources, listed in the index with the
  source \`./plugins/<name>\`. A row can name a plugin in a repository of its
  own instead: a git url and the \`ref\` to pin it to.
- \`plugins/<name>/release/\` — what the plugin has released: one zip per
  version and \`releases.json\`. The app installs from these, and any version
  in the folder can be installed or put back.

## Adding a plugin

Scaffold one with \`specdriven plugin new\` under \`plugins/\`, add its row
to \`marketplace.json\`, then release it. With the app checked out at
\`../specdriven-app\` (or \`SPECDRIVEN_APP\` naming it):

\`\`\`bash
bun scripts/release.ts plugins/<name> --notes "What changed, in a line"
\`\`\`

That builds the plugin, writes its zip and \`releases.json\` row, and puts the
version on its row in \`marketplace.json\`. Commit all of it in one pull
request. A released version is never written again: a change needs a new
version.

## CI

\`.github/workflows/ci.yml\` checks the index and every plugin inside the
app — at the oldest version each plugin says it runs in, the newest release,
and the app's \`main\` — with the scripts in \`scripts/\`. Merging to \`main\`
publishes: every app that lists this marketplace reads \`main\`. The
workflow and scripts were copied from the SpecDriven marketplace
(https://github.com/SpecDriven/plugins) when this one was initialized; take
later changes from there by hand.
`;
}

/**
 * Turn a repository created empty on its host into a marketplace
 * (specs/app/plugins.feature.md "An empty repository is initialized as a
 * marketplace"): clone it, write \`marketplace.json\` with no plugins, a
 * README, \`plugins/\` and the CI and scripts copied from \`templateDir\` —
 * the SpecDriven marketplace's clone unless a test names another — then
 * commit and push \`main\`. A README or .gitignore the host put there is
 * kept. Nothing is added to the settings here; the caller does that once
 * this has pushed. The clone is thrown away either way.
 */
export async function initMarketplace(
  source: string,
  opts: { configured: readonly MarketplaceRef[]; templateDir?: string },
): Promise<MarketplaceRef & { index: MarketplaceIndex }> {
  const url = source.trim();
  if (!url) throw new Error("Give the git url of the repository to initialize");
  const name = marketplaceNameFor(url);
  if (!name) throw new Error(`Cannot make a marketplace name out of ${url}`);
  if (isDefaultMarketplace({ name, source: url })) throw new Error("That is the SpecDriven marketplace itself");
  const same = (a: string) => a.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "").toLowerCase();
  const listed = opts.configured.find((m) => same(m.source) === same(url));
  if (listed) throw new Error(`${url} is already on the list, as ${listed.name}`);

  return exclusive(`marketplace ${url}`, "initialized", async () => {
    const template = opts.templateDir ?? (await specdrivenClone(opts.configured));
    const work = join(marketplacesHome(), `.${name}.init`);
    await rm(work, { recursive: true, force: true });
    await mkdir(marketplacesHome(), { recursive: true });
    try {
      await clonePluginRepo(url, work);
      if (await exists(join(work, "marketplace.json"))) {
        throw new Error(`${url} already has a marketplace.json — use Add marketplace… for it`);
      }
      const owner = marketplaceOwnerFor(url);
      const index = { name, ...(owner ? { owner } : {}), plugins: [] };
      await writeFile(join(work, "marketplace.json"), `${JSON.stringify(index, null, 2)}\n`);
      if (!(await exists(join(work, "README.md")))) await writeFile(join(work, "README.md"), marketplaceReadme(name, url));
      await mkdir(join(work, "plugins"), { recursive: true });
      await writeFile(join(work, "plugins", ".gitkeep"), "");
      for (const rel of MARKETPLACE_TEMPLATE_FILES) {
        const from = join(template, rel);
        if (!(await exists(from))) continue;
        const to = join(work, rel);
        if (rel === ".gitignore" && (await exists(to))) continue;
        await cp(from, to, { recursive: true, force: true });
      }
      const res = await commitAllAndPublish(work, MARKETPLACE_BRANCH, `Initialize the ${name} marketplace`);
      if (!res.pushed) throw new Error(`Could not push to ${url}: ${res.failure ?? res.message}`);
      return { name, source: url, index: parseMarketplaceIndex(index) };
    } finally {
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

/**
 * The SpecDriven marketplace's clone, pulled first so a new marketplace gets
 * the CI as it is now — or cloned when there is none. A pull that fails
 * leaves the copy there was, which is still good to copy from.
 */
async function specdrivenClone(configured: readonly MarketplaceRef[]): Promise<string> {
  const entry = configured.find(isDefaultMarketplace) ?? permanentMarketplaces()[0] ?? DEFAULT_MARKETPLACES[0]!;
  const status = await marketplaceIndex(entry, true);
  if (!(await exists(join(status.dir, ".git")))) {
    throw new Error(`Could not read the SpecDriven marketplace to copy its CI from: ${status.error ?? "no clone"}`);
  }
  return status.dir;
}

// ---- the routes ----------------------------------------------------------------

export interface MarketplaceRouteDeps {
  /**
   * The hosted demo lets a visitor browse, from the cache and never
   * refreshed, and change nothing (its host is shared).
   */
  demo(): boolean;
  /**
   * A hosted worker (its host shared too) pulls on Refresh but never
   * throws a marketplace's copy away to clone it afresh.
   */
  hosted?(): boolean;
  readState(): Promise<Record<string, unknown>>;
  persist(state: Record<string, unknown>): Promise<void>;
}

/**
 * The marketplace routes, for api.ts to register among the core rows:
 * `GET /api/plugins/marketplaces[?refresh=1]`, `POST /api/plugins/install`
 * with `{ marketplace, name, step: "stage" | "confirm" | "cancel" }`,
 * `POST /api/plugins/:id/update` and `DELETE /api/plugins/:id`. Install
 * and update take a `version` for a plugin that is released in versions.
 */
export function marketplaceRoutes(deps: MarketplaceRouteDeps): {
  getMarketplaces: Handler;
  postInstall: Handler;
  postUpdate: Handler;
  deletePlugin: Handler;
  postInitMarketplace: Handler;
} {
  const guard =
    (handler: Handler, inDemo = false): Handler =>
    async (req, params) => {
      if (deps.demo() && !inDemo) return json({ error: "Plugins cannot be installed in demo mode" }, 403);
      try {
        return await handler(req, params);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    };
  const entries = async () => marketplaceEntries(profileSection(await deps.readState()));
  // A plugin that failed to load keeps its error through a rescan, which
  // mounts only what has none — so one whose folder was just replaced is
  // loaded again by name. That is what lets a version that will not load
  // be rolled back, or updated past, without a restart.
  const remount = (id: string) => rebuildPlugin(id);
  const row = (id: string): PluginState | undefined => pluginStates().find((p) => p.id === id);

  return {
    getMarketplaces: guard(async (req) => {
      const refresh = !deps.demo() && new URL(req.url).searchParams.get("refresh") === "1";
      const marketplaces = await loadMarketplaces(await entries(), { refresh, reclone: !deps.hosted?.() });
      return json({ marketplaces });
    }, true),
    postInstall: guard(async (req) => {
      const body = await bodyOf(req);
      const { marketplace, name, step } = body;
      if (typeof marketplace !== "string" || typeof name !== "string" || !name) {
        return json({ error: "marketplace and name are required" }, 400);
      }
      const version = typeof body.version === "string" && body.version.trim() ? body.version.trim() : undefined;
      const entry = (await entries()).find((m) => m.name === marketplace);
      if (!entry) return json({ error: `No marketplace named "${marketplace}" is configured` }, 400);
      if (step === "cancel") {
        await discardStaged(name);
        return json({ ok: true });
      }
      if (step === "confirm") {
        const { id, replaced } = await confirmInstall(entry, name, { replace: body.replace === true, version });
        if (replaced) {
          // A reinstall starts over like a fresh install: dropped from
          // `seen`, the rescan adopts the new folder and switches it on
          // when its manifest says so, unless it is on already.
          const state = await deps.readState();
          const section = state[PROFILE_KEY] as Record<string, unknown> | undefined;
          if (section && Array.isArray(section.seen) && section.seen.includes(id)) {
            section.seen = section.seen.filter((x) => x !== id);
            await deps.persist(state);
          }
        }
        await rescanPlugins();
        if (replaced) {
          await remount(id);
          notifyPluginChange();
        }
        return json({ id, replaced, plugin: row(id) ?? null });
      }
      return json({ preview: await stageInstall(entry, name, version) });
    }),
    postUpdate: guard(async (req, params) => {
      const id = params.id ?? "";
      // The start's dialog posts no body: the newest version is meant.
      const body = await bodyOf(req).catch((): Record<string, unknown> => ({}));
      const version = typeof body.version === "string" && body.version.trim() ? body.version.trim() : undefined;
      const record = await updatePlugin(id, await entries(), { version });
      await rescanPlugins();
      await remount(id);
      notifyPluginChange();
      return json({ id, install: record, plugin: row(id) ?? null });
    }),
    // The repository is pushed to here; the page adds it to the settings.
    postInitMarketplace: guard(async (req) => {
      const body = await bodyOf(req);
      if (typeof body.source !== "string" || !body.source.trim()) {
        return json({ error: "source is required" }, 400);
      }
      const marketplace = await initMarketplace(body.source, { configured: await entries() });
      return json({ marketplace });
    }),
    deletePlugin: guard(async (_req, params) => {
      const id = params.id ?? "";
      const known = externalPlugin(id);
      if (!known) return json({ error: `No installed plugin has the id "${id}"` }, 404);
      // Off first — the profile no longer lists it and the loader unwinds
      // it — then the folder goes, and only then is it dropped from `seen`
      // (while the folder is there, `seen` is what keeps the loader from
      // adopting it afresh), so a later reinstall goes on again.
      // Every data folder's list drops it, not just the open one's.
      const state = await deps.readState();
      dropPlugin(state, id, profileManifests);
      await deps.persist(state);
      await rescanPlugins();
      const dir = await removePluginFolder(id);
      const after = await deps.readState();
      const section = after[PROFILE_KEY] as Record<string, unknown> | undefined;
      if (section && Array.isArray(section.seen)) {
        section.seen = section.seen.filter((x) => x !== id);
        await deps.persist(after);
      }
      await rescanPlugins();
      notifyPluginChange();
      return json({ ok: true, id, dir });
    }),
  };
}

function profileSection(state: Record<string, unknown>): Record<string, unknown> {
  const section = state[PROFILE_KEY];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}
