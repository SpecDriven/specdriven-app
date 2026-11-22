// Specs as a plugin (specs/app/plugins.feature.md "Specs is a built-in
// plugin"): what both halves and both loaders know about it. The feature
// tree, the editor and the spec routes are still the core's — the plugin is
// the tab's switch and its place in the tab order, per data folder.

import type { PluginManifest } from "../../manifest";
import { SPECS_PLUGIN } from "../../profile";

export const manifest: PluginManifest = {
  id: SPECS_PLUGIN,
  api: "1",
  displayName: "Specs",
  description: "Features and their scenarios, in the folder tree",
  // On wherever nothing says otherwise: every folder had it before it was a
  // plugin. No `paths` — a feature's url is the app's own, served either way.
  defaultEnabled: true,
};
