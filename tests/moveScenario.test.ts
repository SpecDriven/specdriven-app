// Automates specs/ui/navigation.feature.md "move a scenario to another
// feature": the scenario menu's Move to… takes a scenario out of one feature
// and into another — whatever it is (draft, proposed or published), keeping
// what it carries, and on the same terms as its Delete.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  moveScenario,
  publishFeature,
  readFeature,
  readFeatureView,
  saveFeature,
  savePullRequests,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { writeState } from "../src/server/state";
import { filterPickOptions } from "../src/frontend/ModalPrompts";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

const QUOTE = "specs/quote.feature.md";
const ORDER = "specs/order.feature.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-move-scenario-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-move-scenario-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote");
  await createFeature(data, "Order");
  await saveFeature(
    data,
    QUOTE,
    "# Quote\n\n## Basic @v1\n\nbody\n\n" +
      "## Extra @v1\n\nmore\n\n[test: extra works : https://github.com/a/b/blob/main/t.test.ts#L3 ]\n\n" +
      "## Idea @v1 [draft]\n\nwip\n",
  );
  await saveFeature(data, ORDER, "# Order\n\n## Checkout @v1\n\npay\n");
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

const names = async (file: string) =>
  (await readFeatureView(data, file))!.parsed.scenarios.map((s) => `${s.name} v${s.version} ${s.status}`);

async function moveViaApi(scenario: { name: string; version: number }, to: string): Promise<Response> {
  return (await handleApi(
    new Request(`http://localhost/api/features/${encodeURIComponent(QUOTE)}/move-scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario, to }),
    }),
  ))!;
}

test("a proposed scenario moves with its body and tests, and leaves the source", async () => {
  const result = await moveScenario(data, QUOTE, { name: "Extra", version: 1 }, ORDER);
  expect(result.movedTo).toBe(ORDER);
  expect(result.content).not.toContain("Extra");
  expect(await names(QUOTE)).toEqual(["Basic v1 proposed", "Idea v1 draft"]);
  expect(await names(ORDER)).toEqual(["Checkout v1 proposed", "Extra v1 proposed"]);
  const order = (await readFeature(data, ORDER))!;
  expect(order).toContain("## Extra @v1 [proposed]");
  expect(order).toContain("more");
  expect(order).toContain("[test: extra works : https://github.com/a/b/blob/main/t.test.ts#L3 ]");
  // The documents agree with the files.
  expect((await loadFeatureDoc(data, QUOTE))!.doc.specs.map((s) => s.name).sort()).toEqual(["Basic", "Idea"]);
  expect((await loadFeatureDoc(data, ORDER))!.doc.specs.map((s) => s.name).sort()).toEqual(["Checkout", "Extra"]);
});

test("a draft moves as a draft — into the target's document, never its file", async () => {
  await moveScenario(data, QUOTE, { name: "Idea", version: 1 }, ORDER);
  expect(await names(QUOTE)).toEqual(["Basic v1 proposed", "Extra v1 proposed"]);
  expect(await names(ORDER)).toEqual(["Checkout v1 proposed", "Idea v1 draft"]);
  expect(await readFeature(data, ORDER)).not.toContain("Idea");
  const idea = (await loadFeatureDoc(data, ORDER))!.doc.specs.find((s) => s.name === "Idea")!;
  expect(idea.status).toBe("draft");
  expect(idea.body).toContain("wip");
});

test("pull request links, which only the document holds, move with the scenario", async () => {
  const prs = [{ url: "https://github.com/a/b/pull/7", title: "Extra" }];
  await savePullRequests(data, QUOTE, { name: "Extra", version: 1 }, prs);
  await moveScenario(data, QUOTE, { name: "Extra", version: 1 }, ORDER);
  const extra = (await readFeatureView(data, ORDER))!.parsed.scenarios.find((s) => s.name === "Extra")!;
  expect(extra.prs).toEqual(prs);
});

test("a move that would collide with a scenario already in the target is refused, and nothing changes", async () => {
  await saveFeature(data, ORDER, "# Order\n\n## Checkout @v1\n\npay\n\n## Extra @v1\n\nother\n");
  await expect(moveScenario(data, QUOTE, { name: "Extra", version: 1 }, ORDER)).rejects.toThrow(
    '"Order" already has "Extra" v1',
  );
  expect(await names(QUOTE)).toEqual(["Basic v1 proposed", "Extra v1 proposed", "Idea v1 draft"]);
  expect(await readFeature(data, ORDER)).toContain("other");
});

test("moving into the same feature, a missing scenario or a missing feature is an error", async () => {
  await expect(moveScenario(data, QUOTE, { name: "Extra", version: 1 }, QUOTE)).rejects.toThrow(
    "already in that feature",
  );
  await expect(moveScenario(data, QUOTE, { name: "Nope", version: 1 }, ORDER)).rejects.toThrow("not found");
  await expect(
    moveScenario(data, QUOTE, { name: "Extra", version: 1 }, "specs/missing.feature.md"),
  ).rejects.toThrow("not found");
  expect(await names(QUOTE)).toEqual(["Basic v1 proposed", "Extra v1 proposed", "Idea v1 draft"]);
});

async function publishBasic() {
  await publishFeature(data, QUOTE, (await readFeature(data, QUOTE))!, { name: "Basic", version: 1 });
}

// The same terms as Delete: published content leaves its feature only while
// Settings allows deleting published scenarios.
test("with deleting published specs off, a published scenario does not move", async () => {
  await writeState({ dataRepo: data }, root);
  await publishBasic();
  const res = await moveViaApi({ name: "Basic", version: 1 }, ORDER);
  expect(res.status).toBe(403);
  expect(await readFeature(data, QUOTE)).toContain("## Basic @v1 [published]");
  expect(await readFeature(data, ORDER)).not.toContain("Basic");
});

test("with deleting published specs on, a published scenario moves and stays published", async () => {
  await writeState({ dataRepo: data, deletePublished: true }, root);
  await publishBasic();
  const res = await moveViaApi({ name: "Basic", version: 1 }, ORDER);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: string; movedTo: string };
  expect(body.movedTo).toBe(ORDER);
  expect(body.content).not.toContain("Basic");
  expect(await readFeature(data, QUOTE)).not.toContain("Basic");
  expect(await readFeature(data, ORDER)).toContain("## Basic @v1 [published]");
  const basic = (await loadFeatureDoc(data, ORDER))!.doc.specs.find((s) => s.name === "Basic")!;
  expect(basic.status).toBe("published");
});

test("a proposed scenario moves through the route without the published switch", async () => {
  await writeState({ dataRepo: data }, root);
  const res = await moveViaApi({ name: "Extra", version: 1 }, ORDER);
  expect(res.status).toBe(200);
  expect(await names(ORDER)).toEqual(["Checkout v1 proposed", "Extra v1 proposed"]);
});

// The Move to… picker narrows the features by name or by path as you type.
test("the feature picker filters by label or by path", () => {
  const options = [
    { value: "specs/ui/navigation.feature.md", label: "Navigation", hint: "ui/navigation.feature.md" },
    { value: "specs/search.feature.md", label: "Search", hint: "search.feature.md" },
  ];
  expect(filterPickOptions(options, "").map((o) => o.label)).toEqual(["Navigation", "Search"]);
  expect(filterPickOptions(options, "SEAR").map((o) => o.label)).toEqual(["Search"]);
  expect(filterPickOptions(options, "ui/").map((o) => o.label)).toEqual(["Navigation"]);
  expect(filterPickOptions(options, "nothing")).toEqual([]);
});
