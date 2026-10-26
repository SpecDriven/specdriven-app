// The Claude API proxy's token (specs/agents/claude.feature.md "API proxy
// settings are filled in from Claude Code's settings"), kept for one release
// as a typed view over the generic secret store the Claude agent plugin
// owns (src/server/secrets.ts, store "agent-claude.token"). Its file stays
// where it was — ~/.specdriven/claude-token.json, or the desktop's
// claude-token.enc — so nothing migrates. The desktop app no longer swaps a
// backend here; it sets the secret backend factory.

import { createSecretFileBackend, secretPath, secretStore, setSecretBackend, type SecretBackend } from "./secrets";

/** The bearer token the proxy expects (what ANTHROPIC_AUTH_TOKEN would be). */
export interface ClaudeTokenRecord {
  token: string;
}

export type ClaudeTokenBackend = SecretBackend;

/** The secret store's name, namespaced by the plugin that owns it. */
export const CLAUDE_TOKEN_STORE = "agent-claude.token";

export const CLAUDE_TOKEN_FILE = "claude-token.json";

/** The default token file: ~/.specdriven/claude-token.json ($SPECDRIVEN_HOME). */
export function claudeTokenPath(): string {
  return secretPath(CLAUDE_TOKEN_STORE);
}

/** A stored record, or null when it is not one. */
export function parseClaudeRecord(raw: string): ClaudeTokenRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeTokenRecord>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    return { token: parsed.token };
  } catch {
    return null;
  }
}

/** The file backend at the store's path, or at a fixed one (tests). */
export function createClaudeFileBackend(fixedPath?: string): ClaudeTokenBackend {
  return createSecretFileBackend(CLAUDE_TOKEN_STORE, fixedPath);
}

/** Swap the storage backend (a test's fixed file); resets the cache. */
export function setClaudeTokenBackend(next: ClaudeTokenBackend): void {
  setSecretBackend(CLAUDE_TOKEN_STORE, next);
}

export async function loadClaudeToken(): Promise<ClaudeTokenRecord | null> {
  const record = await secretStore(CLAUDE_TOKEN_STORE).load();
  return record?.token ? { token: record.token } : null;
}

export async function saveClaudeToken(record: ClaudeTokenRecord): Promise<void> {
  await secretStore(CLAUDE_TOKEN_STORE).save({ token: record.token });
}

export async function clearClaudeToken(): Promise<void> {
  await secretStore(CLAUDE_TOKEN_STORE).clear();
}
