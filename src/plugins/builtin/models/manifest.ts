// Event Models (roadmap/support-event-modeling.md) as a plugin: what both
// halves and both loaders know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "models",
  api: "1",
  displayName: "Event models",
  description: "Event Models drawn on a canvas, sliced into specs",
  // The historical settings key; off unless turned on.
  switch: { key: "models", default: false },
  paths: ["/models"],
};
