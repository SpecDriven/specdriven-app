// The agents the core still ships (specs/agents/agent-plugins.feature.md):
// Claude, Codex and Pi, registered as providers like any plugin's. They
// leave for the marketplace plugins in a later step; until then this is
// what api.ts imports to have them on the registry. Registering twice (a
// `bun --hot` reload, a test's restore) replaces, so this is safe to repeat.

import { agents } from "../plugins/host/agents";
import { claudeProvider } from "./agents/claude";
import { codexProvider } from "./agents/codex";
import { piProvider } from "./agents/pi";

/** Register the three built-in providers, replacing whatever held their ids. */
export function registerCoreAgents(): void {
  for (const provider of [claudeProvider, codexProvider, piProvider]) {
    if (agents.get(provider.id) === provider) continue;
    agents.register(provider);
  }
}

registerCoreAgents();
