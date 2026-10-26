// What the app wrote before agents were providers
// (specs/agents/agent-plugins.feature.md "A session record from before agent
// plugins still opens"): a session record named the pane it ran in
// ("pane", "pi-pane", "codex-pane") and the remembered "Run in" choice
// said "pane" for Claude. Both now carry the provider id. Old files are not
// rewritten; they are read through these maps.

/** `session.json` agent values → provider ids. */
export const LEGACY_RECORD_AGENTS: Readonly<Record<string, string>> = {
  pane: "claude",
  "pi-pane": "pi",
  "codex-pane": "codex",
};

/** Stored `codeGenTarget` values → provider ids. */
export const LEGACY_CODE_GEN_TARGETS: Readonly<Record<string, string>> = {
  pane: "claude",
};

/** The provider id a record's `agent` means — the old pane names mapped,
    anything else as written (a desktop launch, a plugin's id). */
export function normalizeRecordAgent(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return LEGACY_RECORD_AGENTS[value] ?? value;
}
