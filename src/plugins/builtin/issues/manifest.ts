// GitHub issue tracking (specs/app/github-issues.feature.md) as a plugin:
// what both halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "issues",
  api: "1",
  displayName: "GitHub issues",
  description: "The code repo's GitHub issues on their own tab",
  // Off unless turned on; `issues` was its switch before the profile.
  defaultEnabled: false,
  legacyKey: "issues",
  paths: ["/issues"],
};
