// Fix this app (specs/app/self-healing.feature.md) as a plugin: what both
// halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "self-fix",
  api: "1",
  displayName: "Fix this app",
  description: "Describe a bug; a coding agent fixes the app's own source, and the app rebuilds and restarts into the fix",
  defaultEnabled: true,
  paths: ["/fix-app"],
};
