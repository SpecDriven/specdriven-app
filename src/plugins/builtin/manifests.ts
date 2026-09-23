// The built-in plugins' manifests, in load order — what the profile falls
// back to, what the demo enables, and what either loader lists. Kept apart
// from the halves so the server, the demo and the browser can all read it
// without pulling in a plugin's code.

import type { PluginManifest } from "../manifest";
import { manifest as issues } from "./issues/manifest";
import { manifest as models } from "./models/manifest";
import { notebookManifest, roadmapManifest, tasksManifest } from "./pages/manifest";
import { manifest as tests } from "./tests/manifest";

export const builtinManifests: readonly PluginManifest[] = [
  roadmapManifest,
  tasksManifest,
  notebookManifest,
  issues,
  models,
  tests,
];

/** The manifest of a built-in plugin, by id. */
export function builtinManifest(id: string): PluginManifest | undefined {
  return builtinManifests.find((m) => m.id === id);
}
