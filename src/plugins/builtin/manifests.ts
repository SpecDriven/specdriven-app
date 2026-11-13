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
 * the `models` plugin of the SpecDriven/plugins index, and the three coding
 * agents (specs/agents/agent-plugins.feature.md), which the app installs by
 * itself where it finds their commands. Kept for the profile alone: a
 * settings file from before plugins with the old switch on (`models: true`)
 * still lists the plugin, a folder's list from when the agents were built
 * in still names them, and Settings → Plugins names each and offers to
 * install it rather than reporting an unknown id.
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
  {
    id: "agent-claude",
    api: "1",
    displayName: "Claude agent",
    description: "Claude Code in the coding agent pane, with its sign-in (your Claude account or the API) in Settings",
    defaultEnabled: false,
  },
  {
    id: "agent-codex",
    api: "1",
    displayName: "Codex agent",
    description: "OpenAI Codex in the coding agent pane, with its sign-in (your ChatGPT account or the API) in Settings",
    defaultEnabled: false,
  },
  {
    id: "agent-pi",
    api: "1",
    displayName: "Pi agent",
    description: "Pi in the coding agent pane",
    defaultEnabled: false,
  },
];

/** A retired built-in's manifest, by id. */
export function retiredManifest(id: string): PluginManifest | undefined {
  return retiredManifests.find((m) => m.id === id);
}

/** What the profile reads the legacy switches through: the built-ins and the retired ones. */
export const profileManifests: readonly PluginManifest[] = [...builtinManifests, ...retiredManifests];
