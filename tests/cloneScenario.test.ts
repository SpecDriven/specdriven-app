// Automates specs/ui/navigation.feature.md "clone a scenario": the
// scenario menus' Clone puts a draft copy right after the scenario — its
// spec text, not what ties the original to tests, tickets and pull requests.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  cloneName,
  cloneScenario,
  publishFeature,
  readFeature,
  readFeatureView,
  saveFeature,
  savePullRequests,
} from "../src/server/features";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

const QUOTE = "specs/quote.feature.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-clone-scenario-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-clone-scenario-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote");
  await saveFeature(
    data,
    QUOTE,
    "# Quote\n\n## Basic @v1\n\nbody\n\n" +
      "## Extra @v1\n\n[negative]\n\n[ff:beta:on]\n\n" +
      "[Jira:Q-1](https://acme.atlassian.net/browse/Q-1)\n\n- Given: more\n\n" +
      "[test: extra works : https://github.com/a/b/blob/main/t.test.ts#L3 ]\n\n" +
      "## Last @v1\n\nend\n",
  );
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const names = async () =>
  (await readFeatureView(data, QUOTE))!.parsed.scenarios.map((s) => `${s.name} v${s.version} ${s.status}`);

const scenario = async (name: string) =>
  (await readFeatureView(data, QUOTE))!.parsed.scenarios.find((s) => s.name === name)!;

test("the copy is a draft named '<name> (clone)' at v1, right after the original", async () => {
  const result = await cloneScenario(data, QUOTE, { name: "Basic", version: 1 });
  expect(result.clone).toEqual({ name: "Basic (clone)", version: 1 });
  expect(await names()).toEqual([
    "Basic v1 proposed",
    "Basic (clone) v1 draft",
    "Extra v1 proposed",
    "Last v1 proposed",
  ]);
  expect((await scenario("Basic (clone)")).body).toContain("body");
  // A draft lives in the document, not the file, until it is saved for real.
  expect(await readFeature(data, QUOTE)).not.toContain("(clone)");
  // The answer is the editor's view, the copy in it.
  expect(result.parsed.scenarios.map((s) => s.name)).toContain("Basic (clone)");
});

test("the copy carries the spec text, flags and polarity, not the tests, ticket or pull requests", async () => {
  await savePullRequests(data, QUOTE, { name: "Extra", version: 1 }, [
    { url: "https://github.com/a/b/pull/7", title: "Extra" },
  ]);
  await cloneScenario(data, QUOTE, { name: "Extra", version: 1 });
  const copy = await scenario("Extra (clone)");
  expect(copy.body).toContain("- Given: more");
  expect(copy.flags).toEqual([{ name: "beta", on: true }]);
  expect(copy.negative).toBe(true);
  expect(copy.tests).toEqual([]);
  expect(copy.link).toBeUndefined();
  expect(copy.prs ?? []).toEqual([]);
  // The original keeps all of it, and its own id.
  const original = await scenario("Extra");
  expect(original.tests).toHaveLength(1);
  expect(original.link?.ticket).toBe("Q-1");
  expect(original.prs).toHaveLength(1);
  expect(copy.id).not.toBe(original.id);
});

test("a second copy takes the next free name", async () => {
  await cloneScenario(data, QUOTE, { name: "Basic", version: 1 });
  const again = await cloneScenario(data, QUOTE, { name: "Basic", version: 1 });
  expect(again.clone.name).toBe("Basic (clone 2)");
  expect(cloneName("A", ["A", "A (clone)", "A (clone 2)"])).toBe("A (clone 3)");
  expect(cloneName("A", ["A"])).toBe("A (clone)");
});

test("a published scenario can be cloned, and stays as it was", async () => {
  await publishFeature(data, QUOTE, (await readFeature(data, QUOTE))!, { name: "Last", version: 1 });
  await cloneScenario(data, QUOTE, { name: "Last", version: 1 });
  expect(await names()).toEqual([
    "Basic v1 proposed",
    "Extra v1 proposed",
    "Last v1 published",
    "Last (clone) v1 draft",
  ]);
});

test("the route clones by name and version, and refuses what is not there", async () => {
  await writeState({ dataRepo: data }, root);
  const post = async (body: unknown) =>
    (await handleApi(
      new Request(`http://localhost/api/features/${encodeURIComponent(QUOTE)}/clone-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ))!;
  const ok = await post({ scenario: { name: "Basic", version: 1 } });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { clone: unknown }).clone).toEqual({ name: "Basic (clone)", version: 1 });
  const missing = await post({ scenario: { name: "Nope", version: 1 } });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toContain("not found");
  expect((await post({})).status).toBe(400);
});
