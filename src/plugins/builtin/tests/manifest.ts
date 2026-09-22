// The test management module (specs/app/tests.feature.md) as a plugin: what
// both halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "tests",
  api: "1",
  displayName: "Test management",
  description: "Test cases, plans and runs on their own tab",
  // The historical settings key; off unless turned on.
  switch: { key: "testing", default: false },
  paths: ["/tests"],
};
