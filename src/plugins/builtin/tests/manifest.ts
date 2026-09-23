// The test management module (specs/app/tests.feature.md) as a plugin: what
// both halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "tests",
  api: "1",
  displayName: "Test management",
  description: "Test cases, plans and runs on their own tab",
  // Off unless turned on; `testing` was its switch before the profile.
  defaultEnabled: false,
  legacyKey: "testing",
  paths: ["/tests"],
};
