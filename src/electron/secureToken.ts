// GitHub token storage for the desktop app (specs/desktop-app.spec.md):
// Electron safeStorage encrypts with the OS keychain, so the token never
// sits on disk in plain text. When the OS offers no key store (some Linux
// setups), the caller falls back to the server's 0600-file backend.

import { safeStorage } from "electron";
import { readFile, rm } from "node:fs/promises";
import { writeTextFile } from "../server/fsx";
import type { TokenBackend, TokenRecord } from "../server/tokenStore";

export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** TokenBackend on safeStorage; tokenFile is base64 of the ciphertext. */
export function createSafeStorageBackend(tokenFile: string): TokenBackend {
  return {
    async load() {
      try {
        const encrypted = Buffer.from(await readFile(tokenFile, "utf8"), "base64");
        return JSON.parse(safeStorage.decryptString(encrypted)) as TokenRecord;
      } catch {
        // Missing, corrupt or undecryptable (e.g. keychain reset) reads as
        // signed out — never a startup crash.
        return null;
      }
    },
    async save(record) {
      const encrypted = safeStorage.encryptString(JSON.stringify(record));
      await writeTextFile(tokenFile, encrypted.toString("base64"));
    },
    async clear() {
      await rm(tokenFile, { force: true });
    },
  };
}
