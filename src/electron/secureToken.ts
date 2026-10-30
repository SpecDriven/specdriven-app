// Token storage for the desktop app (specs/app/desktop-app.feature.md,
// specs/external-links/confluence-wiki.feature.md): Electron safeStorage
// encrypts with the OS keychain, so a token never sits on disk in plain text.
// When the OS offers no key store (some Linux setups), the caller falls back
// to the server's 0600-file backends.

import { safeStorage } from "electron";
import { readFile, rm } from "node:fs/promises";
import { writeTextFile } from "../server/fsx";
import { parseSecretRecord, type SecretBackend } from "../server/secrets";
import { parseConfluenceRecords, type ConfluenceTokenBackend } from "../server/confluenceTokens";
import { parseQtestRecords, type QtestTokenBackend } from "../server/qtestTokens";
import { parseAhaRecords, type AhaTokenBackend } from "../server/ahaTokens";
import { parseJiraRecords, type JiraTokenBackend } from "../server/jiraTokens";
import { parseRecord, type TokenBackend } from "../server/tokenStore";

// The async safeStorage API throughout: the synchronous one is deprecated
// in Electron 45 and gone in 46, and both read the same per-platform key
// store, so files written by the old encryptString still decrypt.
export function safeStorageAvailable(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable();
}

/**
 * A value kept encrypted in `file` (base64 of the ciphertext). Missing,
 * corrupt or undecryptable (e.g. keychain reset) reads as `empty` — never a
 * startup crash.
 */
function encryptedFile<T>(file: string, parse: (raw: string) => T | null, empty: T) {
  async function write(value: T): Promise<void> {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
    await writeTextFile(file, encrypted.toString("base64"));
  }
  return {
    async load(): Promise<T> {
      try {
        const encrypted = Buffer.from(await readFile(file, "utf8"), "base64");
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
        const value = parse(result) ?? empty;
        // The OS rotated its key: rewrite before the old one stops decrypting.
        if (shouldReEncrypt && value !== empty) await write(value).catch(() => {});
        return value;
      } catch {
        return empty;
      }
    },
    save: write,
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

/** The qTest tokens on safeStorage. */
export function createQtestSafeStorageBackend(file: string): QtestTokenBackend {
  return encryptedFile(file, parseQtestRecords, []);
}

/** The Jira tokens on safeStorage. */
export function createJiraSafeStorageBackend(file: string): JiraTokenBackend {
  return encryptedFile(file, parseJiraRecords, []);
}

/** The Aha! API keys on safeStorage. */
export function createAhaSafeStorageBackend(file: string): AhaTokenBackend {
  return encryptedFile(file, parseAhaRecords, []);
}

/** A plugin's secret store on safeStorage (src/server/secrets.ts). */
export function createSecretSafeStorageBackend(file: string): SecretBackend {
  return encryptedFile(file, parseSecretRecord, null);
}
