// The browser loader (specs/app/plugins.feature.md): one kernel context for
// the app, the tab registry on it, and the plugins mounted and unmounted as
// `GET /api/state` reports them — the server decides, from the profile, and
// the client follows. A built-in's browser half is in the bundle; any
// other's is imported from the url the server serves it at, revision
// included, and a new revision — the plugin was rebuilt — remounts it
// without a reload. Mounting registers the tab and loads the module's
// store; disposing unwinds both, and App goes home when the tab an open
// view belonged to is gone.

import { Context, type Plugin, type Scope } from "../kernel";
import { builtinClientPlugins } from "../builtin/client";
import { Registry, type PluginView, type TabPlugin } from "./tabs";

export const client = new Context();
/** Each plugin's position in the profile, which is its tab's position. */
const rank = new Map<string, number>();
export const tabs = new Registry<TabPlugin>((tab) => rank.get(tab.id));
client.provide("tabs", tabs);

const mounted = new Map<string, { scope: Scope; rev?: string }>();
let turn: Promise<void> = Promise.resolve();
/** Plugins between an unmount and the remount of a new build. */
const remounting = new Set<string>();

/**
 * Whether a tab that just vanished is about to be back — its plugin was
 * rebuilt — so App need not go home from a view of it.
 */
export function isRemounting(id: string): boolean {
  return remounting.has(id);
}

/**
 * One row of `GET /api/state`'s `plugins` (src/plugins/host/loader.ts
 * PluginState), in the profile's order: what the browser mounts, and what
 * Settings → Plugins lists.
 */
export interface PluginStatus {
  id: string;
  /** Listed in the profile — what mounts the browser half. */
  enabled: boolean;
  displayName?: string;
  description?: string;
  version?: string;
  builtin?: boolean;
  /** Where it was loaded from: builtin, home, repo or path. */
  source?: string;
  /** The plugin's folder, for one from a folder. */
  dir?: string;
  installed?: boolean;
  /** False for a plugin under the data repo not trusted yet. */
  trusted?: boolean;
  /** The host half is mounted and applied. */
  active?: boolean;
  /** The browser half's url, revision included, for a plugin from a folder. */
  client?: string;
  rev?: string;
  permissions?: string[];
  /** Where a marketplace install came from, when it was one. */
  install?: { marketplace: string; name: string; ref?: string; version?: string; installedAt?: string };
  error?: string;
}

/** What every browser half is configured with. */
export interface ClientConfig {
  /** Demo mode (src/server/demo.ts): read-only modules, no writes offered. */
  demo: boolean;
  /**
   * `GET /api/state`'s payload as it stood at mount; later changes arrive
   * as the "settings/changed" event.
   */
  settings?: Record<string, unknown>;
}

/**
 * Bring the mounted client halves in line with what the server reports:
 * the enabled plugins in the profile's order, which the tabs take. Resolves
 * once every newly mounted plugin has applied — loaded its store — so a deep
 * link that follows finds the data there.
 */
export function syncClientPlugins(
  plugins: PluginStatus[] | undefined,
  config: ClientConfig = { demo: false },
): Promise<void> {
  const run = turn.then(async () => {
    const rows = (plugins ?? []).filter((p) => p.enabled && p.active !== false);
    const enabled = rows.map((p) => p.id);
    rank.clear();
    enabled.forEach((id, i) => rank.set(id, i));
    for (const [id, { scope, rev }] of [...mounted]) {
      const row = rows.find((p) => p.id === id);
      // Gone from the profile, or rebuilt: unmount, and mount the new build below.
      if (!row || (row.rev !== undefined && row.rev !== rev)) {
        if (row) remounting.add(id);
        mounted.delete(id);
        await scope.dispose();
      }
    }
    for (const row of rows) {
      if (mounted.has(row.id)) continue;
      const builtin = builtinClientPlugins.find((p) => p.manifest.id === row.id);
      if (builtin) {
        const scope = client.plugin(builtin.plugin, config);
        mounted.set(row.id, { scope });
        await scope.ready;
        continue;
      }
      if (!row.client) continue;
      const plugin = await importClientHalf(row);
      if (!plugin) continue;
      const scope = client.plugin(plugin, { ...config, manifest: row });
      mounted.set(row.id, { scope, rev: row.rev });
      await scope.ready;
      if (scope.error) setLoadError(row.id, scope.error.message);
    }
    // A reorder without a mount or unmount still moves the tabs.
    tabs.resort();
    if (remounting.size > 0) {
      // Whether or not the new build mounted, App looks at the tabs again.
      remounting.clear();
      tabs.touch();
    }
  });
  turn = run.catch(() => {});
  return run;
}

/** A plugin's browser half from the url the server serves it at. */
async function importClientHalf(row: PluginStatus): Promise<Plugin<Context> | null> {
  try {
    // Relative to the page — `app://specdriven/` on the desktop — when there is one.
    const base = typeof location === "undefined" ? undefined : location.href;
    const url = new URL(row.client!, base).href;
    const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
    const plugin = mod.default as Plugin<Context> | undefined;
    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error("the browser half's default export is not a plugin ({ name, apply })");
    }
    setLoadError(row.id, null);
    return { ...plugin, name: row.id };
  } catch (e) {
    const message = `loading the browser half: ${(e as Error).message}`;
    console.error(`[plugins] ${row.id}: ${message}`);
    setLoadError(row.id, message);
    return null;
  }
}

// ---- load errors, for Settings → Plugins ------------------------------------

const loadErrors = new Map<string, string>();
const errorListeners = new Set<() => void>();
let errorsSnapshot: ReadonlyMap<string, string> = new Map();

function setLoadError(id: string, message: string | null): void {
  if (message === null ? !loadErrors.delete(id) : loadErrors.get(id) === message) return;
  if (message !== null) loadErrors.set(id, message);
  errorsSnapshot = new Map(loadErrors);
  for (const l of errorListeners) l();
}

/** The browser-side load errors by plugin id, as a store React can subscribe to. */
export const clientLoadErrors = {
  subscribe(listener: () => void): () => void {
    errorListeners.add(listener);
    return () => {
      errorListeners.delete(listener);
    };
  },
  snapshot(): ReadonlyMap<string, string> {
    return errorsSnapshot;
  },
};

// ---- the change stream --------------------------------------------------------

/**
 * Hear of a plugin rebuilt or a folder come or gone (`GET /api/plugins/
 * events`, src/plugins/host/loader.ts): the app re-reads its state then,
 * and the new build mounts in place of the old. Returns the disposer.
 */
export function watchPluginChanges(onChange: () => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/plugins/events");
  source.onmessage = () => onChange();
  return () => source.close();
}

/** The mounted tab whose urls a path belongs to, with the view it names. */
export function matchPluginRoute(pathname: string): { tab: TabPlugin; view: unknown } | null {
  for (const tab of tabs.list()) {
    const view = tab.route.match(pathname);
    if (view !== null) return { tab, view };
  }
  return null;
}

/** The url of a plugin view, from the tab that owns it. */
export function pluginViewPath(open: PluginView): string | null {
  const tab = tabs.get(open.tab);
  return tab ? tab.route.path(open.view) : null;
}
