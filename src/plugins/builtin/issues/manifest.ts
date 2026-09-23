// GitHub issue tracking (specs/app/github-issues.feature.md) as a plugin:
// what both halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "issues",
  api: "1",
  displayName: "GitHub issues",
  description: "The code repo's GitHub issues on their own tab",
  // The historical settings key; off unless turned on.
  switch: { key: "issues", default: false },
  paths: ["/issues"],
};
