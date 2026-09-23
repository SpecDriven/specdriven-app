// The browser loader (specs/app/plugins.feature.md): one kernel context for
// the app, the tab registry on it, and the built-in plugins mounted and
// unmounted as `GET /api/state` reports them — the server decides, from the
// Settings switches, and the client follows. Mounting registers the tab and
// loads the module's store; disposing unwinds both, and App goes home when
// the tab an open view belonged to is gone.

import { Context, type Scope } from "../kernel";
import { builtinClientPlugins } from "../builtin/client";
import { Registry, type PluginView, type TabPlugin } from "./tabs";

export const client = new Context();
/** Each plugin's position in the profile, which is its tab's position. */
const rank = new Map<string, number>();
export const tabs = new Registry<TabPlugin>((tab) => rank.get(tab.id));
client.provide("tabs", tabs);

const mounted = new Map<string, Scope>();
let turn: Promise<void> = Promise.resolve();

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
  installed?: boolean;
  /** The host half is mounted and applied. */
  active?: boolean;
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
    const enabled = (plugins ?? []).filter((p) => p.enabled).map((p) => p.id);
    rank.clear();
    enabled.forEach((id, i) => rank.set(id, i));
    for (const [id, scope] of [...mounted]) {
      if (!enabled.includes(id)) {
        mounted.delete(id);
        await scope.dispose();
      }
    }
    for (const id of enabled) {
      const entry = builtinClientPlugins.find((p) => p.manifest.id === id);
      if (!entry || mounted.has(id)) continue;
      const scope = client.plugin(entry.plugin, config);
      mounted.set(id, scope);
      await scope.ready;
    }
    // A reorder without a mount or unmount still moves the tabs.
    tabs.resort();
  });
  turn = run.catch(() => {});
  return run;
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
