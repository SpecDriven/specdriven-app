// Automates specs/editor/spec-editor.feature.md "Unpublish a Spec": while
// deletion of published specs is turned on in user settings, a published
// scenario can be moved back to [proposed] — the same switch, enforced on the
// server, so with it off the route refuses and the scenario stays published.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  publishFeature,
  readFeature,
  saveFeature,
  unpublishScenario,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-unpublish-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-unpublish-home-"));
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

const FILE = "specs/quote.feature.md";

/** A feature with two published scenarios. */
async function publishedQuote(): Promise<void> {
  await createFeature(data, "Quote");
  await saveFeature(data, FILE, "# Quote\n\n## Basic @v1\n\nbody\n\n## Extra @v1\n\nmore\n");
  for (const name of ["Basic", "Extra"]) {
    await publishFeature(data, FILE, (await readFeature(data, FILE))!, { name, version: 1 });
  }
}

async function unpublishViaApi(scenario: { name: string; version: number }): Promise<Response> {
  return (await handleApi(
    new Request(`http://localhost/api/features/${encodeURIComponent(FILE)}/unpublish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    }),
  ))!;
}

test("with the setting off, the unpublish route refuses", async () => {
  await writeState({ dataRepo: data }, root);
  await publishedQuote();
  const res = await unpublishViaApi({ name: "Basic", version: 1 });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("switched off");
  expect(await readFeature(data, FILE)).toContain("## S1: Basic @v1 [published]");
});

test("with the setting on, a published spec moves back to proposed", async () => {
  await writeState({ dataRepo: data, deletePublished: true }, root);
  await publishedQuote();
  const res = await unpublishViaApi({ name: "Basic", version: 1 });
  expect(res.status).toBe(200);
  const text = (await readFeature(data, FILE))!;
  // Same name, version, place and body; only the status changed. The other
  // published scenario is untouched.
  expect(text).toContain("## S1: Basic @v1 [proposed]\n\nbody");
  expect(text).toContain("## S2: Extra @v1 [published]");
  const loaded = await loadFeatureDoc(data, FILE);
  const basic = loaded!.doc.specs.find((s) => s.name === "Basic")!;
  expect(basic.status).toBe("proposed");
  expect(basic.publishedBody).toBeUndefined();
});

test("an unpublished spec is editable again, and Publish takes it back", async () => {
  await publishedQuote();
  await unpublishScenario(data, FILE, { name: "Basic", version: 1 });
  const edited = (await readFeature(data, FILE))!.replace("body", "new body");
  await saveFeature(data, FILE, edited);
  expect(await readFeature(data, FILE)).toContain("## S1: Basic @v1 [proposed]\n\nnew body");
  await publishFeature(data, FILE, (await readFeature(data, FILE))!, { name: "Basic", version: 1 });
  expect(await readFeature(data, FILE)).toContain("## S1: Basic @v1 [published]\n\nnew body");
});

test("only a published scenario can be unpublished", async () => {
  await createFeature(data, "Quote");
  await saveFeature(data, FILE, "# Quote\n\n## Basic @v1\n\nbody\n");
  await expect(unpublishScenario(data, FILE, { name: "Basic", version: 1 })).rejects.toThrow(
    'Published scenario "Basic" @v1 not found',
  );
});
