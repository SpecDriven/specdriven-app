// A plugin's secrets (src/server/secrets.ts, specs/agents/agent-plugins
// .feature.md): a named store of string fields in an owner-only file under
// the app's home, apart from the shareable settings; cached after the
// first read; a corrupt file reads as nothing; a store from before the
// module keeps its old file; the desktop swaps every store's backend at
// once through the factory.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSecretFileBackend,
  parseSecretRecord,
  secretPath,
  secretStore,
  setSecretBackend,
  setSecretBackendFactory,
  type SecretBackend,
  type SecretRecord,
} from "../src/server/secrets";

const realHome = process.env.SPECDRIVEN_HOME;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-secrets-"));
  process.env.SPECDRIVEN_HOME = home;
  setSecretBackendFactory(null);
});

afterEach(async () => {
  setSecretBackendFactory(null);
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

test("a store round-trips through an owner-only file under the app's home, and is cached", async () => {
  const store = secretStore("acme.api");
  expect(await store.load()).toBeNull();
  await store.save({ key: "k-1", org: "o" });
  expect(secretPath("acme.api")).toBe(join(home, "secrets", "acme.api.json"));
  expect((await stat(secretPath("acme.api"))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(secretPath("acme.api"), "utf8"))).toEqual({ key: "k-1", org: "o" });
  // The same store object every time; the cache answers until a change.
  expect(secretStore("acme.api")).toBe(store);
  await writeFile(secretPath("acme.api"), JSON.stringify({ key: "changed-on-disk" }));
  expect(await store.load()).toEqual({ key: "k-1", org: "o" });
  setSecretBackend("acme.api", null);
  expect(await store.load()).toEqual({ key: "changed-on-disk" });
  await store.clear();
  expect(await store.load()).toBeNull();
  await expect(stat(secretPath("acme.api"))).rejects.toThrow();
  expect(() => secretStore("../etc")).toThrow(/not a secret store name/);
});

test("a corrupt or empty file reads as no secret", async () => {
  expect(parseSecretRecord("{ not json")).toBeNull();
  expect(parseSecretRecord(JSON.stringify({ token: "" }))).toBeNull();
  expect(parseSecretRecord(JSON.stringify({ token: 7 }))).toBeNull();
  expect(parseSecretRecord("null")).toBeNull();
  expect(parseSecretRecord("[1]")).toBeNull();
  expect(parseSecretRecord(JSON.stringify({ token: "t", n: 1 }))).toEqual({ token: "t" });
  const backend = createSecretFileBackend("x", join(home, "x.json"));
  await writeFile(join(home, "x.json"), "{ not json");
  expect(await backend.load()).toBeNull();
});

test("the Claude token keeps its old file, through the store the Claude plugin owns", async () => {
  // The store the Claude agent plugin asks for (HostConfig.secrets("token"))
  // reads and writes the file the token had while Claude was built in.
  const file = join(home, "claude-token.json");
  expect(secretPath("agent-claude.token")).toBe(file);
  await secretStore("agent-claude.token").save({ token: "proxy-secret" });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: "proxy-secret" });
  expect(await secretStore("agent-claude.token").load()).toEqual({ token: "proxy-secret" });
});

test("the backend factory swaps every store, the ones handed out before included", async () => {
  const kept = new Map<string, SecretRecord>();
  const memory = (name: string): SecretBackend => ({
    load: async () => kept.get(name) ?? null,
    save: async (record) => {
      kept.set(name, record);
    },
    clear: async () => {
      kept.delete(name);
    },
  });
  const early = secretStore("acme.early");
  await early.save({ v: "file" });
  setSecretBackendFactory(memory);
  // The cache went with the backend: the file is no longer what answers.
  expect(await early.load()).toBeNull();
  await early.save({ v: "mem" });
  expect(kept.get("acme.early")).toEqual({ v: "mem" });
  expect(await secretStore("acme.late").load()).toBeNull();
  await secretStore("acme.late").save({ v: "late" });
  expect(kept.get("acme.late")).toEqual({ v: "late" });
  await expect(stat(secretPath("acme.late"))).rejects.toThrow();
  setSecretBackendFactory(null);
  expect(await early.load()).toEqual({ v: "file" });
});
