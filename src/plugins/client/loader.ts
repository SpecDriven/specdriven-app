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
export const tabs = new Registry<TabPlugin>();
client.provide("tabs", tabs);

const mounted = new Map<string, Scope>();
let turn: Promise<void> = Promise.resolve();

/** One row of `GET /api/state`'s `plugins`. */
export interface PluginStatus {
  id: string;
  enabled: boolean;
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
 * Bring the mounted client halves in line with what the server reports.
 * Resolves once every newly mounted plugin has applied — loaded its store —
 * so a deep link that follows finds the data there.
 */
export function syncClientPlugins(
  plugins: PluginStatus[] | undefined,
  config: ClientConfig = { demo: false },
): Promise<void> {
  const run = turn.then(async () => {
    const enabled = new Set((plugins ?? []).filter((p) => p.enabled).map((p) => p.id));
    for (const { manifest, plugin } of builtinClientPlugins) {
      const want = enabled.has(manifest.id);
      const have = mounted.get(manifest.id);
      if (want && !have) {
        const scope = client.plugin(plugin, config);
        mounted.set(manifest.id, scope);
        await scope.ready;
      } else if (!want && have) {
        mounted.delete(manifest.id);
        await have.dispose();
      }
    }
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
