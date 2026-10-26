// The Claude agent (specs/agents/claude.feature.md, specs/agents/
// agent-plugins.feature.md) as a plugin: what both halves and both loaders
// know about it.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "agent-claude",
  api: "1",
  displayName: "Claude agent",
  description: "Claude Code in the coding agent pane, with its sign-in and proxy settings",
  defaultEnabled: true,
  autoEnable: true,
  permissions: ["process:spawn", "settings:write", "secrets"],
};
