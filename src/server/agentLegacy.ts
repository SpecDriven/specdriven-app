// What the app wrote before agents were providers
// (specs/agents/agent-plugins.feature.md "A session record from before agent
// plugins still opens"): a session record named the pane it ran in
// ("pane", "pi-pane", "codex-pane"); it now carries the provider id. Old
// records are not rewritten; they are read through this map. (The stored
// "Run in" choice had the same alias for one release; a settings file that
// still says "pane" now reads as "not chosen".)

/** `session.json` agent values → provider ids. */
export const LEGACY_RECORD_AGENTS: Readonly<Record<string, string>> = {
  pane: "claude",
  "pi-pane": "pi",
  "codex-pane": "codex",
};

/** The provider id a record's `agent` means — the old pane names mapped,
    anything else as written (a desktop launch, a plugin's id). */
export function normalizeRecordAgent(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return LEGACY_RECORD_AGENTS[value] ?? value;
}
