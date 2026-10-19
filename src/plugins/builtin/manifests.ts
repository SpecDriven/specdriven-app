// The built-in plugins' manifests, in load order — what the profile falls
// back to, what the demo enables, and what either loader lists. Kept apart
// from the halves so the server, the demo and the browser can all read it
// without pulling in a plugin's code.

import type { PluginManifest } from "../manifest";
import { manifest as issues } from "./issues/manifest";
import { notebookManifest, roadmapManifest, tasksManifest } from "./pages/manifest";
import { manifest as selfFix } from "./self-fix/manifest";
import { manifest as tests } from "./tests/manifest";

export const builtinManifests: readonly PluginManifest[] = [
  roadmapManifest,
  tasksManifest,
  notebookManifest,
  issues,
  tests,
  selfFix,
];

/** The manifest of a built-in plugin, by id. */
export function builtinManifest(id: string): PluginManifest | undefined {
  return builtinManifests.find((m) => m.id === id);
}

/**
 * Built-ins that left the tree for the marketplace — the Event Models, now
 * the `models` plugin of the SpecDriven/plugins index. Kept for the profile
 * alone: a settings file from before plugins with the old switch on
 * (`models: true`) still lists the plugin, and Settings → Plugins names it
 * and offers to install it rather than reporting an unknown id.
 */
export const retiredManifests: readonly PluginManifest[] = [
  {
    id: "models",
    api: "1",
    displayName: "Event models",
    description: "Event Models drawn on a canvas, sliced into specs",
    defaultEnabled: false,
    legacyKey: "models",
  },
];

/** A retired built-in's manifest, by id. */
export function retiredManifest(id: string): PluginManifest | undefined {
  return retiredManifests.find((m) => m.id === id);
}

/** What the profile reads the legacy switches through: the built-ins and the retired ones. */
export const profileManifests: readonly PluginManifest[] = [...builtinManifests, ...retiredManifests];
