// Automates specs/ui/scenario-polarity.feature.md: a `[negative]` line under
// a scenario's heading is lifted into `negative`, written back right under
// the heading, carried by the Automerge document like a feature flag —
// bookkeeping a published scenario takes without a new version — and shown
// in the app only while the "Positive and negative scenarios" setting is on.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  publishFeature,
  readFeature,
  readFeatureView,
  saveFeature,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { threeWayFeature } from "../src/server/automerge/merge";
import {
  formatNegative,
  parseFeature,
  parseNegativeLine,
  serializeFeature,
  splitScenarioMeta,
  type Feature,
} from "../src/server/parser";
import { normalizeScenarioPolarity, readState, writeState } from "../src/server/state";

const MARKED = `# Checkout

Pay for what is in the cart.

## Approved card @v1 [published]

- Given: a cart
- Then: I can pay by card

## Card declined @v1 [proposed]

[negative]

- Given: a cart and a blocked card
- Then: the payment is refused
`;

// What the app writes: the scenarios numbered by position (parser.ts `S<n>:`).
const WRITTEN = MARKED.replace("## Approved card", "## S1: Approved card").replace(
  "## Card declined",
  "## S2: Card declined",
);

test("a negative line under the heading is lifted into negative and written back as the first line under it", () => {
  const feature = parseFeature(MARKED);
  const [positive, negative] = feature.scenarios;
  expect(positive!.negative).toBeUndefined();
  expect(negative!.negative).toBe(true);
  expect(negative!.body).toBe("- Given: a cart and a blocked card\n- Then: the payment is refused");
  expect(serializeFeature(feature)).toBe(WRITTEN);
  expect(formatNegative()).toBe("[negative]");
  expect(parseNegativeLine("  [NEGATIVE]  ")).toBe(true);
  expect(parseNegativeLine("[negative] and more")).toBe(false);
  expect(parseNegativeLine("[negative:yes]")).toBe(false);
});

test("the marker mixes with flag, link and authorship lines in any order; a second one, or one further down, stays text", () => {
  const feature = parseFeature(
    "# F\n\n## S @v1 [proposed]\n\n**Created by:** ada\n[ff:a:on]\n[negative]\n[Jira:X-1](https://x.test/X-1)\n\n[negative]\n\nbody\n",
  );
  const s = feature.scenarios[0]!;
  expect(s.negative).toBe(true);
  expect(s.flags).toEqual([{ name: "a", on: true }]);
  expect(s.createdBy).toBe("ada");
  expect(s.link?.ticket).toBe("X-1");
  expect(s.body).toBe("[negative]\n\nbody");
  // Written first under the heading, before the flags.
  expect(serializeFeature(feature)).toBe(
    "# F\n\n## S1: S @v1 [proposed]\n\n[negative]\n\n[ff:a:on]\n\n[Jira:X-1](https://x.test/X-1)\n\n**Created by:** ada\n\n[negative]\n\nbody\n",
  );
  // A marker below content is content, and a feature description never takes one.
  const late = parseFeature("# F\n\n[negative]\n\n## S @v1 [proposed]\n\nbody\n\n[negative]\n");
  expect(late.description).toBe("[negative]");
  expect(late.scenarios[0]!.negative).toBeUndefined();
  expect(late.scenarios[0]!.body).toBe("body\n\n[negative]");
  expect(splitScenarioMeta("[negative]\n\nbody")).toEqual({ text: "body", negative: true });
});

test("a scenario without the marker is positive, and today's files round-trip unchanged", () => {
  const plain = "# F\n\n## S1: A @v1 [proposed]\n\nbody\n";
  const feature = parseFeature(plain);
  expect("negative" in feature.scenarios[0]!).toBe(false);
  expect(serializeFeature(feature)).toBe(plain);
});

test("the document carries the marker and projects it back", () => {
  const doc = importFeatureDoc(parseFeature(MARKED));
  expect(doc.specs.map((s) => s.negative)).toEqual([undefined, true]);
  expect(docToFeature(doc).scenarios.map((s) => s.negative)).toEqual([undefined, true]);
  expect(projectFeature(doc, { publishExternalLinks: true })).toBe(WRITTEN);
});

test("reconcile sets and clears the marker, and a no-op stays one", () => {
  const doc = importFeatureDoc(parseFeature(MARKED));
  const flip = (f: Feature, at: number, negative: boolean): Feature => ({
    ...f,
    scenarios: f.scenarios.map((s, i) => {
      if (i !== at) return s;
      const { negative: _p, ...rest } = s;
      return negative ? { ...rest, negative: true } : rest;
    }),
  });
  const same = reconcile(doc, docToFeature(doc));
  expect(same.specs.map((s) => s.negative)).toEqual([undefined, true]);
  const swapped = reconcile(doc, flip(flip(docToFeature(doc), 0, true), 1, false));
  expect(swapped.specs.map((s) => s.negative)).toEqual([true, undefined]);
  expect(docToFeature(swapped).scenarios.map((s) => s.negative)).toEqual([true, undefined]);
  expect(swapped.specs.map((s) => s.version)).toEqual([1, 1]);
});

test("a three-way merge keeps the side that flipped the marker, ours when both did; a flip is an edit against a delete", () => {
  const base = parseFeature(MARKED);
  const theirs: Feature = { ...base, scenarios: base.scenarios.map((s) => ({ ...s, negative: true as const })) };
  const merged = threeWayFeature(base, base, theirs);
  expect(merged.ok).toBe(true);
  if (merged.ok) expect(merged.feature.scenarios.map((s) => s.negative)).toEqual([true, true]);
  const ours: Feature = {
    ...base,
    scenarios: base.scenarios.map((s) => {
      const { negative: _p, ...rest } = s;
      return rest;
    }),
  };
  const both = threeWayFeature(base, ours, theirs);
  expect(both.ok).toBe(true);
  // The second scenario: ours cleared it, theirs kept it — ours wins.
  if (both.ok) expect(both.feature.scenarios.map((s) => s.negative)).toEqual([true, undefined]);
  const deleted: Feature = { ...base, scenarios: [] };
  expect(threeWayFeature(base, theirs, deleted).ok).toBe(false);
});

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-polarity-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-polarity-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
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

test("flipping a published scenario's marker is bookkeeping, no new version, the body still immutable", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1\n\nbody\n");
  await publishFeature(data, file, (await readFeature(data, file))!, { name: "Basic", version: 1 });
  expect(await readFeature(data, file)).toContain("## S1: Basic @v1 [published]");

  const marked = (await readFeature(data, file))!.replace(
    "## S1: Basic @v1 [published]\n",
    "## S1: Basic @v1 [published]\n\n[negative]\n",
  );
  await saveFeature(data, file, marked);
  const text = (await readFeature(data, file))!;
  expect(text).toContain("## S1: Basic @v1 [published]\n\n[negative]\n\nbody");
  const doc = (await loadFeatureDoc(data, file))!.doc;
  expect(doc.specs[0]!.negative).toBe(true);
  expect(doc.specs[0]!.version).toBe(1);
  expect((await readFeatureView(data, file))!.parsed.scenarios[0]!.negative).toBe(true);

  // Flipping it back is the same kind of edit.
  await saveFeature(data, file, text.replace("[negative]\n\n", ""));
  expect(await readFeature(data, file)).not.toContain("[negative]");
  expect((await loadFeatureDoc(data, file))!.doc.specs[0]!.negative).toBeUndefined();
  // The body still may not change.
  await expect(
    saveFeature(data, file, (await readFeature(data, file))!.replace("body", "other")),
  ).rejects.toThrow(/published and immutable/);
});

test("a draft's marker reaches the editor from the document", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1 [draft]\n\n[negative]\n\nbody\n");
  const view = (await readFeatureView(data, file))!;
  expect(view.parsed.scenarios[0]!.negative).toBe(true);
  expect(view.parsed.scenarios[0]!.body).toBe("body");
});

test("the Positive and negative scenarios setting is off by default and round-trips through the settings file", async () => {
  expect(normalizeScenarioPolarity(undefined)).toBe(false);
  await writeState({ dataRepo: data }, root);
  const put = async (body: unknown) =>
    (await handleApi(
      new Request("http://localhost/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ))!;
  const on = await put({ scenarioPolarity: true });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { scenarioPolarity: boolean }).scenarioPolarity).toBe(true);
  expect((await readState(root)).scenarioPolarity).toBe(true);
  const off = await put({ scenarioPolarity: false });
  expect(((await off.json()) as { scenarioPolarity: boolean }).scenarioPolarity).toBe(false);
  // Off is the default, stored as an absent key.
  expect((await readState(root)).scenarioPolarity).toBeUndefined();
  expect((await put({ scenarioPolarity: "yes" })).status).toBe(400);
  const state = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await state.json()) as { scenarioPolarity: boolean }).scenarioPolarity).toBe(false);
});
