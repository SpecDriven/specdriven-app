// Automates specs/ui/navigation.feature.md "drag a scenario to another
// feature": a scenario dragged out of one feature — a card of its page or a
// row of its outline — and dropped on another feature's sidebar row lands
// last there; dropped on a row of that feature's outline, or on one of its
// cards, it lands just before or just after it. The move itself is Move to…'s
// (moveScenario.test.ts), on the same terms.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { createFeature, moveScenario, readFeature, readFeatureView, saveFeature } from "../src/server/features";
import { writeState } from "../src/server/state";
import { scenarioMovesInto, scenarioPlace } from "../src/frontend/tree";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

const QUOTE = "specs/quote.feature.md";
const ORDER = "specs/order.feature.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-drag-scenario-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-drag-scenario-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote");
  await createFeature(data, "Order");
  await saveFeature(data, QUOTE, "# Quote\n\n## Basic @v1\n\nbody\n\n## Extra @v1\n\nmore\n\n## Idea @v1 [draft]\n\nwip\n");
  await saveFeature(data, ORDER, "# Order\n\n## Checkout @v1\n\npay\n\n## Refund @v1\n\nback\n");
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

const names = async (file: string) => (await readFeatureView(data, file))!.parsed.scenarios.map((s) => s.name);

test("a scenario dropped on the upper half of a row in another feature's outline lands just before it", async () => {
  await moveScenario(data, QUOTE, { name: "Extra", version: 1 }, ORDER, { name: "Refund", version: 1, after: false });
  expect(await names(ORDER)).toEqual(["Checkout", "Extra", "Refund"]);
  // Numbered by its new place (parser.ts `S<n>:`).
  expect(await readFeature(data, ORDER)).toContain("## S2: Extra @v1 [proposed]");
  expect(await names(QUOTE)).toEqual(["Basic", "Idea"]);
});

test("a scenario dropped on the lower half of a row in another feature's outline lands just after it", async () => {
  await moveScenario(data, QUOTE, { name: "Basic", version: 1 }, ORDER, { name: "Checkout", version: 1, after: true });
  expect(await names(ORDER)).toEqual(["Checkout", "Basic", "Refund"]);
});

test("a drop next to a scenario the feature no longer has lands last", async () => {
  await moveScenario(data, QUOTE, { name: "Basic", version: 1 }, ORDER, { name: "Gone", version: 1, after: false });
  expect(await names(ORDER)).toEqual(["Checkout", "Refund", "Basic"]);
});

test("a draft dropped between two scenarios keeps that place, in the document only", async () => {
  await moveScenario(data, QUOTE, { name: "Idea", version: 1 }, ORDER, { name: "Refund", version: 1, after: false });
  expect(await names(ORDER)).toEqual(["Checkout", "Idea", "Refund"]);
  expect(await readFeature(data, ORDER)).not.toContain("Idea");
});

test("the move route takes the drop's place", async () => {
  await writeState({ dataRepo: data }, root);
  const res = (await handleApi(
    new Request(`http://localhost/api/features/${encodeURIComponent(QUOTE)}/move-scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario: { name: "Extra", version: 1 },
        to: ORDER,
        at: { name: "Checkout", version: 1, after: false },
      }),
    }),
  ))!;
  expect(res.status).toBe(200);
  expect(await names(ORDER)).toEqual(["Extra", "Checkout", "Refund"]);
});

test("undo puts a moved scenario back in its old place", async () => {
  const before = (await readFeatureView(data, QUOTE))!.parsed.scenarios;
  const back = scenarioPlace(before, { name: "Basic", version: 1 });
  expect(back).toEqual({ name: "Extra", version: 1, after: false });
  await moveScenario(data, QUOTE, { name: "Basic", version: 1 }, ORDER);
  await moveScenario(data, ORDER, { name: "Basic", version: 1 }, QUOTE, back!);
  expect(await names(QUOTE)).toEqual(["Basic", "Extra", "Idea"]);
  expect(await names(ORDER)).toEqual(["Checkout", "Refund"]);
});

test("a scenario's place is before the one after it, or after the one before it when last", () => {
  const list = [
    { name: "A", version: 1 },
    { name: "B", version: 1 },
  ];
  expect(scenarioPlace(list, { name: "A", version: 1 })).toEqual({ name: "B", version: 1, after: false });
  expect(scenarioPlace(list, { name: "B", version: 1 })).toEqual({ name: "A", version: 1, after: true });
  expect(scenarioPlace([list[0]!], { name: "A", version: 1 })).toBeNull();
  expect(scenarioPlace(list, { name: "C", version: 1 })).toBeNull();
});

test("a dragged scenario drops into any other feature, a published one only while Settings allows", () => {
  const proposed = { file: QUOTE, status: "proposed" };
  const published = { file: QUOTE, status: "published" };
  expect(scenarioMovesInto(proposed, ORDER, false)).toBe(true);
  expect(scenarioMovesInto(proposed, QUOTE, true)).toBe(false);
  expect(scenarioMovesInto(published, ORDER, false)).toBe(false);
  expect(scenarioMovesInto(published, ORDER, true)).toBe(true);
});
