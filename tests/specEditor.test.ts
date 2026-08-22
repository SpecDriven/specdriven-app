// Automates specs/editor/spec-editor.feature.md "Create New Spec": a new
// spec starts as a draft persisted in Automerge, Delete removes the draft,
// and the dialog's two ways forward are Propose and Publish — closing (ESC or
// the close widget) leaves the scenario in its autosaved state, which is the
// frontend simply not discarding anything on the way out.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  deleteDraftScenario,
  publishFeature,
  readFeature,
  readFeatureForEditor,
  readFeatureView,
  saveFeature,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-spec-editor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// "The new spec starts in draft mode. The draft spec is persisted in
// Automerge." — an autosaved draft lands in the feature's document, never in
// the .feature.md, and the editor keeps seeing it.
test("a new draft is persisted in the Automerge document, out of the file", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  expect(await readFeature(root, "quote.feature.md")).not.toContain("Idea");
  expect(await readFeatureForEditor(root, "quote.feature.md")).toContain("## Idea @v1 [draft]");
  const loaded = await loadFeatureDoc(root, "quote.feature.md");
  expect(loaded).not.toBeNull();
  expect(loaded!.doc.specs.map((s) => [s.name, s.status])).toEqual([["Idea", "draft"]]);
});

// "The user can use Delete which removes the draft spec." — a draft is
// deleted from the document (the file never held it), leaving nothing behind.
test("Delete removes the draft spec", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await deleteDraftScenario(root, "quote.feature.md", { name: "Idea", version: 1 });
  expect(result.content).not.toContain("Idea");
  expect(await readFeatureForEditor(root, "quote.feature.md")).not.toContain("Idea");
  // The scenario beside it is untouched.
  expect(await readFeature(root, "quote.feature.md")).toContain("## Basic @v1 [proposed]");
});

// "Propose" — the explicit action that moves the draft into the .feature.md
// as [proposed].
test("Propose lands the draft in the feature file as [proposed]", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  // The dialog's Propose saves the same scenario with the proposed status.
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1\n\nwip\n");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Idea @v1 [proposed]");
  // The draft entry did not survive alongside its proposed self.
  const editor = await readFeatureForEditor(root, "quote.feature.md");
  expect(editor).not.toContain("[draft]");
});

// "Publish" — straight from the dialog: the targeted scenario goes into the
// file marked [published], without a stop at [proposed].
test("Publish promotes a draft scenario straight to [published]", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await publishFeature(
    root,
    "quote.feature.md",
    (await readFeatureForEditor(root, "quote.feature.md"))!,
    { name: "Idea", version: 1 },
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Idea @v1 [published]");
  // Only the targeted scenario was published.
  expect(text).toContain("## Basic @v1 [proposed]");
});

// What the editor reads carries the document's id for every scenario — its
// identity through a rename — while the file never does: the id is private to
// the document (specs/datastore/automerge-store.feature.md).
test("the editor view carries each scenario's document id; the markdown carries none", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const view = (await readFeatureView(root, "quote.feature.md"))!;
  const loaded = await loadFeatureDoc(root, "quote.feature.md");
  const ids = Object.fromEntries(loaded!.doc.specs.map((s) => [s.name, s.id]));
  expect(view.parsed.scenarios.map((s) => [s.name, s.id])).toEqual([
    ["Basic", ids["Basic"]],
    ["Idea", ids["Idea"]],
  ]);
  for (const id of Object.values(ids)) {
    expect(view.content).not.toContain(id);
    expect(await readFeature(root, "quote.feature.md")).not.toContain(id);
  }
});

// The dialog's Publish after autosave and a retyped title — the tick filed the
// draft under the first title, then the title and body were both rewritten.
// The editor names the draft by its document id, so Publish publishes that
// draft under its new name; it does not add a second spec beside a draft that
// lingers under the old one (specs/editor-autosave.feature.md "Autosave Never
// Adds the Same Scenario Twice").
test("Publish of a renamed draft publishes that draft, not a second spec beside it", async () => {
  await createFeature(root, "Quote");
  const tick = await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Scenario goes under the highlighted folder @v1 [draft]\n\nWhen adding\n",
  );
  const draft = tick.parsed.scenarios.find((s) => s.status === "draft")!;
  expect(draft.id).toBeString();
  const result = await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Spec goes under the highlighted folder @v1\n\nWhen adding a spec, it goes under the highlighted folder.\n",
    { id: draft.id, name: "Spec goes under the highlighted folder", version: 1 },
  );
  expect(result.status).toBe("published");
  expect(await readFeature(root, "quote.feature.md")).toContain(
    "## Spec goes under the highlighted folder @v1 [published]",
  );
  // Nothing left under the old title — in the editor's view or the document.
  const editor = await readFeatureForEditor(root, "quote.feature.md");
  expect(editor).not.toContain("Scenario goes under");
  expect(editor).not.toContain("[draft]");
  const loaded = await loadFeatureDoc(root, "quote.feature.md");
  expect(loaded!.doc.specs.map((s) => [s.name, s.status, s.id])).toEqual([
    ["Spec goes under the highlighted folder", "published", draft.id!],
  ]);
});

// The same rename through an autosave tick: the tick after the title is
// retyped rewrites the entry the earlier tick placed — one draft, under the
// new name, with the entry's identity intact.
test("an autosave after a retyped title rewrites the draft instead of filing a second one", async () => {
  await createFeature(root, "Quote");
  const first = await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  const id = first.parsed.scenarios[0]!.id!;
  const result = await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Better Idea @v1 [draft]\n\nwip, continued\n",
    { id, name: "Better Idea", version: 1 },
  );
  expect(result.content).toContain("## Better Idea @v1 [draft]");
  expect(result.content).not.toContain("## Idea @v1");
  expect(result.parsed.scenarios.map((s) => [s.name, s.status, s.id])).toEqual([
    ["Better Idea", "draft", id],
  ]);
  const loaded = await loadFeatureDoc(root, "quote.feature.md");
  expect(loaded!.doc.specs.map((s) => [s.name, s.status, s.id])).toEqual([
    ["Better Idea", "draft", id],
  ]);
});
