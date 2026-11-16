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
import { IDENTITY_ENV, tokenSocket } from "./hostedToken";

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
 * Hosted backend (src/server/hostedMode.ts): the gateway hands its worker
 * the person's GitHub sign-in in the environment, one of two ways.
 *
 * Where the service has a GitHub App (docs/hosted-tenant-isolation.md "Step
 * 3") it is who the person is on GitHub and where to ask for tokens: the
 * record says `brokered` and holds no token. Otherwise it is the personal
 * access token from the account page, in TOKEN_ENV as a TokenRecord.
 *
 * Nothing is written to disk either way, and the worker cannot change the
 * sign-in — the account page does that, and restarts the worker.
 */
export function createEnvBackend(env: Record<string, string | undefined> = process.env): TokenBackend {
  const refuse = async () => {
    throw new Error("GitHub is managed on the account page");
  };
  return {
    async load() {
      const raw = env[TOKEN_ENV];
      if (raw) return parseRecord(raw);
      return tokenSocket(env) ? brokeredRecord(env[IDENTITY_ENV]) : null;
    },
    save: refuse,
    clear: refuse,
  };
}

/** The person's GitHub account as the gateway names it, with no token; null when it names none. */
function brokeredRecord(raw: string | undefined): TokenRecord | null {
  try {
    const who = JSON.parse(raw ?? "") as Partial<TokenRecord> | null;
    if (!who || typeof who.login !== "string" || !who.login) return null;
    return {
      token: "",
      login: who.login,
      name: typeof who.name === "string" ? who.name : null,
      email: typeof who.email === "string" ? who.email : null,
      id: typeof who.id === "number" ? who.id : 0,
      brokered: true,
    };
  } catch {
    return null;
  }
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
