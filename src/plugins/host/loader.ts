// The host loader (specs/app/plugins.feature.md "A built-in module is a
// plugin like any other"): one kernel context for the server, the core
// services on it, and the built-in plugins mounted and unmounted as their
// Settings switches say. Mounting is what adds a module's routes; disposing
// removes them, so a switched-off module answers 404 without any per-route
// check — the server refuses the module's requests, not just the UI.

import { Context, type Scope } from "../kernel";
import { pluginWanted } from "../manifest";
import { builtinHostPlugins } from "../builtin/host";
import {
  createRouteRegistry,
  createShellPaths,
  createSyncHooks,
  type DataAccess,
} from "./services";

export const host = new Context();

export const routes = createRouteRegistry();
export const shell = createShellPaths();
export const sync = createSyncHooks();
host.provide("routes", routes);
host.provide("shell", shell);
host.provide("sync", sync);

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

export interface PluginState {
  id: string;
  displayName: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  error?: string;
}

const mounted = new Map<string, Scope>();
/** Mounts and unmounts happen one at a time; concurrent settings writes queue. */
let turn: Promise<void> = Promise.resolve();

/**
 * Bring the mounted plugins in line with the settings: mount what is wanted
 * and not there, dispose what is there and no longer wanted. Resolves once
 * every newly mounted plugin has applied.
 */
export function syncPlugins(state: Record<string, unknown>): Promise<void> {
  const run = turn.then(async () => {
    for (const { manifest, plugin } of builtinHostPlugins) {
      const want = pluginWanted(manifest, state);
      const have = mounted.get(manifest.id);
      if (want && !have) {
        const scope = host.plugin(plugin);
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

/** What Settings → Plugins and `GET /api/state` list. */
export function pluginStates(): PluginState[] {
  return builtinHostPlugins.map(({ manifest }) => {
    const scope = mounted.get(manifest.id);
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      builtin: true,
      enabled: scope?.status === "active",
      ...(scope?.error ? { error: scope.error.message } : {}),
    };
  });
}
