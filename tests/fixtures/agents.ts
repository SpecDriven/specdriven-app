// Agent descriptors as /api/state reports them (src/server/agentTypes.ts),
// for the client tests: the three built-in agents, and a builder for one
// a plugin might bring.

import type { AgentDescriptor, PermissionMode } from "../../src/server/agentTypes";

export const ALL_MODES: readonly PermissionMode[] = ["auto", "default", "acceptEdits", "plan", "bypassPermissions"];

/** A descriptor with sensible defaults: available, every mode, Stop, "rule" remembering. */
export function agent(overrides: Partial<AgentDescriptor> & { id: string }): AgentDescriptor {
  const label = overrides.label ?? overrides.id.charAt(0).toUpperCase() + overrides.id.slice(1);
  return {
    label,
    description: `${label}, a coding agent`,
    cli: overrides.id,
    available: true,
    missingMessage: `${label} CLI not found — install the \`${overrides.id}\` command`,
    plugin: `agent-${overrides.id}`,
    defaultPermissionMode: "default",
    rank: 100,
    ...overrides,
    capabilities: {
      permissionModes: ALL_MODES,
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "rule",
      oneShot: false,
      ...overrides.capabilities,
    },
  };
}

export const CLAUDE_AGENT = agent({
  id: "claude",
  label: "Claude",
  description: "Claude Code, with permission cards and its own commands",
  rank: 10,
  defaultPermissionMode: "auto",
  capabilities: { permissionModes: ALL_MODES, canInterrupt: true, canChangeModeMidSession: true, hasAccount: true, rememberPermissions: "rule", oneShot: true },
  loginHint: { text: "The Claude CLI is not signed in on this machine: run the command in a terminal, then start a new session.", command: "claude auth login" },
});

export const CODEX_AGENT = agent({
  id: "codex",
  label: "Codex",
  description: "OpenAI's Codex CLI, with permission cards for commands and file changes",
  rank: 20,
  defaultPermissionMode: "default",
  capabilities: { permissionModes: ALL_MODES, canInterrupt: true, canChangeModeMidSession: true, hasAccount: false, rememberPermissions: "session", oneShot: false },
  loginHint: { text: "The Codex CLI is not signed in on this machine: run the command in a terminal, then start a new session.", command: "codex login" },
});

export const PI_AGENT = agent({
  id: "pi",
  label: "Pi",
  description: "Minimal, and runs its own tools — nothing asks for permission",
  rank: 30,
  defaultPermissionMode: "bypassPermissions",
  capabilities: {
    permissionModes: [],
    noPermissionsNote: "Pi runs its own tools — SpecDriven cannot gate them",
    canInterrupt: true,
    canChangeModeMidSession: false,
    hasAccount: false,
    rememberPermissions: "none",
    oneShot: false,
  },
  loginHint: { text: "Pi has no credentials for this model here: run pi in a terminal and /login, then start a new session.", command: "pi" },
});

/** The three, with only the named ones' CLIs found. */
export function agentsWith(...available: string[]): AgentDescriptor[] {
  return [CLAUDE_AGENT, CODEX_AGENT, PI_AGENT].map((a) => ({ ...a, available: available.includes(a.id) }));
}
