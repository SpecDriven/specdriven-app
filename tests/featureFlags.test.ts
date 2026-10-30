// Automates specs/app/feature-flags.feature.md: `[ff:<name>:on|off]` lines
// under a feature's or a scenario's heading are lifted into `flags`, written
// back in one line right under the heading, carried by the Automerge document
// like a ticket link, and shown in the app only while the "Feature flags"
// setting is on.

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
import { importFeatureDoc } from "../src/server/automerge/reconcile";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { threeWayFeature } from "../src/server/automerge/merge";
import {
  formatFeatureFlags,
  isFeatureFlagName,
  parseFeature,
  parseFeatureFlagsLine,
  serializeFeature,
  type Feature,
} from "../src/server/parser";
import { normalizeFeatureFlags, readState, writeState } from "../src/server/state";

const FLAGGED = `# Checkout

[ff:new-checkout:on]

[Jira:ABC-1](https://acme.atlassian.net/browse/ABC-1)

Pay for what is in the cart.

## Pay by card @v1 [published]

[ff:new-checkout:on] [ff:card-v2:off]

- Given: a cart
- Then: I can pay by card
`;

// What the app writes: the scenario numbered by its position (parser.ts
// `S<n>:`); parsing either form gives the same feature.
const WRITTEN = FLAGGED.replace("## Pay by card", "## S1: Pay by card");

test("flag lines under the headings are lifted into flags and written back as they were", () => {
  const feature = parseFeature(FLAGGED);
  expect(feature.flags).toEqual([{ name: "new-checkout", on: true }]);
  expect(feature.links?.[0]?.ticket).toBe("ABC-1");
  expect(feature.description).toBe("Pay for what is in the cart.");
  expect(feature.scenarios[0]!.flags).toEqual([
    { name: "new-checkout", on: true },
    { name: "card-v2", on: false },
  ]);
  expect(feature.scenarios[0]!.body).toBe("- Given: a cart\n- Then: I can pay by card");
  expect(serializeFeature(feature)).toBe(WRITTEN);
});

test("flag lines mix with the link and authorship lines in any order, and several lines add up", () => {
  const feature = parseFeature(
    "# F\n\n## S @v1 [proposed]\n\n**Created by:** ada\n[ff:a:ON]\n[Jira:X-1](https://x.test/X-1)\n[ff:b:Off] [ff:a:off]\n\nbody\n",
  );
  const s = feature.scenarios[0]!;
  // `on`/`off` read in any case; a name already given keeps its first value.
  expect(s.flags).toEqual([
    { name: "a", on: true },
    { name: "b", on: false },
  ]);
  expect(s.createdBy).toBe("ada");
  expect(s.link?.ticket).toBe("X-1");
  expect(s.body).toBe("body");
  // Written as one line, right under the heading, in lower case.
  expect(serializeFeature(feature)).toBe(
    "# F\n\n## S1: S @v1 [proposed]\n\n[ff:a:on] [ff:b:off]\n\n[Jira:X-1](https://x.test/X-1)\n\n**Created by:** ada\n\nbody\n",
  );
});

test("a token inside text, a malformed token or a flag line further down stays text", () => {
  const feature = parseFeature(
    "# F\n\nGated by [ff:a:on] for now.\n\n## S @v1 [proposed]\n\n[ff:bad name:on]\n\nbody\n\n[ff:late:on]\n",
  );
  expect(feature.flags).toBeUndefined();
  expect(feature.description).toBe("Gated by [ff:a:on] for now.");
  expect(feature.scenarios[0]!.flags).toBeUndefined();
  expect(feature.scenarios[0]!.body).toBe("[ff:bad name:on]\n\nbody\n\n[ff:late:on]");
  expect(parseFeatureFlagsLine("[ff:a:maybe]")).toBeNull();
  expect(parseFeatureFlagsLine("[ff:a:on] and more")).toBeNull();
});

test("flag names the token syntax can carry", () => {
  for (const ok of ["a", "new-checkout", "card_v2", "Beta.1"]) expect(isFeatureFlagName(ok)).toBe(true);
  for (const bad of ["", "-a", "a b", "a:b", "a]", "ä"]) expect(isFeatureFlagName(bad)).toBe(false);
  expect(formatFeatureFlags([{ name: "x", on: false }])).toBe("[ff:x:off]");
});

test("the document carries the flags and projects them back", () => {
  const doc = importFeatureDoc(parseFeature(FLAGGED));
  expect(doc.flags).toEqual([{ name: "new-checkout", on: true }]);
  expect(docToFeature(doc).scenarios[0]!.flags?.map((f) => f.name)).toEqual(["new-checkout", "card-v2"]);
  expect(projectFeature(doc, { publishExternalLinks: true })).toBe(WRITTEN);
});

test("a three-way merge keeps the side that changed the flags", () => {
  const base = parseFeature(FLAGGED);
  const flip = (f: Feature): Feature => ({
    ...f,
    scenarios: f.scenarios.map((s) => ({ ...s, flags: [{ name: "card-v2", on: true }] })),
  });
  const theirs = flip(base);
  const merged = threeWayFeature(base, base, theirs);
  expect(merged.ok).toBe(true);
  if (merged.ok) {
    expect(merged.feature.scenarios[0]!.flags).toEqual([{ name: "card-v2", on: true }]);
    expect(merged.feature.flags).toEqual([{ name: "new-checkout", on: true }]);
  }
  // A flag change is an edit: the other side deleting that scenario is a conflict.
  const deleted: Feature = { ...base, scenarios: [] };
  expect(threeWayFeature(base, theirs, deleted).ok).toBe(false);
});

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-feature-flags-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-feature-flags-home-"));
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

test("a flag on a published scenario changes without a new version", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1\n\nbody\n");
  await publishFeature(data, file, (await readFeature(data, file))!, { name: "Basic", version: 1 });
  expect(await readFeature(data, file)).toContain("## S1: Basic @v1 [published]");

  const flagged = (await readFeature(data, file))!.replace(
    "## S1: Basic @v1 [published]\n",
    "## S1: Basic @v1 [published]\n\n[ff:quotes-v2:off]\n",
  );
  await saveFeature(data, file, flagged);
  const text = (await readFeature(data, file))!;
  expect(text).toContain("## S1: Basic @v1 [published]\n\n[ff:quotes-v2:off]\n\nbody");
  const doc = (await loadFeatureDoc(data, file))!.doc;
  expect(doc.specs[0]!.flags).toEqual([{ name: "quotes-v2", on: false }]);
  expect(doc.specs[0]!.version).toBe(1);

  // Toggling it is the same kind of edit.
  await saveFeature(data, file, text.replace("[ff:quotes-v2:off]", "[ff:quotes-v2:on]"));
  expect(await readFeature(data, file)).toContain("[ff:quotes-v2:on]");
  // The body still may not change.
  await expect(
    saveFeature(data, file, (await readFeature(data, file))!.replace("body", "other")),
  ).rejects.toThrow(/published and immutable/);
});

test("a draft's flags reach the editor from the document", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1 [draft]\n\n[ff:beta:on]\n\nbody\n");
  const view = (await readFeatureView(data, file))!;
  expect(view.parsed.scenarios[0]!.flags).toEqual([{ name: "beta", on: true }]);
});

test("the Feature flags setting is off by default and round-trips through the settings file", async () => {
  expect(normalizeFeatureFlags(undefined)).toBe(false);
  await writeState({ dataRepo: data }, root);
  const put = async (body: unknown) =>
    (await handleApi(
      new Request("http://localhost/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ))!;
  const on = await put({ featureFlags: true });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { featureFlags: boolean }).featureFlags).toBe(true);
  expect((await readState(root)).featureFlags).toBe(true);
  const off = await put({ featureFlags: false });
  expect(((await off.json()) as { featureFlags: boolean }).featureFlags).toBe(false);
  // Off is the default, stored as an absent key.
  expect((await readState(root)).featureFlags).toBeUndefined();
  expect((await put({ featureFlags: "yes" })).status).toBe(400);
});
