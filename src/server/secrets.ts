// Secrets a plugin keeps on this device (specs/agents/agent-plugins
// .feature.md): a named store of string fields — a proxy token, an API
// key — that is deliberately NOT part of settings.yaml, which is shareable
// where a credential never is. Like the GitHub token (src/server/
// tokenStore.ts), the default backend is a 0600 JSON file under the app's
// home; the desktop app swaps in an OS-encrypted backend (Electron
// safeStorage) through setSecretBackendFactory before the server starts.
// Node APIs only: this runs under Electron too.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** What a store holds: named string fields, all of them secret. */
export type SecretRecord = Record<string, string>;

export interface SecretBackend {
  load(): Promise<SecretRecord | null>;
  save(record: SecretRecord): Promise<void>;
  clear(): Promise<void>;
}

/** A store a plugin reads and writes; the record is cached after the first read. */
export interface SecretStore {
  load(): Promise<SecretRecord | null>;
  save(record: SecretRecord): Promise<void>;
  clear(): Promise<void>;
}

/** A store name: one file name, no separators. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Stores from before this module kept their file beside the settings file
 * under a name of their own; they stay there, so nothing migrates.
 */
export const LEGACY_SECRET_FILES: Readonly<Record<string, string>> = {
  "agent-claude.token": "claude-token.json",
};

/** The app's home: ~/.specdriven, or $SPECDRIVEN_HOME. */
function home(): string {
  return process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR);
}

/** Where a store's file lives: `~/.specdriven/secrets/<name>.json`, or its legacy place. */
export function secretPath(name: string): string {
  const legacy = LEGACY_SECRET_FILES[name];
  return legacy ? join(home(), legacy) : join(home(), "secrets", `${name}.json`);
}

/** A stored record, or null when the text is not one: an object of strings, at least one non-empty. */
export function parseSecretRecord(raw: string): SecretRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record: SecretRecord = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) record[key] = value;
    }
    return Object.keys(record).length > 0 ? record : null;
  } catch {
    return null; // a corrupt file means no secret, never a crash
  }
}

/**
 * The file backend: the web server's, and the desktop's fallback. The path
 * is resolved per call so a changed $SPECDRIVEN_HOME (tests) is honored.
 */
export function createSecretFileBackend(name: string, fixedPath?: string): SecretBackend {
  const where = () => fixedPath ?? secretPath(name);
  return {
    async load() {
      try {
        return parseSecretRecord(await readFile(where(), "utf8"));
      } catch {
        return null;
      }
    },
    async save(record) {
      const path = where();
      await writeTextFile(path, JSON.stringify(record, null, 2) + "\n");
      await chmod(path, 0o600); // a credential — owner-only
    },
    async clear() {
      await rm(where(), { force: true });
    },
  };
}

export type SecretBackendFactory = (name: string) => SecretBackend;

let factory: SecretBackendFactory = (name) => createSecretFileBackend(name);
const stores = new Map<string, { backend: SecretBackend; cached: SecretRecord | null | undefined; store?: SecretStore }>();

/**
 * Swap how every store is kept (Electron safeStorage); null restores the
 * files. Stores already handed out pick the new backend up and forget
 * their cache.
 */
export function setSecretBackendFactory(next: SecretBackendFactory | null): void {
  factory = next ?? ((name) => createSecretFileBackend(name));
  for (const [name, entry] of stores) {
    entry.backend = factory(name);
    entry.cached = undefined;
  }
}

/** Swap one store's backend (a test's fixed file); resets its cache. */
export function setSecretBackend(name: string, backend: SecretBackend | null): void {
  const entry = stores.get(name);
  const next = backend ?? factory(name);
  if (entry) {
    entry.backend = next;
    entry.cached = undefined;
  } else {
    stores.set(name, { backend: next, cached: undefined });
  }
}

/** The store for a name; the same object every time. */
export function secretStore(name: string): SecretStore {
  if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a secret store name`);
  let entry = stores.get(name);
  if (!entry) {
    entry = { backend: factory(name), cached: undefined };
    stores.set(name, entry);
  }
  const e = entry;
  if (e.store) return e.store;
  e.store = {
    async load() {
      if (e.cached === undefined) e.cached = await e.backend.load();
      return e.cached;
    },
    async save(record) {
      await e.backend.save(record);
      e.cached = record;
    },
    async clear() {
      await e.backend.clear();
      e.cached = null;
    },
  };
  return e.store;
}
