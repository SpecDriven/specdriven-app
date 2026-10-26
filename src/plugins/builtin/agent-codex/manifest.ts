// The Codex agent (specs/agents/agent-plugins.feature.md) as a plugin: a
// host half only, which registers the provider over `codex app-server`.

import type { PluginManifest } from "../../manifest";

export const manifest: PluginManifest = {
  id: "agent-codex",
  api: "1",
  displayName: "Codex agent",
  description: "OpenAI's Codex CLI in the coding agent pane, with permission cards for commands and file changes",
  defaultEnabled: true,
  autoEnable: true,
  permissions: ["process:spawn"],
};
