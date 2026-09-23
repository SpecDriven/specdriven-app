// The host loader (specs/app/plugins.feature.md "A built-in module is a
// plugin like any other"): one kernel context for the server, the core
// services on it, and the built-in plugins mounted and unmounted as the
// profile — the ordered `plugins.enabled` list in settings — says. Mounting
// is what adds a module's routes; disposing removes them, so a switched-off
// module answers 404 without any per-route check — the server refuses the
// module's requests, not just the UI.

import { version as appVersion } from "../../../package.json";
import { Context, type Scope } from "../kernel";
import { readProfile } from "../profile";
import { builtinHostPlugins } from "../builtin/host";
import { builtinManifests } from "../builtin/manifests";
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

/** One row of Settings → Plugins and of `GET /api/state`'s `plugins`. */
export interface PluginState {
  id: string;
  displayName: string;
  description: string;
  /** The plugin's version — a built-in's is the app's. */
  version: string;
  /** In the tree, always present, never uninstalled. */
  builtin: boolean;
  /** Some source provides it; false for a profile entry nothing provides. */
  installed: boolean;
  /** Listed in the profile. */
  enabled: boolean;
  /** Mounted and applied — enabled, installed, and `apply` did not throw. */
  active: boolean;
  error?: string;
}

const mounted = new Map<string, Scope>();
/** The profile as last synced: the enabled ids in tab order. */
let profile: string[] = [];
/** Mounts and unmounts happen one at a time; concurrent settings writes queue. */
let turn: Promise<void> = Promise.resolve();

/**
 * Bring the mounted plugins in line with the settings: mount what the
 * profile lists and is not there, in the profile's order, and dispose what
 * is there and no longer listed. A settings object from before the profile
 * (the per-module switches) is read as the matching list
 * (src/plugins/profile.ts). Resolves once every newly mounted plugin has
 * applied.
 */
export function syncPlugins(state: Record<string, unknown>): Promise<void> {
  const run = turn.then(async () => {
    const { enabled } = readProfile(state, builtinManifests);
    profile = enabled;
    for (const [id, scope] of [...mounted]) {
      if (!enabled.includes(id)) {
        mounted.delete(id);
        await scope.dispose();
      }
    }
    for (const id of enabled) {
      const entry = builtinHostPlugins.find((p) => p.manifest.id === id);
      if (!entry || mounted.has(id)) continue;
      const scope = host.plugin(entry.plugin);
      mounted.set(id, scope);
      await scope.ready;
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
 * installed plugins it leaves off, in load order.
 */
export function pluginStates(): PluginState[] {
  const rows: PluginState[] = [];
  for (const id of profile) {
    const manifest = builtinManifests.find((m) => m.id === id);
    if (manifest) {
      rows.push(stateOf(manifest, true));
    } else {
      rows.push({
        id,
        displayName: id,
        description: "",
        version: "",
        builtin: false,
        installed: false,
        enabled: true,
        active: false,
        error: "No installed plugin has this id; it is listed in the profile and ignored.",
      });
    }
  }
  for (const manifest of builtinManifests) {
    if (!profile.includes(manifest.id)) rows.push(stateOf(manifest, false));
  }
  return rows;
}

function stateOf(
  manifest: (typeof builtinManifests)[number],
  enabled: boolean,
): PluginState {
  const scope = mounted.get(manifest.id);
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    version: appVersion,
    builtin: true,
    installed: true,
    enabled,
    active: scope?.status === "active",
    ...(scope?.error ? { error: scope.error.message } : {}),
  };
}
