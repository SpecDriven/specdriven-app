// Credentials kept on this device, as Effect services: the GitHub sign-in
// (TokenStore) and the named secret stores plugins keep (SecretStores).
// Neither is part of settings.yaml — settings are shareable, a credential
// never is.
//
// Each store reads through a backend and remembers what it read. The default
// backend is a 0600 JSON file under the app's home; the desktop app swaps in
// an OS-encrypted one (Electron safeStorage) and a hosted worker a read-only
// one, both handed over as the Promise interfaces below. A backend that
// throws fails the program with a BackendError carrying what it threw.
//
// src/server/tokenStore.ts and src/server/secrets.ts are the Promise forms.

import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { homedir } from "node:os";
import { join } from "node:path";
import { GITHUB_HOST } from "../github";
import { STATE_DIR } from "../settingsModel";
import { BackendError, InvalidSecretName, type FileIoError } from "./errors";
import * as Files from "./Files";
import { HomePaths } from "./HomePaths";

// ── Records ────────────────────────────────────────────────────────────────

/** The signed-in GitHub identity plus its token. */
export interface TokenRecord {
  token: string;
  login: string;
  name: string | null;
  email: string | null;
  id: number;
  /**
   * The GitHub the token belongs to: github.com, or a GitHub Enterprise host
   * such as github.acme.com or acme.ghe.com. Git hands the token to that
   * host only. Absent means github.com — every record saved before GitHub
   * Enterprise, and the ones the hosted gateway builds.
   */
  host?: string;
}

/** How a credential store is kept, as the app is handed one. */
export interface CredentialBackend<R> {
  load(): Promise<R | null>;
  save(record: R): Promise<void>;
  clear(): Promise<void>;
}

export type TokenBackend = CredentialBackend<TokenRecord>;

export const TOKEN_FILE = "github-token.json";

/** The app's home as the process sees it now: $SPECDRIVEN_HOME, else ~/.specdriven. */
function processHome(): string {
  return process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR);
}

/** The default token file: ~/.specdriven/github-token.json ($SPECDRIVEN_HOME). */
export function tokenPath(): string {
  return join(processHome(), TOKEN_FILE);
}

/** A stored record, or null when it is not one; shared with the desktop backend. */
export function parseRecord(raw: string): TokenRecord | null {
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
      ...(typeof parsed.host === "string" && parsed.host && parsed.host !== GITHUB_HOST
        ? { host: parsed.host }
        : {}),
    };
  } catch {
    return null; // a corrupt token file means signed out, never a crash
  }
}

/** What a secret store holds: named string fields, all of them secret. */
export type SecretRecord = Record<string, string>;

export type SecretBackend = CredentialBackend<SecretRecord>;

export type SecretBackendFactory = (name: string) => SecretBackend;

/** A store name: one file name, no separators. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Stores from before this module kept their file beside the settings file
 * under a name of their own; they stay there, so nothing migrates.
 */
export const LEGACY_SECRET_FILES: Readonly<Record<string, string>> = {
  "agent-claude.token": "claude-token.json",
};

/** A store's file under an app home: `secrets/<name>.json`, or its legacy place. */
function secretPathIn(home: string, name: string): string {
  const legacy = LEGACY_SECRET_FILES[name];
  return legacy ? join(home, legacy) : join(home, "secrets", `${name}.json`);
}

/** Where a store's file lives: `~/.specdriven/secrets/<name>.json`, or its legacy place. */
export function secretPath(name: string): string {
  return secretPathIn(processHome(), name);
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

// ── The 0600 file ──────────────────────────────────────────────────────────

/** A credential kept as a JSON file only its owner can read. */
export interface CredentialFile<R> {
  /** The record at the path; a missing, unreadable or corrupt file is none. */
  readonly load: (path: string) => Effect.Effect<R | null, never, FileSystem>;
  readonly save: (path: string, record: R) => Files.FileEffect<void>;
  readonly clear: (path: string) => Files.FileEffect<void>;
}

const credentialFile = <R>(parse: (raw: string) => R | null): CredentialFile<R> => ({
  load: (path) =>
    Files.readTextStrict(path).pipe(
      Effect.map(parse),
      Effect.catch(() => Effect.succeed(null)),
    ),
  save: (path, record) =>
    Files.writeText(path, JSON.stringify(record, null, 2) + "\n").pipe(
      Effect.andThen(Files.chmod(path, 0o600)), // a credential — owner-only
    ),
  clear: (path) => Files.removeFile(path),
});

/** The GitHub token's file. */
export const tokenFile = credentialFile(parseRecord);

/** A secret store's file. */
export const secretFile = credentialFile(parseSecretRecord);

// ── A store: a backend and what it last read ───────────────────────────────

type CredentialError = FileIoError | BackendError;

/** A backend as the stores use it. */
interface Backend<R> {
  readonly load: Effect.Effect<R | null, CredentialError>;
  readonly save: (record: R) => Effect.Effect<void, CredentialError>;
  readonly clear: Effect.Effect<void, CredentialError>;
}

/** A backend the app was handed, with what it throws as a BackendError. */
const handed = <R>(backend: CredentialBackend<R>): Backend<R> => ({
  load: Effect.tryPromise({
    try: () => backend.load(),
    catch: (cause) => new BackendError({ op: "load", cause }),
  }),
  save: (record) =>
    Effect.tryPromise({
      try: () => backend.save(record),
      catch: (cause) => new BackendError({ op: "save", cause }),
    }),
  clear: Effect.tryPromise({
    try: () => backend.clear(),
    catch: (cause) => new BackendError({ op: "clear", cause }),
  }),
});

/** One credential: read once, then remembered until it is saved, cleared or its backend changes. */
export interface CredentialStore<R> {
  readonly load: Effect.Effect<R | null, CredentialError>;
  readonly save: (record: R) => Effect.Effect<void, CredentialError>;
  readonly clear: Effect.Effect<void, CredentialError>;
}

interface Slot<R> extends CredentialStore<R> {
  /** Swap the backend; what was remembered is forgotten. */
  readonly use: (backend: Backend<R>) => void;
}

function slot<R>(initial: Backend<R>): Slot<R> {
  let backend = initial;
  let cached: R | null | undefined; // undefined = not loaded yet
  return {
    load: Effect.suspend(() =>
      cached !== undefined
        ? Effect.succeed(cached)
        : Effect.map(backend.load, (record) => (cached = record)),
    ),
    save: (record) =>
      Effect.suspend(() => backend.save(record)).pipe(
        Effect.tap(() => Effect.sync(() => void (cached = record))),
      ),
    clear: Effect.suspend(() => backend.clear).pipe(Effect.tap(() => Effect.sync(() => void (cached = null)))),
    use(next) {
      backend = next;
      cached = undefined;
    },
  };
}

// ── The GitHub token ───────────────────────────────────────────────────────

export interface TokenStoreShape extends CredentialStore<TokenRecord> {
  /** Swap the storage backend (Electron safeStorage); resets what was remembered. */
  readonly setBackend: (next: TokenBackend) => Effect.Effect<void>;
}

/** Where the GitHub sign-in token lives (git-operations.md). */
export class TokenStore extends Context.Service<TokenStore, TokenStoreShape>()(
  "specdriven/persistence/TokenStore",
) {
  /** The token in its 0600 file under the app's home, until a backend is swapped in. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* Effect.service(FileSystem);
      const home = yield* Effect.service(HomePaths);
      const onFs = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Effect.Effect<A, E> =>
        Effect.provideService(effect, FileSystem, fs);
      // The path is resolved per use, so a changed app home is honored.
      const path = Effect.map(home.appHome, (dir) => join(dir, TOKEN_FILE));
      const store = slot<TokenRecord>({
        load: Effect.flatMap(path, (p) => onFs(tokenFile.load(p))),
        save: (record) => Effect.flatMap(path, (p) => onFs(tokenFile.save(p, record))),
        clear: Effect.flatMap(path, (p) => onFs(tokenFile.clear(p))),
      });
      return TokenStore.of({
        load: store.load,
        save: store.save,
        clear: store.clear,
        setBackend: (next) => Effect.sync(() => store.use(handed(next))),
      });
    }),
  );
}

// ── Plugin secrets ─────────────────────────────────────────────────────────

export interface SecretStoresShape {
  /** The store for a name; the same one every time. */
  readonly store: (name: string) => Effect.Effect<CredentialStore<SecretRecord>, InvalidSecretName>;
  /**
   * Swap how every store is kept (Electron safeStorage); null restores the
   * files. Stores already handed out pick the new backend up and forget what
   * they remembered.
   */
  readonly setFactory: (next: SecretBackendFactory | null) => Effect.Effect<void>;
  /** Swap one store's backend (a test's fixed file); null restores the factory's. */
  readonly setBackend: (name: string, backend: SecretBackend | null) => Effect.Effect<void>;
}

/**
 * Secrets a plugin keeps on this device (specs/agents/agent-plugins
 * .feature.md): a named store of string fields — a proxy token, an API key.
 */
export class SecretStores extends Context.Service<SecretStores, SecretStoresShape>()(
  "specdriven/persistence/SecretStores",
) {
  /** Each store in its 0600 file under the app's home, until a factory or backend is swapped in. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* Effect.service(FileSystem);
      const home = yield* Effect.service(HomePaths);
      const onFs = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Effect.Effect<A, E> =>
        Effect.provideService(effect, FileSystem, fs);

      const inFile = (name: string): Backend<SecretRecord> => {
        const path = Effect.map(home.appHome, (dir) => secretPathIn(dir, name));
        return {
          load: Effect.flatMap(path, (p) => onFs(secretFile.load(p))),
          save: (record) => Effect.flatMap(path, (p) => onFs(secretFile.save(p, record))),
          clear: Effect.flatMap(path, (p) => onFs(secretFile.clear(p))),
        };
      };

      let factory: (name: string) => Backend<SecretRecord> = inFile;
      const stores = new Map<string, Slot<SecretRecord>>();

      return SecretStores.of({
        store: (name) =>
          Effect.suspend(() => {
            if (!SECRET_NAME_PATTERN.test(name)) return Effect.fail(new InvalidSecretName({ storeName: name }));
            let entry = stores.get(name);
            if (!entry) {
              entry = slot(factory(name));
              stores.set(name, entry);
            }
            return Effect.succeed<CredentialStore<SecretRecord>>(entry);
          }),
        setFactory: (next) =>
          Effect.sync(() => {
            factory = next ? (name) => handed(next(name)) : inFile;
            for (const [name, entry] of stores) entry.use(factory(name));
          }),
        setBackend: (name, backend) =>
          Effect.sync(() => {
            const next = backend ? handed(backend) : factory(name);
            const entry = stores.get(name);
            if (entry) entry.use(next);
            else stores.set(name, slot(next));
          }),
      });
    }),
  );
}
