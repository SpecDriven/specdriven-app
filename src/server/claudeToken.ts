// Where the API proxy's token for Claude lives (specs/agents/claude.feature.md
// "API proxy settings are filled in from Claude Code's settings"). Like the
// GitHub token (src/server/tokenStore.ts) it is deliberately NOT part of
// settings.json — settings are shareable, a credential never is. The default
// backend is a 0600 JSON file next to the home settings file; the desktop app
// swaps in an OS-encrypted backend (Electron safeStorage) via
// setClaudeTokenBackend before the server starts.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** The bearer token the proxy expects (what ANTHROPIC_AUTH_TOKEN would be). */
export interface ClaudeTokenRecord {
  token: string;
}

export interface ClaudeTokenBackend {
  load(): Promise<ClaudeTokenRecord | null>;
  save(record: ClaudeTokenRecord): Promise<void>;
  clear(): Promise<void>;
}

export const CLAUDE_TOKEN_FILE = "claude-token.json";

/** The default token file: ~/.specdriven/claude-token.json ($SPECDRIVEN_HOME). */
export function claudeTokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), CLAUDE_TOKEN_FILE);
}

/** A stored record, or null when it is not one; shared with the desktop backend. */
export function parseClaudeRecord(raw: string): ClaudeTokenRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeTokenRecord>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    return { token: parsed.token };
  } catch {
    return null; // a corrupt token file means no token, never a crash
  }
}

/**
 * File backend used by the web server and as the desktop fallback. The
 * path is resolved per call so a changed $SPECDRIVEN_HOME (tests) is
 * honored without re-creating the backend.
 */
export function createClaudeFileBackend(fixedPath?: string): ClaudeTokenBackend {
  const where = () => fixedPath ?? claudeTokenPath();
  return {
    async load() {
      try {
        return parseClaudeRecord(await readFile(where(), "utf8"));
      } catch {
        return null;
      }
    },
    async save(record) {
      const path = where();
      await writeTextFile(path, JSON.stringify(record, null, 2) + "\n");
      await chmod(path, 0o600); // the token is a credential — owner-only
    },
    async clear() {
      await rm(where(), { force: true });
    },
  };
}

let backend: ClaudeTokenBackend = createClaudeFileBackend();
let cached: ClaudeTokenRecord | null | undefined; // undefined = not loaded yet

/** Swap the storage backend (Electron safeStorage); resets the cache. */
export function setClaudeTokenBackend(next: ClaudeTokenBackend): void {
  backend = next;
  cached = undefined;
}

export async function loadClaudeToken(): Promise<ClaudeTokenRecord | null> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

export async function saveClaudeToken(record: ClaudeTokenRecord): Promise<void> {
  await backend.save(record);
  cached = record;
}

export async function clearClaudeToken(): Promise<void> {
  await backend.clear();
  cached = null;
}
