// Secrets at rest in the hosted gateway (src/gateway/crypto.ts,
// src/gateway/secrets.ts): AES-256-GCM under the master key, bound to their
// owner and name, unreadable after tampering, and re-sealed under a new key
// when the old one is retired.

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, hashToken, loadKeyring, open, seal, secretAad } from "../src/gateway/crypto";
import { openDatabase } from "../src/gateway/db";
import { SecretStore } from "../src/gateway/secrets";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function addUsers(db: ReturnType<typeof openDatabase>) {
  for (const [id, email] of [
    [USER, "a@example.com"],
    [OTHER, "b@example.com"],
  ] as const) {
    db.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, 0)").run(id, email);
  }
}

test("a sealed secret opens with the same key and associated data", async () => {
  const keyring = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const sealed = await seal(keyring, "ghp_secret", secretAad(USER, "github"));
  expect(Buffer.from(sealed.ciphertext).toString()).not.toContain("ghp_secret");
  expect(await open(keyring, sealed, secretAad(USER, "github"))).toBe("ghp_secret");
});

test("a ciphertext moved to another user or name, or altered, does not open", async () => {
  const keyring = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const sealed = await seal(keyring, "ghp_secret", secretAad(USER, "github"));
  await expect(open(keyring, sealed, secretAad(OTHER, "github"))).rejects.toThrow();
  await expect(open(keyring, sealed, secretAad(USER, "openai"))).rejects.toThrow();
  const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice() };
  tampered.ciphertext[0]! ^= 1;
  await expect(open(keyring, tampered, secretAad(USER, "github"))).rejects.toThrow();
});

test("a different master key cannot open the secret", async () => {
  const one = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const two = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const sealed = await seal(one, "x", secretAad(USER, "k"));
  await expect(open(two, sealed, secretAad(USER, "k"))).rejects.toThrow(/No master key/);
});

test("a master key must be 32 bytes, and production requires one", async () => {
  await expect(loadKeyring({ SPECDRIVEN_MASTER_KEY: "c2hvcnQ=" })).rejects.toThrow(/32 bytes/);
  await expect(loadKeyring({}, true)).rejects.toThrow(/required/);
});

test("the store keeps ciphertext only and lists hints, never values", async () => {
  const db = openDatabase(":memory:");
  addUsers(db);
  const store = new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() }));
  await store.put(USER, "github", "github", "ghp_abcdef1234", { login: "octo", name: "Octo", email: "o@x", id: 7 });
  await store.put(OTHER, "github", "github", "ghp_other0000", { login: "other" });

  const raw = db.query("SELECT ciphertext FROM secrets").all() as { ciphertext: Uint8Array }[];
  for (const row of raw) expect(Buffer.from(row.ciphertext).toString("latin1")).not.toMatch(/ghp_/);

  const listed = await store.list(USER);
  expect(listed.map((s) => [s.name, s.hint])).toEqual([["github", "1234"]]);
  expect(JSON.stringify(listed)).not.toContain("ghp_abcdef1234");

  const values = await store.values(USER);
  expect(values.github).toEqual({ token: "ghp_abcdef1234", login: "octo", name: "Octo", email: "o@x", id: 7 });
  expect((await store.values(OTHER)).github?.token).toBe("ghp_other0000");

  expect(store.delete(USER, "github")).toBe(true);
  expect(store.delete(USER, "github")).toBe(false);
  expect((await store.values(USER)).github).toBeNull();
});

test("rotating the master key re-seals old rows, which then need only the new key", async () => {
  const db = openDatabase(":memory:");
  addUsers(db);
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();
  await new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: oldKey })).put(USER, "github", "github", "v1");

  const rotated = new SecretStore(
    db,
    await loadKeyring({ SPECDRIVEN_MASTER_KEY: newKey, SPECDRIVEN_MASTER_KEYS_PREVIOUS: oldKey }),
  );
  expect(await rotated.reseal()).toBe(1);
  expect(await rotated.reseal()).toBe(0);

  const newOnly = new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: newKey }));
  expect((await newOnly.values(USER)).github?.token).toBe("v1");
});

test("agent API keys saved before are deleted when the database is migrated, and the GitHub token stays", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "sd-secrets-")), "gateway.db");
  const keyring = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const db = openDatabase(path);
  addUsers(db);
  const store = new SecretStore(db, keyring);
  await store.put(USER, "github", "github", "ghp_abcdef1234", { login: "octo" });
  // A key from before, as the account page used to save it.
  db.query(
    "INSERT INTO secrets (user_id, name, kind, ciphertext, iv, key_id, meta, updated_at) VALUES (?, 'anthropic', 'agent_key', x'00', x'00', 'k', '{}', 0)",
  ).run(USER);
  db.exec("PRAGMA user_version = 5");
  db.close();

  const again = openDatabase(path);
  expect(again.query("SELECT name, kind FROM secrets").all()).toEqual([{ name: "github", kind: "github" }]);
  expect((await new SecretStore(again, keyring).values(USER)).github?.token).toBe("ghp_abcdef1234");
  again.close();
});

test("tokens are stored as SHA-256 hex", () => {
  expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
