// The tokens kept per site as an Effect service
// (src/server/persistence/Credentials.ts SiteTokens), run with fixed home
// paths: one store per kind of site — Jira, Confluence, Aha!, qTest — each a
// list of records in one owner-only file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteTokens } from "../../src/server/persistence/Credentials";
import {
  AHA_TOKENS,
  CONFLUENCE_TOKENS,
  JIRA_TOKENS,
  QTEST_TOKENS,
  parseSiteRecords,
  type SiteTokenBackend,
  type SiteTokenRecord,
} from "../../src/server/siteTokenModel";
import { errorOf, exitOf, valueOf } from "../helpers/persistence";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-site-tokens-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const ACME: SiteTokenRecord = { base: "https://jira.acme.test", token: "acme-token", user: "Ada" };
const OTHER: SiteTokenRecord = { base: "https://jira.other.test", token: "other-token", user: "Grace" };

const run = <A, E>(effect: Effect.Effect<A, E, SiteTokens>) => exitOf(effect, { appHome: home });

const stored = async (file: string) => JSON.parse(await readFile(join(home, file), "utf8")) as SiteTokenRecord[];

/** Give other work a turn, the way a backend that reads a file or asks the keychain does. */
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A backend in memory that takes a moment over every call, and `firstLoadMs` over its first read. */
function slowBackend(initial: SiteTokenRecord[] = [], firstLoadMs = 5) {
  let kept = initial;
  const calls = { load: 0, save: 0, clear: 0 };
  const backend: SiteTokenBackend = {
    async load() {
      const seen = kept;
      await pause(++calls.load === 1 ? firstLoadMs : 5);
      return seen;
    },
    async save(records) {
      calls.save++;
      await pause();
      kept = records;
    },
    async clear() {
      calls.clear++;
      await pause();
      kept = [];
    },
  };
  return { backend, calls, kept: () => kept };
}

describe("SiteTokens service", () => {
  test("a token lands in the kind's owner-only file under the app home and is found by its site", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const jira = (yield* Effect.service(SiteTokens)).store(JIRA_TOKENS);
        yield* jira.save(ACME);
        // The kind's own rule tells sites apart: a trailing slash is the same Jira.
        return { found: yield* jira.find("https://jira.acme.test/"), missing: yield* jira.find(OTHER.base) };
      }),
    );
    expect(valueOf(exit)).toEqual({ found: ACME, missing: null });
    expect(await stored("jira-tokens.json")).toEqual([ACME]);
    if (process.platform !== "win32") {
      expect((await stat(join(home, "jira-tokens.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("a second token for a site replaces the first and leaves the other sites alone", async () => {
    const renewed = { ...ACME, token: "renewed", user: "Ada L." };
    const exit = await run(
      Effect.gen(function* () {
        const jira = (yield* Effect.service(SiteTokens)).store(JIRA_TOKENS);
        yield* jira.save(ACME);
        yield* jira.save(OTHER);
        return yield* jira.save(renewed);
      }),
    );
    expect(valueOf(exit)).toEqual([OTHER, renewed]);
    expect(await stored("jira-tokens.json")).toEqual([OTHER, renewed]);
  });

  test("forgetting a site keeps the rest, and forgetting the last one removes the file", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const jira = (yield* Effect.service(SiteTokens)).store(JIRA_TOKENS);
        yield* jira.save(ACME);
        yield* jira.save(OTHER);
        const afterOne = yield* jira.clear(ACME.base);
        const onDisk = yield* Effect.promise(() => stored("jira-tokens.json"));
        const afterBoth = yield* jira.clear(OTHER.base);
        return { afterOne, onDisk, afterBoth, all: yield* jira.all };
      }),
    );
    expect(valueOf(exit)).toEqual({ afterOne: [OTHER], onDisk: [OTHER], afterBoth: [], all: [] });
    expect(await Bun.file(join(home, "jira-tokens.json")).exists()).toBe(false);
  });

  test("each kind keeps its own file, and a kind gives the same store every time", async () => {
    const kinds = [JIRA_TOKENS, CONFLUENCE_TOKENS, AHA_TOKENS, QTEST_TOKENS];
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        for (const kind of kinds) {
          yield* sites.store(kind).save({ base: `https://${kind.name}.acme.test`, token: kind.name, user: "" });
        }
        return {
          same: sites.store(JIRA_TOKENS) === sites.store(JIRA_TOKENS),
          jira: yield* sites.store(JIRA_TOKENS).all,
        };
      }),
    );
    expect(valueOf(exit)).toEqual({
      same: true,
      jira: [{ base: "https://jira.acme.test", token: "jira", user: "" }],
    });
    for (const kind of kinds) {
      expect((await stored(kind.file)).map((r) => r.token)).toEqual([kind.name]);
    }
  });

  test("a corrupt or half-valid file never fails, and what is not a record is dropped", async () => {
    await writeFile(join(home, "jira-tokens.json"), "{ not json");
    await writeFile(
      join(home, "aha-tokens.json"),
      JSON.stringify([ACME, null, { base: "https://no-token.test" }, { base: "https://x.test", token: "t" }]),
    );
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        return { jira: yield* sites.store(JIRA_TOKENS).all, aha: yield* sites.store(AHA_TOKENS).all };
      }),
    );
    expect(valueOf(exit)).toEqual({ jira: [], aha: [ACME, { base: "https://x.test", token: "t", user: "" }] });
    expect(parseSiteRecords(JSON.stringify({ base: "not a list" }))).toBe(null);
  });

  test("the records are read once and remembered", async () => {
    const { backend, calls } = slowBackend([ACME]);
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        yield* sites.setBackend(JIRA_TOKENS, backend);
        const jira = sites.store(JIRA_TOKENS);
        yield* jira.all;
        yield* jira.find(ACME.base);
        yield* jira.save(OTHER);
        return yield* jira.all;
      }),
    );
    expect(valueOf(exit)).toEqual([ACME, OTHER]);
    expect(calls).toEqual({ load: 1, save: 1, clear: 0 });
  });

  test("two tokens saved at the same moment are both kept", async () => {
    const { backend, kept } = slowBackend();
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        yield* sites.setBackend(JIRA_TOKENS, backend);
        const jira = sites.store(JIRA_TOKENS);
        yield* Effect.all([jira.save(ACME), jira.save(OTHER)], { concurrency: "unbounded" });
        return yield* jira.all;
      }),
    );
    expect(valueOf(exit)).toEqual([ACME, OTHER]);
    expect(kept()).toEqual([ACME, OTHER]);
  });

  test("a read that started before a save does not bring the old list back", async () => {
    // The first read is still out when a save could have come and gone.
    const { backend } = slowBackend([], 60);
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        yield* sites.setBackend(JIRA_TOKENS, backend);
        const jira = sites.store(JIRA_TOKENS);
        yield* Effect.all([jira.all, jira.save(ACME)], { concurrency: "unbounded" });
        return yield* jira.find(ACME.base);
      }),
    );
    expect(valueOf(exit)).toEqual(ACME);
  });

  test("a swapped-in backend is used at once, what it throws is a BackendError carrying it, and null restores the file", async () => {
    const refusal = new Error("keychain is locked");
    const locked: SiteTokenBackend = {
      load: async () => [OTHER],
      save: async () => {
        throw refusal;
      },
      clear: async () => {},
    };
    const exit = await run(
      Effect.gen(function* () {
        const sites = yield* Effect.service(SiteTokens);
        const jira = sites.store(JIRA_TOKENS);
        yield* jira.save(ACME); // in the file, and remembered
        yield* sites.setBackend(JIRA_TOKENS, locked);
        const swapped = yield* jira.all; // the swap forgot the file's list
        const failed = yield* Effect.flip(jira.save(ACME));
        const unchanged = yield* jira.all; // a failed save changes nothing
        yield* sites.setBackend(JIRA_TOKENS, null);
        return { swapped, failed, unchanged, restored: yield* jira.all };
      }),
    );
    const { swapped, failed, unchanged, restored } = valueOf(exit);
    expect(swapped).toEqual([OTHER]);
    expect(failed._tag).toBe("BackendError");
    expect(failed._tag === "BackendError" && failed.cause).toBe(refusal);
    expect(unchanged).toEqual([OTHER]);
    expect(restored).toEqual([ACME]);
    expect(errorOf(exit)).toBe(null);
  });
});
