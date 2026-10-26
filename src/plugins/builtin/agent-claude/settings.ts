// The Claude agent plugin's own settings (specs/agents/claude.feature.md
// "Choose how Claude signs in", specs/agents/agent-pane.feature.md "A Claude
// turn fails fast when the API proxy does not answer"): how the Claude the
// app starts signs in, the proxy it goes through, and how long a turn
// behind that proxy waits for the API. Kept under `pluginSettings
// ["agent-claude"]` (src/plugins/host/pluginSettings.ts); the top-level
// keys they lived under before are adopted once and still read for one
// release, the section winning where both are set. Pure, so the server and
// the browser share it.

import { pluginSection } from "../../host/pluginSettings";
import {
  DEFAULT_AGENT_FIRST_RESPONSE_SECONDS,
  normalizeAgentFirstResponseSeconds,
  normalizeClaudeAuth,
  normalizeClaudeProxyUrl,
  type ClaudeAuthMode,
} from "../../../server/state";

export const CLAUDE_PLUGIN_ID = "agent-claude";

/** The top-level settings keys the plugin's values lived under before it was a plugin. */
export const CLAUDE_LEGACY_KEYS = ["claudeAuth", "claudeProxyUrl", "agentFirstResponseSeconds"] as const;

/** Set in the section once the plugin took the old keys over: from then on the section alone is read. */
export const ADOPTED_KEY = "adopted";

export interface ClaudeSettingsValues {
  /** The stored choice, or null when the server infers one. */
  claudeAuth: ClaudeAuthMode | null;
  /** The proxy url stored by the app, or null for the one Claude Code's own settings name. */
  claudeProxyUrl: string | null;
  /** The pane's first-response wait, whole seconds; 0 is no limit. */
  firstResponseSeconds: number;
}

/** The plugin's values off a settings object: its section first, the legacy keys after. */
export function claudeSettingsOf(state: object): ClaudeSettingsValues {
  const raw = state as Record<string, unknown>;
  const own = pluginSection(raw, CLAUDE_PLUGIN_ID);
  // Before the plugin took the keys over, the old top-level ones still say;
  // after, a key the section lacks is unset, whatever the old ones say.
  const adopted = own[ADOPTED_KEY] === true;
  const pick = (key: (typeof CLAUDE_LEGACY_KEYS)[number]) => (key in own ? own[key] : adopted ? undefined : raw[key]);
  return {
    claudeAuth: normalizeClaudeAuth(pick("claudeAuth")),
    claudeProxyUrl: normalizeClaudeProxyUrl(pick("claudeProxyUrl")),
    firstResponseSeconds: normalizeAgentFirstResponseSeconds(pick("agentFirstResponseSeconds")),
  };
}

/**
 * A `PUT /api/claude/settings` body as a patch to the section, or the
 * refusal: `claudeAuth` login, proxy or null (forget the choice);
 * `claudeProxyUrl` an http(s) url, "" or null (forget it);
 * `firstResponseSeconds` a number >= 0, the default stored as no key.
 */
export function claudeSettingsPatch(body: unknown): { patch: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "a settings object is required" };
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.claudeAuth !== undefined) {
    if (b.claudeAuth === null) patch.claudeAuth = null;
    else {
      const mode = normalizeClaudeAuth(b.claudeAuth);
      if (!mode) return { error: "claudeAuth must be login, proxy or null" };
      patch.claudeAuth = mode;
    }
  }
  if (b.claudeProxyUrl !== undefined) {
    if (b.claudeProxyUrl !== null && typeof b.claudeProxyUrl !== "string") {
      return { error: "claudeProxyUrl must be a string or null" };
    }
    const url = (b.claudeProxyUrl ?? "").trim();
    if (url && !normalizeClaudeProxyUrl(url)) return { error: "claudeProxyUrl must be an http:// or https:// url" };
    patch.claudeProxyUrl = url || null;
  }
  if (b.firstResponseSeconds !== undefined) {
    const n = b.firstResponseSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return { error: "firstResponseSeconds must be a number >= 0" };
    }
    patch.agentFirstResponseSeconds = Math.floor(n) === DEFAULT_AGENT_FIRST_RESPONSE_SECONDS ? null : Math.floor(n);
  }
  if (Object.keys(patch).length === 0) return { error: "claudeAuth, claudeProxyUrl or firstResponseSeconds is required" };
  return { patch };
}
