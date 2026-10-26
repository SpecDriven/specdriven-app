// The built-in agent plugins (src/plugins/builtin/agent-*), mounted for a
// test of the coding agent routes: their providers sit on the registry
// only while the plugins are on, as in the app (specs/agents/agent-plugins
// .feature.md). Mount in beforeEach, unmount in afterEach so a later file
// starts from nothing.

import { syncPlugins } from "../../src/plugins/host/loader";

export const AGENT_PLUGIN_IDS = ["agent-claude", "agent-codex", "agent-pi"] as const;

/** Mount the three agent plugins (and nothing else), from the app root's settings. */
export async function mountAgentPlugins(extra: readonly string[] = []): Promise<void> {
  await syncPlugins({ plugins: { enabled: [...AGENT_PLUGIN_IDS, ...extra] } });
}

/** Unmount every plugin. */
export async function unmountAgentPlugins(): Promise<void> {
  await syncPlugins({ plugins: { enabled: [] } });
}
