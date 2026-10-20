// Token storage for the desktop app (specs/app/desktop-app.feature.md,
// specs/external-links/confluence-wiki.feature.md): Electron safeStorage
// encrypts with the OS keychain, so a token never sits on disk in plain text.
// When the OS offers no key store (some Linux setups), the caller falls back
// to the server's 0600-file backends.

import { safeStorage } from "electron";
import { readFile, rm } from "node:fs/promises";
import { writeTextFile } from "../server/fsx";
import { parseClaudeRecord, type ClaudeTokenBackend } from "../server/claudeToken";
import { parseConfluenceRecords, type ConfluenceTokenBackend } from "../server/confluenceTokens";
import { parseRecord, type TokenBackend } from "../server/tokenStore";

export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/**
 * A value kept encrypted in `file` (base64 of the ciphertext). Missing,
 * corrupt or undecryptable (e.g. keychain reset) reads as `empty` — never a
 * startup crash.
 */
function encryptedFile<T>(file: string, parse: (raw: string) => T | null, empty: T) {
  return {
    async load(): Promise<T> {
      try {
        const encrypted = Buffer.from(await readFile(file, "utf8"), "base64");
        return parse(safeStorage.decryptString(encrypted)) ?? empty;
      } catch {
        return empty;
      }
    },
    async save(value: T): Promise<void> {
      const encrypted = safeStorage.encryptString(JSON.stringify(value));
      await writeTextFile(file, encrypted.toString("base64"));
    },
    async clear(): Promise<void> {
      await rm(file, { force: true });
    },
  };
}

/** The GitHub sign-in on safeStorage. */
export function createSafeStorageBackend(tokenFile: string): TokenBackend {
  return encryptedFile(tokenFile, parseRecord, null);
}

/** The Confluence tokens on safeStorage. */
export function createConfluenceSafeStorageBackend(file: string): ConfluenceTokenBackend {
  return encryptedFile(file, parseConfluenceRecords, []);
}

/** The Claude API proxy's token on safeStorage (src/server/claudeToken.ts). */
export function createClaudeSafeStorageBackend(file: string): ClaudeTokenBackend {
  return encryptedFile(file, parseClaudeRecord, null);
}
