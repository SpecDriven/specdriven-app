// Automates specs/editor/spec-editor.feature.md "Delete Published Spec":
// deleting a published scenario is possible only while the user-settings
// switch is on — the client shows a Danger Zone confirmation, and a confirmed
// delete removes the scenario. The switch is enforced on the server, so with
// it off the route refuses and published scenarios stay immutable.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  deletePublishedScenario,
  publishFeature,
  readFeature,
  readFeatureForEditor,
  saveFeature,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { normalizeDeletePublished, readState, writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-delete-published-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-delete-published-home-"));
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

/** A feature with one published and one proposed scenario, ready to delete. */
async function publishedQuote(): Promise<void> {
  await createFeature(data, "Quote");
  await saveFeature(
    data,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Extra @v1\n\nmore\n",
  );
  await publishFeature(
    data,
    "quote.feature.md",
    (await readFeature(data, "quote.feature.md"))!,
    { name: "Basic", version: 1 },
  );
}

async function deleteViaApi(scenario: { name: string; version: number }): Promise<Response> {
  return (await handleApi(
    new Request("http://localhost/api/features/quote.feature.md/delete-published", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    }),
  ))!;
}

// "Given: deletion of published specs is turned on in user settings" — the
// setting exists, and it is off unless explicitly turned on.
test("deleting published specs is off by default", () => {
  expect(normalizeDeletePublished(undefined)).toBe(false);
  expect(normalizeDeletePublished(false)).toBe(false);
  expect(normalizeDeletePublished("yes")).toBe(false);
  expect(normalizeDeletePublished(true)).toBe(true);
});

test("the Settings switch round-trips through the settings file", async () => {
  await writeState({ dataRepo: data }, root);
  const on = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletePublished: true }),
    }),
  ))!;
  expect(on.status).toBe(200);
  expect(((await on.json()) as { deletePublished: boolean }).deletePublished).toBe(true);
  expect((await readState(root)).deletePublished).toBe(true);
  // Off is the default, stored as an absent key.
  const off = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletePublished: false }),
    }),
  ))!;
  expect(off.status).toBe(200);
  expect(((await off.json()) as { deletePublished: boolean }).deletePublished).toBe(false);
  expect((await readState(root)).deletePublished).toBeUndefined();
});

// The switch is a server-side gate, not only a hidden button: with it off the
// route refuses and the published scenario survives.
test("with the setting off, the delete route refuses", async () => {
  await writeState({ dataRepo: data }, root);
  await publishedQuote();
  const res = await deleteViaApi({ name: "Basic", version: 1 });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("switched off");
  expect(await readFeature(data, "quote.feature.md")).toContain("## Basic @v1 [published]");
});

// "If confirmed, the spec is deleted." — the published scenario leaves the
// file and the Automerge document; the scenario beside it is untouched.
test("with the setting on, a confirmed delete removes the published spec", async () => {
  await writeState({ dataRepo: data, deletePublished: true }, root);
  await publishedQuote();
  const res = await deleteViaApi({ name: "Basic", version: 1 });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: string };
  expect(body.content).not.toContain("Basic");
  expect(await readFeature(data, "quote.feature.md")).not.toContain("Basic");
  expect(await readFeatureForEditor(data, "quote.feature.md")).toContain(
    "## Extra @v1 [proposed]",
  );
  const loaded = await loadFeatureDoc(data, "quote.feature.md");
  expect(loaded!.doc.specs.map((s) => s.name)).toEqual(["Extra"]);
});

// Only a published scenario goes through this door — drafts and proposed
// scenarios have their own removals, and a missing target is an error.
test("only a published scenario can be deleted through the published route", async () => {
  await publishedQuote();
  await expect(
    deletePublishedScenario(data, "quote.feature.md", { name: "Extra", version: 1 }),
  ).rejects.toThrow('Published scenario "Extra" @v1 not found');
  await expect(
    deletePublishedScenario(data, "quote.feature.md", { name: "Nope", version: 1 }),
  ).rejects.toThrow("not found");
});

// The route only skips the immutability gate for the one targeted scenario:
// a second published scenario in the same file survives the delete.
test("deleting one published scenario leaves other published scenarios intact", async () => {
  await publishedQuote();
  await publishFeature(
    data,
    "quote.feature.md",
    (await readFeature(data, "quote.feature.md"))!,
    { name: "Extra", version: 1 },
  );
  await deletePublishedScenario(data, "quote.feature.md", { name: "Basic", version: 1 });
  expect(await readFeature(data, "quote.feature.md")).toContain("## Extra @v1 [published]");
});
