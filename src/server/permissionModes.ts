// The pane's permission modes, shared with the client (src/frontend/AgentPane.tsx),
// so nothing here may import server-only code.
import type { ChatAgent } from "./agentChat";

/** The permission modes the pane offers, in its order; the SDK knows one
    more (dontAsk). "default" is the SDK's name for asking every time. */
export type PermissionMode = "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

/** The mode a new session starts in: Claude decides its own permissions
    (auto), Codex asks (its "auto" is the same policy), pi has no gate. */
export function defaultPermissionMode(agent: ChatAgent): PermissionMode {
  return agent === "claude" ? "auto" : agent === "pi" ? "bypassPermissions" : "default";
}
