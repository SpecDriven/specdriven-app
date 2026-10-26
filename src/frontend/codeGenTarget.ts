// Where "Start session" runs (specs/agents/claude.feature.md): a new
// session in Claude Code Desktop, or the app's own coding agent pane
// driven by one of the agents the plugins supply
// (specs/agents/agent-plugins.feature.md). The target is "desktop" or a
// provider id.

import type { AgentDescriptor } from "../server/agentTypes";
import type { CodeGenTarget } from "../server/state";

export type { CodeGenTarget };

/** The stored target as the server reports it; anything else is "not chosen". */
export function readCodeGenTarget(value: unknown, agents: readonly AgentDescriptor[]): CodeGenTarget | null {
  if (typeof value !== "string") return null;
  return value === "desktop" || agents.some((a) => a.id === value) ? value : null;
}

/** What the session dialog and its notices call a target. */
export function codeGenTargetLabel(target: CodeGenTarget, agents: readonly AgentDescriptor[]): string {
  if (target === "desktop") return "Claude Code Desktop";
  const agent = agents.find((a) => a.id === target);
  return `${agent?.label ?? target} in the coding agent pane`;
}

/** The agents a session can run in here: those whose CLI is on PATH, by rank. */
export function usableAgents(agents: readonly AgentDescriptor[]): AgentDescriptor[] {
  return agents.filter((a) => a.available);
}

/** The target a session dialog opens on: the remembered choice when it is
    still usable, else desktop when Claude.app is installed, else the first
    usable agent by rank. With nothing installed the answer is desktop, and
    the server says what is missing. */
export function resolveCodeGenTarget(
  stored: string | null | undefined,
  canOpenDesktop: boolean,
  agents: readonly AgentDescriptor[] = [],
): CodeGenTarget {
  const usable = usableAgents(agents);
  const wanted = readCodeGenTarget(stored, agents);
  if (wanted === "desktop" && canOpenDesktop) return "desktop";
  if (wanted && usable.some((a) => a.id === wanted)) return wanted;
  if (canOpenDesktop) return "desktop";
  return usable[0]?.id ?? "desktop";
}
