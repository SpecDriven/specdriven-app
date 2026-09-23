// The marketplace on the host (specs/app/plugins.feature.md "The marketplace
// is a git repository with an index", "A plugin from the marketplace is
// installed with consent"): each marketplace the profile names is cloned
// or pulled through the app's own git engine into
// `~/.specdriven/marketplaces/<name>` and its `marketplace.json` read; an
// install clones the plugin pinned to the ref the index names (or copies
// the marketplace's subdirectory) into a staging folder, reads its manifest
// and checks it against this app, and only a confirming call moves it into
// `~/.specdriven/plugins/<id>` — so a refused plugin leaves nothing behind
// and nothing runs before the user has seen what it is. Update fetches the
// ref the index names now; Remove deletes the folder. The loader notices the
// folder change and mounts, remounts or unwinds the plugin.

import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { version as appVersion } from "../../../package.json";
import { checkoutRef, clone, headCommit, pull } from "../../server/git";
import { bodyOf, json, type Handler } from "../../server/http";
import { builtinManifests } from "../builtin/manifests";
import {
  INSTALL_RECORD_FILE,
  indexRowRefusal,
  marketplaceEntries,
  parseMarketplaceIndex,
  subdirectorySource,
  type InstallRecord,
  type MarketplaceIndex,
  type MarketplacePlugin,
  type MarketplaceRef,
} from "../marketplace";
import { PROFILE_KEY, readProfile, writeProfile } from "../profile";
import { externalPlugin, notifyPluginChange, pluginStates, rescanPlugins, type PluginState } from "./loader";
import { marketplacesHome, pluginsHome, readPluginFolder, safeId } from "./sources";

/** A marketplace as Settings lists it: its cache, its index, or why it has none. */
export interface MarketplaceStatus extends MarketplaceRef {
  dir: string;
  index?: MarketplaceIndex;
  /** Reported beside the name; the other marketplaces still show. */
  error?: string;
}

/**
 * Every marketplace named, cloned when its cache is missing and pulled when
 * asked to refresh, with its index read. One that fails to clone, pull or
 * parse is reported on its own row and does not hide the others.
 */
export async function loadMarketplaces(
  entries: readonly MarketplaceRef[],
  opts: { refresh?: boolean } = {},
): Promise<MarketplaceStatus[]> {
  return Promise.all(
    entries.map(async (entry): Promise<MarketplaceStatus> => {
      const dir = join(marketplacesHome(), entry.name);
      try {
        await cacheMarketplace(entry, dir, opts.refresh === true);
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

async function cacheMarketplace(entry: MarketplaceRef, dir: string, refresh: boolean): Promise<void> {
  const cached = await exists(join(dir, ".git"));
  if (!cached) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(marketplacesHome(), { recursive: true });
    await clone(entry.source, dir);
  } else if (refresh) {
    const res = await pull(dir);
    if (!res.ok) throw new Error(`Could not refresh ${entry.name}: ${res.message}`);
  }
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
  return parseMarketplaceIndex(raw);
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
 * with the reason. A folder already installed under the id is refused too;
 * Update is for that.
 */
export async function stageInstall(
  entry: MarketplaceRef,
  name: string,
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
      const commit = await fetchInto(row, status.dir, staging);
      const found = await readPluginFolder(staging, "home", appVersion);
      if (!found) throw new Error("the plugin has no package.json");
      if (found.error) throw new Error(found.error);
      const manifest = found.manifest!;
      if (builtinManifests.some((m) => m.id === manifest.id)) {
        throw new Error(`the id "${manifest.id}" belongs to a built-in plugin`);
      }
      if (await installedDir(manifest.id)) {
        throw new Error(`${manifest.id} is already installed; use Update to fetch the ref the index names now`);
      }
      const record: InstallRecord = {
        marketplace: entry.name,
        name,
        source: row.source,
        ...(row.ref ? { ref: row.ref } : {}),
        ...(manifest.version || row.version ? { version: manifest.version ?? row.version } : {}),
        commit,
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
 * rescan then adds it to the profile and mounts it.
 */
export async function confirmInstall(entry: MarketplaceRef, name: string): Promise<{ id: string; dir: string }> {
  const staging = stagingDir(name);
  if (!(await exists(join(staging, INSTALL_RECORD_FILE)))) await stageInstall(entry, name);
  return exclusive(name, "installed", async () => {
    const found = await readPluginFolder(staging, "home", appVersion);
    if (!found?.manifest) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(found?.error ?? "the staged plugin has no manifest");
    }
    const dir = join(pluginsHome(), safeId(found.manifest.id));
    if (await exists(dir)) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(`${found.manifest.id} is already installed`);
    }
    await rename(staging, dir);
    return { id: found.manifest.id, dir };
  });
}

/**
 * The plugin at the ref the index names into `into`: a git source is
 * cloned and put at its ref, a subdirectory is copied out of the
 * marketplace's clone. Symlinks that leave the plugin's folder are refused.
 * Answers the commit the plugin — or, for a subdirectory, the marketplace
 * — is at.
 */
async function fetchInto(row: MarketplacePlugin, marketplaceDir: string, into: string): Promise<string> {
  const subdir = subdirectorySource(row.source);
  let commit: string;
  if (subdir === null) {
    await clone(row.source, into);
    commit = row.ref ? await checkoutRef(into, row.ref) : await headCommit(into);
  } else {
    const from = resolve(marketplaceDir, subdir);
    if (!(from + sep).startsWith(resolve(marketplaceDir) + sep)) {
      throw new Error(`the source "${row.source}" leaves the marketplace`);
    }
    if (!(await exists(join(from, "package.json")))) {
      throw new Error(`${row.source} in ${marketplaceDir} has no package.json`);
    }
    await cp(from, into, { recursive: true, verbatimSymlinks: true });
    commit = await headCommit(marketplaceDir);
  }
  await refuseEscapingSymlinks(into);
  return commit;
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

/** The folder an id is installed under, or null. */
async function installedDir(id: string): Promise<string | null> {
  const dir = join(pluginsHome(), safeId(id));
  if (await exists(join(dir, "package.json"))) return dir;
  // A folder named by hand may still carry the id: ask the loader.
  const known = externalPlugin(id);
  return known?.source === "home" ? known.dir : null;
}

// ---- updating and removing ---------------------------------------------------

/**
 * Fetch the ref the index names now for an installed plugin and put the
 * folder at it: a git source is fetched and checked out in place (and put
 * back where it was when the new manifest is refused), a subdirectory is
 * copied afresh from the refreshed marketplace and swapped in. Answers the
 * new record.
 */
export async function updatePlugin(
  id: string,
  entries: readonly MarketplaceRef[],
): Promise<InstallRecord> {
  return exclusive(id, "updated", async () => {
    const known = externalPlugin(id);
    if (!known) throw new Error(`No installed plugin has the id "${id}"`);
    if (!known.install) throw new Error(`${id} was not installed from a marketplace`);
    await assertUnderHome(known.dir);
    const record = known.install;
    const entry = entries.find((m) => m.name === record.marketplace);
    if (!entry) throw new Error(`the marketplace "${record.marketplace}" is no longer configured`);
    const status = await marketplaceIndex(entry, true);
    if (!status.index) throw new Error(`${entry.name}: ${status.error}`);
    const row = status.index.plugins.find((p) => p.name === record.name);
    if (!row) throw new Error(`${entry.name} no longer lists "${record.name}"`);
    const early = indexRowRefusal(row);
    if (early) throw new Error(early);

    let commit: string;
    if (subdirectorySource(row.source) === null) {
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
        commit = await fetchInto(row, status.dir, staging);
        const found = await readPluginFolder(staging, "home", appVersion);
        const problem = !found ? "the plugin has no package.json" : found.error ?? (found.manifest!.id !== id ? `the update's manifest names "${found.manifest!.id}", not "${id}"` : null);
        if (problem) throw new Error(problem);
      } catch (e) {
        await rm(staging, { recursive: true, force: true });
        throw e;
      }
      await rm(known.dir, { recursive: true, force: true });
      await rename(staging, known.dir);
    }
    const manifest = (await readPluginFolder(known.dir, "home", appVersion))?.manifest;
    const next: InstallRecord = {
      ...record,
      source: row.source,
      ...(row.ref ? { ref: row.ref } : {}),
      ...(manifest?.version || row.version ? { version: manifest?.version ?? row.version } : {}),
      commit,
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

// ---- the routes ----------------------------------------------------------------

export interface MarketplaceRouteDeps {
  /** The hosted demo offers none of this (its host is shared). */
  demo(): boolean;
  readState(): Promise<Record<string, unknown>>;
  persist(state: Record<string, unknown>): Promise<void>;
}

/**
 * The marketplace routes, for api.ts to register among the core rows:
 * `GET /api/plugins/marketplaces[?refresh=1]`, `POST /api/plugins/install`
 * with `{ marketplace, name, step: "stage" | "confirm" | "cancel" }`,
 * `POST /api/plugins/:id/update` and `DELETE /api/plugins/:id`.
 */
export function marketplaceRoutes(deps: MarketplaceRouteDeps): {
  getMarketplaces: Handler;
  postInstall: Handler;
  postUpdate: Handler;
  deletePlugin: Handler;
} {
  const guard =
    (handler: Handler): Handler =>
    async (req, params) => {
      if (deps.demo()) return json({ error: "Plugins cannot be installed in demo mode" }, 403);
      try {
        return await handler(req, params);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    };
  const entries = async () => marketplaceEntries(profileSection(await deps.readState()));
  const row = (id: string): PluginState | undefined => pluginStates().find((p) => p.id === id);

  return {
    getMarketplaces: guard(async (req) => {
      const refresh = new URL(req.url).searchParams.get("refresh") === "1";
      const marketplaces = await loadMarketplaces(await entries(), { refresh });
      return json({ marketplaces });
    }),
    postInstall: guard(async (req) => {
      const body = await bodyOf(req);
      const { marketplace, name, step } = body;
      if (typeof marketplace !== "string" || typeof name !== "string" || !name) {
        return json({ error: "marketplace and name are required" }, 400);
      }
      const entry = (await entries()).find((m) => m.name === marketplace);
      if (!entry) return json({ error: `No marketplace named "${marketplace}" is configured` }, 400);
      if (step === "cancel") {
        await discardStaged(name);
        return json({ ok: true });
      }
      if (step === "confirm") {
        const { id } = await confirmInstall(entry, name);
        await rescanPlugins();
        return json({ id, plugin: row(id) ?? null });
      }
      return json({ preview: await stageInstall(entry, name) });
    }),
    postUpdate: guard(async (_req, params) => {
      const id = params.id ?? "";
      const record = await updatePlugin(id, await entries());
      await rescanPlugins();
      notifyPluginChange();
      return json({ id, install: record, plugin: row(id) ?? null });
    }),
    deletePlugin: guard(async (_req, params) => {
      const id = params.id ?? "";
      const known = externalPlugin(id);
      if (!known) return json({ error: `No installed plugin has the id "${id}"` }, 404);
      // Off first — the profile no longer lists it and the loader unwinds
      // it — then the folder goes, and only then is it dropped from `seen`
      // (while the folder is there, `seen` is what keeps the loader from
      // adopting it afresh), so a later reinstall goes on again.
      const state = await deps.readState();
      const { enabled } = readProfile(state, builtinManifests);
      writeProfile(state, enabled.filter((x) => x !== id), builtinManifests);
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
