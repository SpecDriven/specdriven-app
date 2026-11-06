// Automates specs/ui/navigation.feature.md "delete several scenarios at once":
// the scenarios picked in the sidebar tree go in one request, each removed
// the way its own Delete would — a draft out of the Automerge document, a
// proposed or published one out of the file — and published ones only while
// the Settings switch is on.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  publishFeature,
  readFeature,
  readFeatureForEditor,
  saveFeature,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const FILE = "specs/quote.feature.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-delete-scenarios-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-delete-scenarios-home-"));
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

/** Quote: Basic published, Extra and Other proposed, Idea a draft. */
async function quote(): Promise<void> {
  await createFeature(data, "Quote");
  await saveFeature(
    data,
    FILE,
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Extra @v1\n\nmore\n\n## Other @v1\n\nrest\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  await publishFeature(data, FILE, (await readFeature(data, FILE))!, { name: "Basic", version: 1 });
}

async function deleteViaApi(scenarios: unknown): Promise<Response> {
  return (await handleApi(
    new Request(`http://localhost/api/features/${encodeURIComponent(FILE)}/delete-scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarios }),
    }),
  ))!;
}

const names = async () => (await loadFeatureDoc(data, FILE))!.doc.specs.map((s) => s.name);

test("a draft and a proposed scenario go in one request; the rest stay", async () => {
  await writeState({ dataRepo: data }, root);
  await quote();
  const res = await deleteViaApi([
    { name: "Idea", version: 1 },
    { name: "Extra", version: 1 },
  ]);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: string };
  expect(body.content).not.toContain("Idea");
  expect(body.content).not.toContain("Extra");
  expect(await names()).toEqual(["Basic", "Other"]);
  const editor = (await readFeatureForEditor(data, FILE))!;
  expect(editor).toContain("Basic @v1 [published]");
  expect(editor).toContain("Other @v1 [proposed]");
  expect(editor).not.toContain("[draft]");
});

test("with the setting off, a batch holding a published scenario is refused whole", async () => {
  await writeState({ dataRepo: data }, root);
  await quote();
  const res = await deleteViaApi([
    { name: "Basic", version: 1 },
    { name: "Extra", version: 1 },
  ]);
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("switched off");
  // Nothing went — not even the proposed one picked beside it.
  expect(await names()).toEqual(["Basic", "Extra", "Other", "Idea"]);
});

test("with the setting on, published, proposed and draft scenarios go together", async () => {
  await writeState({ dataRepo: data, deletePublished: true }, root);
  await quote();
  const res = await deleteViaApi([
    { name: "Basic", version: 1 },
    { name: "Extra", version: 1 },
    { name: "Idea", version: 1 },
  ]);
  expect(res.status).toBe(200);
  expect(await names()).toEqual(["Other"]);
  const file = (await readFeature(data, FILE))!;
  expect(file).not.toContain("Basic");
  expect(file).toContain("## S1: Other @v1 [proposed]");
});

test("a pick that is no longer there fails the batch before anything is deleted", async () => {
  await writeState({ dataRepo: data }, root);
  await quote();
  const res = await deleteViaApi([
    { name: "Extra", version: 1 },
    { name: "Gone", version: 3 },
  ]);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('"Gone" @v3 not found');
  expect(await names()).toEqual(["Basic", "Extra", "Other", "Idea"]);
});

test("a malformed or empty list is refused", async () => {
  await writeState({ dataRepo: data }, root);
  await quote();
  expect((await deleteViaApi([])).status).toBe(400);
  expect((await deleteViaApi([{ name: "Extra" }])).status).toBe(400);
  expect((await deleteViaApi("Extra")).status).toBe(400);
});
