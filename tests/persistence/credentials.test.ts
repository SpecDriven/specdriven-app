// The credential stores as Effect services
// (src/server/persistence/Credentials.ts): the GitHub token and the plugins'
// named secrets, run with fixed home paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretStores,
  TokenStore,
  type TokenBackend,
  type TokenRecord,
} from "../../src/server/persistence/Credentials";
import { secretStore, setSecretBackend } from "../../src/server/secrets";
import { errorOf, exitOf, valueOf } from "../helpers/persistence";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-credentials-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const RECORD: TokenRecord = { token: "test-token", login: "octo", name: "Octo", email: null, id: 7 };

const run = <A, E>(effect: Effect.Effect<A, E, TokenStore | SecretStores>) => exitOf(effect, { appHome: home });

describe("TokenStore service", () => {
  test("a save lands in an owner-only file under the app home and loads back", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const tokens = yield* Effect.service(TokenStore);
        yield* tokens.save(RECORD);
        return yield* tokens.load;
      }),
    );
    expect(valueOf(exit)).toEqual(RECORD);
    const path = join(home, "github-token.json");
    expect(JSON.parse(await readFile(path, "utf8")).login).toBe("octo");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a corrupt token file means signed out, never a failure", async () => {
    await writeFile(join(home, "github-token.json"), "{ not json");
    expect(valueOf(await run(TokenStore.use((tokens) => tokens.load)))).toBe(null);
  });

  test("the record is read once and remembered until it is cleared", async () => {
    await writeFile(join(home, "github-token.json"), JSON.stringify(RECORD));
    const exit = await run(
      Effect.gen(function* () {
        const tokens = yield* Effect.service(TokenStore);
        const first = yield* tokens.load;
        yield* Effect.promise(() => rm(join(home, "github-token.json")));
        const remembered = yield* tokens.load;
        yield* tokens.clear;
        return { first, remembered, cleared: yield* tokens.load };
      }),
    );
    const { first, remembered, cleared } = valueOf(exit);
    expect(first).toEqual(RECORD);
    expect(remembered).toEqual(RECORD);
    expect(cleared).toBe(null);
  });

  test("a swapped-in backend is used at once, and what it throws is a BackendError carrying it", async () => {
    const refusal = new Error("The GitHub token is managed on the account page");
    const readOnly: TokenBackend = {
      load: async () => RECORD,
      save: async () => {
        throw refusal;
      },
      clear: async () => {},
    };
    const exit = await run(
      Effect.gen(function* () {
        const tokens = yield* Effect.service(TokenStore);
        expect(yield* tokens.load).toBe(null); // the empty file backend, now remembered
        yield* tokens.setBackend(readOnly);
        expect(yield* tokens.load).toEqual(RECORD); // the swap forgot it
        yield* tokens.save({ ...RECORD, login: "other" });
      }),
    );
    const error = errorOf(exit);
    expect(error?._tag).toBe("BackendError");
    expect(error?._tag === "BackendError" && error.cause).toBe(refusal);
  });
});

describe("SecretStores service", () => {
  test("a store keeps its record in secrets/<name>.json, and a name gives the same store every time", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const secrets = yield* Effect.service(SecretStores);
        const store = yield* secrets.store("agent-test.token");
        yield* store.save({ token: "abc" });
        return { same: (yield* secrets.store("agent-test.token")) === store, record: yield* store.load };
      }),
    );
    expect(valueOf(exit)).toEqual({ same: true, record: { token: "abc" } });
    const path = join(home, "secrets/agent-test.token.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "abc" });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a legacy store stays in its old file beside the settings", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "claude-token.json"), JSON.stringify({ token: "old" }));
    const exit = await run(
      Effect.flatMap(
        SecretStores.use((secrets) => secrets.store("agent-claude.token")),
        (store) => store.load,
      ),
    );
    expect(valueOf(exit)).toEqual({ token: "old" });
  });

  test("a name that is not one file name fails as InvalidSecretName", async () => {
    for (const name of ["../escape", "a/b", "", ".hidden"]) {
      const exit = await run(SecretStores.use((secrets) => secrets.store(name)));
      expect(errorOf(exit)?._tag).toBe("InvalidSecretName");
    }
  });

  test("a new factory reaches stores already handed out, and null restores the files", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const secrets = yield* Effect.service(SecretStores);
        const store = yield* secrets.store("agent-test.token");
        yield* store.save({ token: "in-file" });
        yield* secrets.setFactory(() => ({
          load: async () => ({ token: "from-keychain" }),
          save: async () => {},
          clear: async () => {},
        }));
        const swapped = yield* store.load;
        yield* secrets.setFactory(null);
        return { swapped, restored: yield* store.load };
      }),
    );
    expect(valueOf(exit)).toEqual({ swapped: { token: "from-keychain" }, restored: { token: "in-file" } });
  });
});

describe("secrets Promise functions", () => {
  test("an invalid name throws a plain error at once, and a store is the same object every time", () => {
    expect(() => secretStore("../escape")).toThrow('"../escape" is not a secret store name');
    expect(secretStore("agent-identity.token")).toBe(secretStore("agent-identity.token"));
  });

  test("a failing backend rejects with the error it threw", async () => {
    const refusal = new Error("keychain locked");
    setSecretBackend("agent-failing.token", {
      load: async () => {
        throw refusal;
      },
      save: async () => {},
      clear: async () => {},
    });
    try {
      const error = await secretStore("agent-failing.token")
        .load()
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBe(refusal);
    } finally {
      setSecretBackend("agent-failing.token", null);
    }
  });
});
