// The host loader (specs/app/plugins.feature.md "A built-in module is a
// plugin like any other", "A plugin loads from a local folder"): one kernel
// context for the server, the core services on it, and the plugins mounted
// and unmounted as the profile — the ordered `plugins.enabled` list in
// settings — says. Built-in plugins ride in the tree; the others come from
// folders (src/plugins/host/sources.ts), are built by the app when it runs
// on Bun (src/plugins/host/build.ts), have their browser half served from
// `GET /plugins/<id>/client.js?rev=` and are rebuilt and remounted as their
// folder changes. Mounting is what adds a module's routes; disposing
// removes them, so a switched-off module answers 404 without any per-route
// check — the server refuses the module's requests, not just the UI.

import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { version as appVersion } from "../../../package.json";
import { Context, type Disposer, type Plugin, type Scope } from "../kernel";
import type { PluginManifest } from "../manifest";
import type { InstallRecord } from "../marketplace";
import { PROFILE_KEY, autoEnablePlugins, readProfile, writeProfile } from "../profile";
import { builtinHostPlugins } from "../builtin/host";
import { builtinManifests, profileManifests, retiredManifest } from "../builtin/manifests";
import * as hostSdk from "../sdk/host";
import { SDK_GLOBAL } from "../shared";
import { addSearchScope } from "../../server/search";
import { getAppRoot } from "../../server/paths";
import { readState, writeState } from "../../server/state";
import type { SpecDrivenState } from "../../server/state";
import { secretStore, type SecretStore } from "../../server/secrets";
import { agents } from "./agents";
import { createPluginSettings, type PluginSettings } from "./pluginSettings";
import { safeId as secretSafeId } from "./sources";
import {
  createRouteRegistry,
  createSessionParts,
  createShellPaths,
  createSyncHooks,
  type DataAccess,
} from "./services";
import {
  discoverPlugins,
  pluginBuildHome,
  pluginsHome,
  repoPluginsDir,
  safeId,
  type DiscoveredPlugin,
  type SourceKind,
} from "./sources";
import { buildClient, buildHost, bundledReactReason, canBuild, revisionOf } from "./build";

export const host = new Context();

export const routes = createRouteRegistry();
export const shell = createShellPaths();
export const sync = createSyncHooks();
export const sessionParts = createSessionParts();
host.provide("routes", routes);
host.provide("shell", shell);
host.provide("sync", sync);
host.provide("search", { add: addSearchScope });
host.provide("sessions", sessionParts);
host.provide("agents", agents);

// `@specdriven/host` for the plugins' host halves: their builds point the
// specifier at a shim over this global (src/plugins/host/build.ts), so a
// plugin shares the server's modules — Automerge, the store, git — rather
// than bundling copies. Published before any plugin is imported.
{
  const g = globalThis as unknown as Record<string, { modules?: Record<string, unknown> } | undefined>;
  const sdk = (g[SDK_GLOBAL] ??= { modules: {} });
  sdk.modules = { ...sdk.modules, "@specdriven/host": hostSdk };
}

// A module's urls serve the shell whether it is on or off (a deep link to a
// switched-off tab lands in the app and goes home there), so the prefixes
// come from the manifests, not from `apply`.
for (const { manifest } of builtinHostPlugins) {
  for (const prefix of manifest.paths ?? []) shell.add(prefix);
}

/** Provided by api.ts once, since resolving the data dir is its business. */
export function provideDataAccess(data: DataAccess): void {
  if (host.get("data")) return;
  host.provide("data", data);
}

/** Where a plugin was loaded from — the one thing that tells a built-in apart. */
export type PluginSource = "builtin" | SourceKind;

/** One row of Settings → Plugins and of `GET /api/state`'s `plugins`. */
export interface PluginState {
  id: string;
  displayName: string;
  description: string;
  /** The plugin's version — a built-in's is the app's. */
  version: string;
  /** In the tree, always present, never uninstalled. */
  builtin: boolean;
  source: PluginSource;
  /** The plugin's folder; none for a built-in or a profile entry nothing provides. */
  dir?: string;
  /** Some source provides it; false for a profile entry nothing provides. */
  installed: boolean;
  /**
   * Whether the plugin may load: false for one under the data repo the user
   * has not trusted yet (specs/app/plugins.feature.md "A plugin loads from a
   * local folder").
   */
  trusted: boolean;
  /** Listed in the profile. */
  enabled: boolean;
  /** Mounted and applied — enabled, installed, and `apply` did not throw. */
  active: boolean;
  /** The browser half's url, revision included, while there is one to serve. */
  client?: string;
  /** The build's revision: a new one after every rebuild. */
  rev?: string;
  /** What the manifest declares; shown, not enforced. */
  permissions?: string[];
  error?: string;
}

/** What a plugin's host half is mounted with — a built-in's too. */
export interface HostConfig {
  manifest: PluginManifest;
  /** The plugin's folder; "" for a built-in, which has none. */
  dir: string;
  /** The plugin's own section of settings.yaml (src/plugins/host/pluginSettings.ts). */
  settings: PluginSettings;
  /** A named secret store of the plugin's, kept on this device apart from the settings. */
  secrets: (name: string) => SecretStore;
}

/** The config a plugin is mounted with; `dir` is "" for a built-in. */
export function hostConfigFor(manifest: PluginManifest, dir: string): HostConfig {
  const id = manifest.id;
  return {
    manifest,
    dir,
    settings: createPluginSettings(id, {
      readState: async () => (await readState(getAppRoot())) as Record<string, unknown>,
      writeState: (state) => writeState(state as SpecDrivenState, getAppRoot()),
    }),
    secrets: (name) => secretStore(`${secretSafeId(id)}.${name}`),
  };
}

interface Built {
  rev: string;
  hostFile: string | null;
  clientFile: string | null;
  clientCode: string | null;
}

/** A filesystem plugin as the loader knows it between syncs. */
interface External {
  id: string;
  dir: string;
  source: SourceKind;
  manifest?: PluginManifest;
  /** Where a marketplace install came from, for a folder that has the record. */
  install?: InstallRecord;
  trusted: boolean;
  /** Why it is not running: from discovery, the build, or the mount. */
  error?: string;
  /** The error discovery reported, to tell it from a build or mount error. */
  discoveryError?: string;
  build?: Built;
  /** Its url prefixes on the shell, on or off, while it is installed. */
  shellOff: Disposer[];
  watcher?: FSWatcher;
}

const external = new Map<string, External>();
const mounted = new Map<string, { scope: Scope; rev?: string }>();
/** The profile as last synced: the enabled ids in tab order. */
let profile: string[] = [];
/** Mounts and unmounts happen one at a time; concurrent settings writes queue. */
let turn: Promise<void> = Promise.resolve();
let lastOptions: SyncOptions = {};

export interface SyncOptions {
  /**
   * Look for plugins in the folders too — `~/.specdriven/plugins`, the data
   * repo's `.specdriven/plugins`, the profile's `sources`. Off by default.
   */
  sources?: boolean;
  /**
   * Read the profile's `sources` paths when scanning. On by default; off
   * in the hosted demo, whose plugins are its home folder's alone.
   */
  paths?: boolean;
  /** The data repo, for its own plugins folder; null when none is configured. */
  dataDir?: string | null;
  /**
   * Store the settings after the loader changed them — a plugin found for
   * the first time goes into the profile, so its tab appears at once.
   */
  persist?: (state: Record<string, unknown>) => Promise<void>;
  /** Re-read the settings, for a rescan a folder change triggers. */
  readState?: () => Promise<Record<string, unknown>>;
}

/**
 * Bring the mounted plugins in line with the settings: mount what the
 * profile lists and is not there, in the profile's order, and dispose what
 * is there and no longer listed. A settings object from before the profile
 * (the per-module switches) is read as the matching list
 * (src/plugins/profile.ts). With `sources` on, the plugin folders are
 * scanned first and a plugin found for the first time is added to the
 * profile. Resolves once every newly mounted plugin has applied.
 */
export function syncPlugins(
  state: Record<string, unknown>,
  options: SyncOptions = {},
): Promise<void> {
  const run = turn.then(async () => {
    lastOptions = options;
    const section = profileSection(state);
    let { enabled } = readProfile(state, profileManifests);
    let changed = false;

    if (options.sources) {
      const found = await discoverPlugins({
        dataDir: options.dataDir ?? null,
        paths: options.paths === false ? [] : sourcePaths(section),
        appVersion,
      });
      const trusted = stringList(section.trusted);
      const seen = stringList(section.seen);
      const adopted = await absorbDiscovered(found, trusted);
      // A plugin found for the first time goes on in the open data folder's
      // list, at the end of the tab order, unless its manifest says it
      // starts off; one switched off later stays off — `seen`, kept for the
      // device, remembers the adoption, so other folders list it off.
      let adoptedNew = false;
      for (const entry of adopted) {
        if (!entry.manifest || entry.error || !entry.trusted) continue;
        if (enabled.includes(entry.id) || seen.includes(entry.id)) continue;
        seen.push(entry.id);
        if (entry.manifest.defaultEnabled) enabled = [...enabled, entry.id];
        adoptedNew = true;
      }
      if (adoptedNew) {
        writeProfile(state, enabled, profileManifests);
        (state[PROFILE_KEY] as Record<string, unknown>).seen = seen;
        changed = true;
      }
      watchFolders(options);
    } else {
      await absorbDiscovered([], []);
    }
    // The plugins that switch themselves on in a folder (manifest.autoEnable):
    // the coding agents, built in or installed, which have no tab to cost
    // the sidebar.
    const installed = [...external.values()]
      .filter((e) => e.manifest && e.trusted && !e.error)
      .map((e) => e.manifest!);
    const auto = autoEnablePlugins(state, enabled, [...profileManifests, ...installed]);
    if (auto) {
      enabled = auto;
      changed = true;
    }
    if (changed) await options.persist?.(state);
    profile = enabled;

    for (const [id, { scope }] of [...mounted]) {
      const entry = external.get(id);
      const stillOn =
        enabled.includes(id) && (!entry || (entry.trusted && !!entry.manifest && !entry.error));
      if (!stillOn) {
        mounted.delete(id);
        await scope.dispose();
      }
    }
    for (const id of enabled) {
      const builtin = builtinHostPlugins.find((p) => p.manifest.id === id);
      if (builtin) {
        if (mounted.has(id)) continue;
        const scope = host.plugin(builtin.plugin, hostConfigFor(builtin.manifest, ""));
        mounted.set(id, { scope });
        await scope.ready;
        continue;
      }
      const entry = external.get(id);
      if (entry && entry.manifest && entry.trusted && !entry.error) await mountExternal(entry);
    }
  });
  turn = run.catch(() => {});
  return run;
}

/** The profile as last synced: the enabled plugin ids in tab order. */
export function enabledPlugins(): string[] {
  return [...profile];
}

/**
 * What Settings → Plugins and `GET /api/state` list: the profile's entries
 * in its order — an id no source provides reported among them — then the
 * installed plugins it leaves off, built-ins first, in load order.
 */
export function pluginStates(): PluginState[] {
  const rows: PluginState[] = [];
  for (const id of profile) {
    const manifest = builtinManifests.find((m) => m.id === id);
    const entry = external.get(id);
    if (manifest) {
      rows.push(builtinState(manifest, true));
    } else if (entry) {
      rows.push(externalState(entry, true));
    } else {
      // A built-in that moved to the marketplace (the Event Models) is
      // named as it was, and Settings → Plugins offers to install it.
      const retired = retiredManifest(id);
      rows.push({
        id,
        displayName: retired?.displayName ?? id,
        description: retired?.description ?? "",
        version: "",
        builtin: false,
        source: "path",
        installed: false,
        trusted: true,
        enabled: true,
        active: false,
        error: retired
          ? "No longer built in: install it from the marketplace to bring its tab back."
          : "No installed plugin has this id; it is listed in the profile and ignored.",
      });
    }
  }
  for (const manifest of builtinManifests) {
    if (!profile.includes(manifest.id)) rows.push(builtinState(manifest, false));
  }
  for (const entry of external.values()) {
    // A folder plugin with a built-in's id is refused at discovery and
    // logged; the built-in's row is the one that shows.
    if (builtinManifests.some((m) => m.id === entry.id)) continue;
    if (!profile.includes(entry.id)) rows.push(externalState(entry, false));
  }
  return rows;
}

function builtinState(manifest: PluginManifest, enabled: boolean): PluginState {
  const scope = mounted.get(manifest.id)?.scope;
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    version: appVersion,
    builtin: true,
    source: "builtin",
    installed: true,
    trusted: true,
    enabled,
    active: scope?.status === "active",
    ...(scope?.error ? { error: scope.error.message } : {}),
  };
}

function externalState(entry: External, enabled: boolean): PluginState {
  const scope = mounted.get(entry.id)?.scope;
  const error = entry.error ?? scope?.error?.message;
  const build = entry.build;
  return {
    id: entry.id,
    displayName: entry.manifest?.displayName ?? entry.id,
    description: entry.manifest?.description ?? "",
    version: entry.manifest?.version ?? "",
    builtin: false,
    source: entry.source,
    dir: entry.dir,
    installed: true,
    trusted: entry.trusted,
    enabled,
    active: scope?.status === "active",
    ...(build?.clientCode ? { client: clientUrl(entry.id, build.rev), rev: build.rev } : {}),
    ...(entry.manifest?.permissions ? { permissions: entry.manifest.permissions } : {}),
    ...(entry.install ? { install: entry.install } : {}),
    ...(error ? { error } : {}),
  };
}

/** A folder plugin as the loader knows it, for the marketplace's Update and Remove. */
export function externalPlugin(
  id: string,
): { id: string; dir: string; source: SourceKind; install?: InstallRecord } | undefined {
  const entry = external.get(id);
  return entry
    ? { id: entry.id, dir: entry.dir, source: entry.source, ...(entry.install ? { install: entry.install } : {}) }
    : undefined;
}

/** The ids of the folder plugins the loader knows — installed, linked or the data folder's. */
export function externalPluginIds(): string[] {
  return [...external.keys()];
}

/** The bundle route's url for a plugin's browser half at a revision. */
export function clientUrl(id: string, rev: string): string {
  return `/plugins/${encodeURIComponent(id)}/client.js?rev=${rev}`;
}

// ---- the profile section ---------------------------------------------------

function profileSection(state: Record<string, unknown>): Record<string, unknown> {
  const section = state[PROFILE_KEY];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** The profile's `sources`: `{ path }` rows, or bare strings. */
export function sourcePaths(section: Record<string, unknown>): string[] {
  const raw = section.sources;
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const row of raw) {
    const path =
      typeof row === "string" ? row : row && typeof row === "object" ? (row as { path?: unknown }).path : null;
    if (typeof path === "string" && path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

// ---- discovery ------------------------------------------------------------

/**
 * Take a scan's result in: folders that went are dropped — their mounts
 * disposed, their shell prefixes and watchers gone — and the rest kept or
 * added, with a repo plugin's trust and a duplicate of a built-in's id
 * refused.
 */
async function absorbDiscovered(found: DiscoveredPlugin[], trusted: string[]): Promise<External[]> {
  const keep = new Set(found.map((p) => p.id));
  for (const [id, entry] of [...external]) {
    if (keep.has(id)) continue;
    external.delete(id);
    await forget(entry);
  }
  const adopted: External[] = [];
  for (const plugin of found) {
    const isTrusted = plugin.source !== "repo" || trusted.includes(plugin.dir);
    const shadowed = builtinManifests.some((m) => m.id === plugin.id);
    const error = shadowed ? `The id "${plugin.id}" belongs to a built-in plugin` : plugin.error;
    if (shadowed && !external.has(plugin.id)) console.error(`[plugins] ${plugin.dir}: ${error}`);
    let entry = external.get(plugin.id);
    if (entry && entry.dir === plugin.dir) {
      // Same folder as before: keep its build and its mount, refresh the rest.
      entry.source = plugin.source;
      entry.manifest = plugin.manifest;
      entry.install = plugin.install;
      entry.trusted = isTrusted;
      // A discovery error replaces an old one; an old build or mount error
      // stays until the next build clears it.
      if (error) entry.error = error;
      else if (entry.error && entry.error === entry.discoveryError) entry.error = undefined;
      entry.discoveryError = error;
    } else {
      if (entry) await forget(entry);
      entry = {
        id: plugin.id,
        dir: plugin.dir,
        source: plugin.source,
        manifest: plugin.manifest,
        install: plugin.install,
        trusted: isTrusted,
        error,
        discoveryError: error,
        shellOff: [],
      };
      external.set(plugin.id, entry);
    }
    if (entry.shellOff.length === 0 && entry.manifest && !error) {
      for (const prefix of entry.manifest.paths ?? []) entry.shellOff.push(shell.add(prefix));
    }
    adopted.push(entry);
  }
  return adopted;
}

/** Drop an external plugin: unmount it and take its prefixes and watcher away. */
async function forget(entry: External): Promise<void> {
  const m = mounted.get(entry.id);
  if (m) {
    mounted.delete(entry.id);
    await m.scope.dispose();
  }
  for (const off of entry.shellOff.splice(0)) await off();
  entry.watcher?.close();
  entry.watcher = undefined;
}

// ---- building and mounting -------------------------------------------------

async function mountExternal(entry: External): Promise<void> {
  let built: Built;
  try {
    built = await ensureBuilt(entry);
  } catch (e) {
    entry.error = (e as Error).message;
    console.error(`[plugins] building ${entry.id}: ${entry.error}`);
    return;
  }
  const current = mounted.get(entry.id);
  if (current && current.rev === built.rev) return;
  if (current) {
    mounted.delete(entry.id);
    await current.scope.dispose();
  }
  let plugin: Plugin<Context, HostConfig>;
  if (built.hostFile) {
    try {
      const mod = (await import(pathToFileURL(built.hostFile).href)) as { default?: unknown };
      const candidate = mod.default as Plugin<Context, HostConfig> | undefined;
      if (!candidate || typeof candidate.apply !== "function") {
        throw new Error("the host half's default export is not a plugin ({ name, apply })");
      }
      plugin = { ...candidate, name: entry.id };
    } catch (e) {
      entry.error = `loading the host half: ${(e as Error).message}`;
      console.error(`[plugins] ${entry.id}: ${entry.error}`);
      return;
    }
  } else {
    // A browser-only plugin still gets a scope, so it reports as active.
    plugin = { name: entry.id, apply() {} };
  }
  const scope = host.plugin(plugin, hostConfigFor(entry.manifest!, entry.dir));
  mounted.set(entry.id, { scope, rev: built.rev });
  await scope.ready;
  watchSource(entry);
}

/**
 * The plugin's halves at their current revision, built if the runtime can
 * and the sources changed, else taken from `dist/`. Each revision has its
 * own folder under the build home, so a rebuild is a new module for the
 * import cache and a new url for the browser.
 */
async function ensureBuilt(entry: External): Promise<Built> {
  const manifest = entry.manifest!;
  // A marketplace install ships `dist/` and comes without its dependencies,
  // so it loads what it ships; building from `src` is for a plugin under
  // development (roadmap/plugin-architecture.md "Building").
  const buildable =
    canBuild() && !entry.install && !!manifest.src && !!(manifest.src.host || manifest.src.client);
  const inputs: string[] = ["package.json"];
  if (buildable) {
    for (const file of [manifest.src!.host, manifest.src!.client]) {
      if (file) inputs.push(dirname(file) === "." ? file : dirname(file));
    }
  } else {
    if (!manifest.host && !manifest.client) {
      throw new Error("no prebuilt dist/ to load; build this plugin with `specdriven plugin build`");
    }
    for (const file of [manifest.host, manifest.client]) if (file) inputs.push(file);
  }
  const rev = await revisionOf(entry.dir, inputs);
  if (entry.build?.rev === rev) return entry.build;

  const outDir = join(pluginBuildHome(), safeId(entry.id), rev);
  const hostFile = join(outDir, "host.js");
  const clientFile = join(outDir, "client.js");
  const wantHost = buildable ? !!manifest.src!.host : !!manifest.host;
  const wantClient = buildable ? !!manifest.src!.client : !!manifest.client;
  const fresh = (await exists(outDir)) && (!wantHost || (await exists(hostFile))) && (!wantClient || (await exists(clientFile)));
  if (!fresh) {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    if (buildable) {
      if (manifest.src!.host) await buildHost(join(entry.dir, manifest.src!.host), outDir);
      if (manifest.src!.client) await buildClient(join(entry.dir, manifest.src!.client), outDir);
    } else {
      if (manifest.host) await copyInto(join(entry.dir, manifest.host), hostFile);
      if (manifest.client) await copyInto(join(entry.dir, manifest.client), clientFile);
    }
  }
  let clientCode: string | null = null;
  if (wantClient) {
    clientCode = await readFile(clientFile, "utf8");
    const reason = bundledReactReason(clientCode) ?? bareImportReason(clientCode);
    if (reason) throw new Error(reason);
  }
  entry.build = { rev, hostFile: wantHost ? hostFile : null, clientFile: wantClient ? clientFile : null, clientCode };
  entry.error = entry.discoveryError;
  void pruneBuilds(safeId(entry.id), rev);
  return entry.build;
}

/** A dist bundle that still names react would fail in the browser: say so here. */
function bareImportReason(code: string): string | null {
  return /^\s*(?:import|export)\b[^'"\n]*\bfrom\s*['"](?:react|react-dom)(?:\/[^'"]*)?['"]/m.test(code)
    ? "the browser bundle imports react by name, which the browser cannot resolve; build it with `specdriven plugin build`, which shares the app's React"
    : null;
}

async function copyInto(from: string, to: string): Promise<void> {
  try {
    await cp(from, to);
  } catch (e) {
    throw new Error(`cannot read ${from}: ${(e as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Old revisions of a plugin's build go, the current one stays. */
async function pruneBuilds(folder: string, keep: string): Promise<void> {
  const dir = join(pluginBuildHome(), folder);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== keep) await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
}

// ---- watching ---------------------------------------------------------------

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * While a plugin under development is edited — a path source, or a folder
 * under the home with sources — the app rebuilds and remounts that one
 * plugin, and tells the browser to pick the new build up.
 */
function watchSource(entry: External): void {
  if (entry.watcher || !canBuild() || !entry.manifest?.src) return;
  if (entry.source === "repo") return;
  try {
    entry.watcher = watch(entry.dir, { recursive: true }, (_event, file) => {
      const name = typeof file === "string" ? file : "";
      if (/(^|[\\/])(dist|node_modules|\.git)([\\/]|$)/.test(name)) return;
      schedule(entry.id, () => rebuildPlugin(entry.id));
    });
    entry.watcher.unref?.();
  } catch (e) {
    console.error(`[plugins] cannot watch ${entry.dir}: ${(e as Error).message}`);
  }
}

function schedule(key: string, fn: () => Promise<void>): void {
  const old = pending.get(key);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    pending.delete(key);
    void fn().catch((e) => console.error(`[plugins] ${key}: ${(e as Error).message}`));
  }, 250);
  timer.unref?.();
  pending.set(key, timer);
}

/**
 * Rebuild one plugin after an edit and remount it when its revision
 * changed; a build that fails leaves the old mount running and shows the
 * error. Resolves once the remount is done.
 */
export function rebuildPlugin(id: string): Promise<void> {
  const run = turn.then(async () => {
    const entry = external.get(id);
    if (!entry || !entry.manifest || !entry.trusted || !profile.includes(id)) return;
    const before = mounted.get(id)?.rev;
    await mountExternal(entry);
    const after = mounted.get(id)?.rev;
    if (before !== after || entry.error) notifyPluginChange();
  });
  turn = run.catch(() => {});
  return run;
}

const folderWatchers = new Map<string, FSWatcher>();

/** A folder appearing or going under a plugins folder triggers a rescan. */
function watchFolders(options: SyncOptions): void {
  if (!options.readState) return;
  const dirs = [pluginsHome(), ...(options.dataDir ? [repoPluginsDir(options.dataDir)] : [])];
  for (const [dir, watcher] of [...folderWatchers]) {
    if (!dirs.includes(dir)) {
      watcher.close();
      folderWatchers.delete(dir);
    }
  }
  for (const dir of dirs) {
    if (folderWatchers.has(dir)) continue;
    try {
      const watcher = watch(dir, () => schedule(`rescan:${dir}`, rescan));
      watcher.unref?.();
      folderWatchers.set(dir, watcher);
    } catch {
      // No such folder yet; the next sync tries again.
    }
  }
}

/**
 * Re-read the settings and sync, as a folder change asks — and as an
 * install, update or removal does once it changed the plugins folder. The
 * browser hears of it when the set or a revision changed.
 */
export async function rescanPlugins(): Promise<void> {
  return rescan();
}

async function rescan(): Promise<void> {
  if (!lastOptions.readState) return;
  const before = new Map([...external].map(([id, e]) => [id, e.build?.rev]));
  await syncPlugins(await lastOptions.readState(), lastOptions);
  const after = new Map([...external].map(([id, e]) => [id, e.build?.rev]));
  const changed =
    before.size !== after.size || [...after].some(([id, rev]) => before.get(id) !== rev);
  if (changed) notifyPluginChange();
}

/** For tests and shutdown: every watcher off. */
export function stopWatching(): void {
  for (const watcher of folderWatchers.values()) watcher.close();
  folderWatchers.clear();
  for (const entry of external.values()) {
    entry.watcher?.close();
    entry.watcher = undefined;
  }
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

// ---- the routes: the bundle, and the change stream -------------------------

routes.add("GET", "/plugins/:id/client.js", (req, params) => {
  // The id is looked up, never joined into a path from the request.
  const entry = external.get(params.id ?? "");
  const build = entry?.build;
  if (!entry || !build?.clientCode) return new Response("Not Found", { status: 404 });
  const etag = `"${build.rev}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const rev = new URL(req.url).searchParams.get("rev");
  return new Response(build.clientCode, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      etag,
      // A build's url names its revision: that one can be cached for good,
      // anything else is checked every time.
      "cache-control": rev === build.rev ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
});

const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

/** Tell every open change stream that a plugin was rebuilt or the set changed. */
export function notifyPluginChange(): void {
  const chunk = encoder.encode(`data: ${JSON.stringify({ type: "changed" })}\n\n`);
  for (const controller of [...streams]) {
    try {
      controller.enqueue(chunk);
    } catch {
      streams.delete(controller);
    }
  }
}

/** How many browsers are listening for plugin changes. */
export function changeListeners(): number {
  return streams.size;
}

// An agent whose sign-in or setup changed (AgentRegistry.changed) has a new
// descriptor — Claude Code fetched by the email sign-in is now there — and
// the pages read descriptors off /api/state, which this stream has them
// re-read. Without it the pane kept saying "not set up" until a restart.
// An agent that came or went — its plugin switched on or off, installed,
// updated or removed — is the same news: a window other than the one that
// made the change offered only the agents it loaded with until a reload.
// Those are told once the registry settles, so an update's remove-then-add
// is one re-read. The registry outlives a `bun --hot` reload and these
// streams do not, so a reload replaces the earlier listener.
{
  const WATCH = Symbol.for("specdriven.plugins.agentWatch");
  const g = globalThis as Record<symbol, unknown>;
  (g[WATCH] as (() => void) | undefined)?.();
  g[WATCH] = agents.subscribe((change) => {
    if (change.type === "changed") notifyPluginChange();
    else schedule("agents", async () => notifyPluginChange());
  });
}

routes.add("GET", "/api/plugins/events", () => {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let self: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      streams.add(controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          streams.delete(controller);
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      if (self) streams.delete(self);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});
