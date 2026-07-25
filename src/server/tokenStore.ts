// Where the GitHub sign-in token lives (specs/git-operations.spec.md). The
// token is deliberately NOT part of settings.json — settings are shareable,
// the token never is. The default backend is a 0600 JSON file next to the
// home settings file; the desktop app swaps in an OS-encrypted backend
// (Electron safeStorage) via setTokenBackend before the server starts.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** The signed-in GitHub identity plus its token. */
export interface TokenRecord {
  token: string;
  login: string;
  name: string | null;
  email: string | null;
  id: number;
}

export interface TokenBackend {
  load(): Promise<TokenRecord | null>;
  save(record: TokenRecord): Promise<void>;
  clear(): Promise<void>;
}

export const TOKEN_FILE = "github-token.json";

/** The default token file: ~/.specdriven/github-token.json ($SPECDRIVEN_HOME). */
export function tokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), TOKEN_FILE);
}

function parseRecord(raw: string): TokenRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TokenRecord>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    if (typeof parsed.login !== "string" || !parsed.login) return null;
    return {
      token: parsed.token,
      login: parsed.login,
      name: typeof parsed.name === "string" ? parsed.name : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
      id: typeof parsed.id === "number" ? parsed.id : 0,
    };
  } catch {
    return null; // a corrupt token file means signed out, never a crash
  }
}

/**
 * File backend used by the web server and as the desktop fallback. The
 * path is resolved per call so a changed $SPECDRIVEN_HOME (tests, install
 * scripts) is honored without re-creating the backend.
 */
export function createFileBackend(fixedPath?: string): TokenBackend {
  const where = () => fixedPath ?? tokenPath();
  return {
    async load() {
      try {
        return parseRecord(await readFile(where(), "utf8"));
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

let backend: TokenBackend = createFileBackend();
let cached: TokenRecord | null | undefined; // undefined = not loaded yet

/** Swap the storage backend (Electron safeStorage); resets the cache. */
export function setTokenBackend(next: TokenBackend): void {
  backend = next;
  cached = undefined;
}

export async function loadToken(): Promise<TokenRecord | null> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

export async function saveToken(record: TokenRecord): Promise<void> {
  await backend.save(record);
  cached = record;
}

export async function clearToken(): Promise<void> {
  await backend.clear();
  cached = null;
}
