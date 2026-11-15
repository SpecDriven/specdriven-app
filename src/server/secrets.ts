// Secrets a plugin keeps on this device (specs/agents/agent-plugins
// .feature.md): a named store of string fields — a proxy token, an API
// key — that is deliberately NOT part of settings.yaml, which is shareable
// where a credential never is. Like the GitHub token (src/server/
// tokenStore.ts), the default backend is a 0600 JSON file under the app's
// home; the desktop app swaps in an OS-encrypted backend (Electron
// safeStorage) through setSecretBackendFactory before the server starts.
// Node APIs only: this runs under Electron too.
//
// The stores themselves are the SecretStores service
// (src/server/persistence/Credentials.ts), which also owns the record's
// shape and parser; the functions here are its Promise forms.

import { secretFile, secretPath, SecretStores } from "./persistence/Credentials";
import type {
  CredentialStore,
  SecretBackend,
  SecretBackendFactory,
  SecretRecord,
} from "./persistence/Credentials";
import { run, runSync } from "./persistence/runtime";

export {
  LEGACY_SECRET_FILES,
  parseSecretRecord,
  SECRET_NAME_PATTERN,
  secretPath,
} from "./persistence/Credentials";
export type { SecretBackend, SecretBackendFactory, SecretRecord } from "./persistence/Credentials";

/** A store a plugin reads and writes; the record is cached after the first read. */
export interface SecretStore {
  load(): Promise<SecretRecord | null>;
  save(record: SecretRecord): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The file backend: the web server's, and the desktop's fallback. The path
 * is resolved per call so a changed $SPECDRIVEN_HOME (tests) is honored.
 */
export function createSecretFileBackend(name: string, fixedPath?: string): SecretBackend {
  const where = () => fixedPath ?? secretPath(name);
  return {
    load: () => run(secretFile.load(where())),
    save: (record) => run(secretFile.save(where(), record)),
    clear: () => run(secretFile.clear(where())),
  };
}

/**
 * Swap how every store is kept (Electron safeStorage); null restores the
 * files. Stores already handed out pick the new backend up and forget
 * their cache.
 */
export function setSecretBackendFactory(next: SecretBackendFactory | null): void {
  runSync(SecretStores.use((stores) => stores.setFactory(next)));
}

/** Swap one store's backend (a test's fixed file); resets its cache. */
export function setSecretBackend(name: string, backend: SecretBackend | null): void {
  runSync(SecretStores.use((stores) => stores.setBackend(name, backend)));
}

// One Promise-facing object per store, so a name gives the same object every time.
const handedOut = new WeakMap<CredentialStore<SecretRecord>, SecretStore>();

/** The store for a name; the same object every time. */
export function secretStore(name: string): SecretStore {
  const store = runSync(SecretStores.use((stores) => stores.store(name)));
  let facade = handedOut.get(store);
  if (!facade) {
    facade = {
      load: () => run(store.load),
      save: (record) => run(store.save(record)),
      clear: () => run(store.clear),
    };
    handedOut.set(store, facade);
  }
  return facade;
}
