// The Pi agent (specs/agents/integration-with-pi-dev-agent.feature.md,
// specs/agents/agent-plugins.feature.md) as a plugin: a host half only,
// which registers the provider over `pi --mode rpc`.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "agent-pi",
  api: "1",
  displayName: "Pi agent",
  description: "pi.dev's coding agent in the coding agent pane — minimal, and it runs its own tools",
  defaultEnabled: true,
  autoEnable: true,
  permissions: ["process:spawn"],
};
