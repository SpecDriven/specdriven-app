// Where the GitHub sign-in token lives (git-operations.md). The
// token is deliberately NOT part of settings.yaml — settings are shareable,
// the token never is. The default backend is a 0600 JSON file next to the
// home settings file; the desktop app swaps in an OS-encrypted backend
// (Electron safeStorage) via setTokenBackend before the server starts.
//
// The store itself is the TokenStore service
// (src/server/persistence/Credentials.ts), which also owns the record's
// shape and parser; the functions here are its Promise forms.

import { tokenFile, TokenStore, tokenPath, parseRecord } from "./persistence/Credentials";
import type { TokenBackend, TokenRecord } from "./persistence/Credentials";
import { run, runSync } from "./persistence/runtime";

export { parseRecord, TOKEN_FILE, tokenPath } from "./persistence/Credentials";
export type { TokenBackend, TokenRecord } from "./persistence/Credentials";

/**
 * File backend used by the web server and as the desktop fallback. The
 * path is resolved per call so a changed $SPECDRIVEN_HOME (tests, install
 * scripts) is honored without re-creating the backend.
 */
export function createFileBackend(fixedPath?: string): TokenBackend {
  const where = () => fixedPath ?? tokenPath();
  return {
    load: () => run(tokenFile.load(where())),
    save: (record) => run(tokenFile.save(where(), record)),
    clear: () => run(tokenFile.clear(where())),
  };
}

/** The variable a hosted worker's token arrives in (src/gateway/workers.ts). */
export const TOKEN_ENV = "SPECDRIVEN_GITHUB_TOKEN_RECORD";

/**
 * Hosted backend (src/server/hostedMode.ts): the gateway decrypts the user's
 * token and hands it to their worker in TOKEN_ENV, a TokenRecord as JSON.
 * Nothing is written to disk, and the worker cannot change the token — the
 * account page does that, and restarts the worker with the new one.
 */
export function createEnvBackend(env: Record<string, string | undefined> = process.env): TokenBackend {
  const refuse = async () => {
    throw new Error("The GitHub token is managed on the account page");
  };
  return {
    async load() {
      const raw = env[TOKEN_ENV];
      return raw ? parseRecord(raw) : null;
    },
    save: refuse,
    clear: refuse,
  };
}

/** Swap the storage backend (Electron safeStorage); resets the cache. */
export function setTokenBackend(next: TokenBackend): void {
  runSync(TokenStore.use((store) => store.setBackend(next)));
}

export async function loadToken(): Promise<TokenRecord | null> {
  return run(TokenStore.use((store) => store.load));
}

export async function saveToken(record: TokenRecord): Promise<void> {
  return run(TokenStore.use((store) => store.save(record)));
}

export async function clearToken(): Promise<void> {
  return run(TokenStore.use((store) => store.clear));
}
