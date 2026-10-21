// specs/ui/ui.feature.md "Number scenarios and move them up or down" and
// crud-feature.md "Feature file format": scenarios keep the order of the
// file, the headings carry their position as `S<n>:`, a document keeps the
// order as each entry's rank, and a merge never undoes a move.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { markProposed, parseFeature, serializeFeature, type Feature } from "../src/server/parser";
import {
  compareSpecs,
  docToFeature,
  interleaveDrafts,
  isProjectionOf,
  orderSpecs,
  projectFeature,
} from "../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { mergeOrder, threeWayFeature } from "../src/server/automerge/merge";
import { importDrift } from "../src/server/automerge/driftSync";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { createFeature, readFeature, readFeatureView, saveFeature } from "../src/server/features";

const NUMBERED = `# Quote Policy

## S1: Zed @v1 [proposed]

zed

## S2: Alpha @v1 [published]

alpha

## S3: Mid @v2 [proposed]

mid
`;

// As the app wrote files before the numbers: by name, then version.
const LEGACY = `# Quote Policy

## Alpha @v1 [published]

alpha

## Mid @v2 [proposed]

mid

## Zed @v1 [proposed]

zed
`;

// A numberless file whose headings are out of the legacy order — a hand
// edit, which the drift pass absorbs and writes back numbered.
const LEGACY_UNSORTED = `# Quote Policy

## Zed @v1 [proposed]

zed

## Alpha @v1 [published]

alpha

## Mid @v2 [proposed]

mid
`;

const names = (f: Feature) => f.scenarios.map((s) => s.name);
const headings = (text: string) => text.split("\n").filter((l) => l.startsWith("## "));

// --- the file format -------------------------------------------------------

test("a numbered file keeps the order of its headings, and the number is not part of the name", () => {
  const f = parseFeature(NUMBERED);
  expect(names(f)).toEqual(["Zed", "Alpha", "Mid"]);
  expect(f.scenarios[0]).toMatchObject({ name: "Zed", version: 1, status: "proposed", body: "zed" });
});

test("the numbers are a label for the order, so position wins over a hand-edited number", () => {
  const edited = NUMBERED.replace("## S1: Zed", "## S7: Zed").replace("## S2: Alpha", "## S7: Alpha");
  expect(names(parseFeature(edited))).toEqual(["Zed", "Alpha", "Mid"]);
  expect(headings(serializeFeature(parseFeature(edited)))).toEqual([
    "## S1: Zed @v1 [proposed]",
    "## S2: Alpha @v1 [published]",
    "## S3: Mid @v2 [proposed]",
  ]);
});

test("a file written before the numbers reads by name, then version", () => {
  expect(names(parseFeature(LEGACY_UNSORTED))).toEqual(["Alpha", "Mid", "Zed"]);
  expect(names(parseFeature(LEGACY))).toEqual(["Alpha", "Mid", "Zed"]);
  // and gains its numbers in that order when written
  expect(headings(serializeFeature(parseFeature(LEGACY_UNSORTED)))).toEqual([
    "## S1: Alpha @v1 [published]",
    "## S2: Mid @v2 [proposed]",
    "## S3: Zed @v1 [proposed]",
  ]);
});

test("serialize renumbers by position and is a fixed point on numbered text", () => {
  const f = parseFeature(NUMBERED);
  expect(serializeFeature(f)).toBe(NUMBERED);
  expect(parseFeature(serializeFeature(f))).toEqual(f);
  // a draft is never written, so the numbers skip it
  const withDraft: Feature = {
    ...f,
    scenarios: [f.scenarios[0]!, { name: "Idea", version: 1, status: "draft", body: "", tests: [] }, f.scenarios[1]!],
  };
  expect(headings(serializeFeature(withDraft))).toEqual([
    "## S1: Zed @v1 [proposed]",
    "## Idea @v1 [draft]",
    "## S2: Alpha @v1 [published]",
  ]);
});

test("the numbers option off writes the legacy form in the legacy order", () => {
  expect(serializeFeature(parseFeature(NUMBERED), { numbers: false })).toBe(LEGACY);
});

test("a text of drafts alone — the editor's wire form — keeps its order too", () => {
  const text = "# F\n\n## Zed @v1 [draft]\n\nz\n\n## Alpha @v1 [draft]\n\na\n";
  expect(names(parseFeature(text))).toEqual(["Zed", "Alpha"]);
  expect(serializeFeature(parseFeature(text))).toBe(text);
});

test("a status rewrite keeps the position prefix", () => {
  const text = "# F\n\n## S1: Zed @v1\n\nzed\n\n## S2: Alpha @v1 [published]\n\nalpha\n";
  expect(headings(markProposed(text))).toEqual([
    "## S1: Zed @v1 [proposed]",
    "## S2: Alpha @v1 [published]",
  ]);
});

test("a name that itself begins with a number prefix round-trips through a numbered heading", () => {
  const f: Feature = {
    name: "F",
    description: "",
    scenarios: [{ name: "S1: Rollback", version: 1, status: "proposed", body: "", tests: [] }],
  };
  const text = serializeFeature(f);
  expect(headings(text)).toEqual(["## S1: S1: Rollback @v1 [proposed]"]);
  expect(names(parseFeature(text))).toEqual(["S1: Rollback"]);
});

// --- the document ----------------------------------------------------------

test("orderSpecs sorts by rank, unranked last, then name and version", () => {
  const specs = [
    { name: "B", version: 1 },
    { name: "A", version: 2, rank: 2 },
    { name: "A", version: 1 },
    { name: "C", version: 1, rank: 1 },
  ];
  expect(orderSpecs(specs).map((s) => `${s.name}@v${s.version}`)).toEqual(["C@v1", "A@v2", "A@v1", "B@v1"]);
  expect(compareSpecs({ name: "A", version: 1 }, { name: "A", version: 1 })).toBe(0);
});

test("an imported document ranks its specs in file order and projects them numbered the same way", () => {
  const doc = importFeatureDoc(parseFeature(NUMBERED));
  expect(doc.specs.map((s) => [s.name, s.rank])).toEqual([["Zed", 1], ["Alpha", 2], ["Mid", 3]]);
  expect(names(docToFeature(doc))).toEqual(["Zed", "Alpha", "Mid"]);
  expect(projectFeature(doc)).toBe(NUMBERED);
});

test("a document from before the ranks orders by name until a reconcile stamps it", () => {
  const doc = importFeatureDoc(parseFeature(NUMBERED));
  const legacy = reconcile(doc, parseFeature(NUMBERED));
  // simulate a document that never had ranks
  const unranked = importFeatureDoc(parseFeature(LEGACY));
  expect(names(docToFeature(unranked))).toEqual(["Alpha", "Mid", "Zed"]);
  expect(legacy.specs.map((s) => s.rank)).toEqual([1, 2, 3]);
});

test("reconcile stamps the target's order as ranks, and a move stamps the feature, not its scenarios", () => {
  const doc = importFeatureDoc(parseFeature(NUMBERED));
  const moved = parseFeature(NUMBERED);
  moved.scenarios = [moved.scenarios[2]!, moved.scenarios[0]!, moved.scenarios[1]!];
  const next = reconcile(doc, moved, { author: "ann" });
  expect(headings(projectFeature(next))).toEqual([
    "## S1: Mid @v2 [proposed]",
    "## S2: Zed @v1 [proposed]",
    "## S3: Alpha @v1 [published]",
  ]);
  // the list itself is not spliced: the entries keep their objects and ids
  expect(next.specs.map((s) => s.name)).toEqual(["Zed", "Alpha", "Mid"]);
  expect(next.specs.map((s) => s.id)).toEqual(doc.specs.map((s) => s.id));
  expect(next.specs.map((s) => s.rank)).toEqual([2, 3, 1]);
  expect(next.specs.every((s) => s.updatedBy === undefined)).toBe(true);
  expect(next.updatedBy).toBe("ann");
  // and a reconcile that changes nothing stamps nobody
  const again = reconcile(next, docToFeature(next), { author: "bob" });
  expect(again.updatedBy).toBe("ann");
});

test("a draft keeps its place among the scenarios across a markdown-derived reorder", () => {
  const doc = importFeatureDoc(parseFeature("# F\n\n## S1: A @v1 [proposed]\n\na\n\n## S2: B @v1 [proposed]\n\nb\n"));
  // The editor saves a draft between A and B (the [draft] chip is the wire form).
  const withDraft = reconcile(
    doc,
    parseFeature("# F\n\n## S1: A @v1 [proposed]\n\na\n\n## D @v1 [draft]\n\nd\n\n## S2: B @v1 [proposed]\n\nb\n"),
  );
  expect(names(docToFeature(withDraft))).toEqual(["A", "D", "B"]);
  expect(projectFeature(withDraft)).toBe("# F\n\n## S1: A @v1 [proposed]\n\na\n\n## S2: B @v1 [proposed]\n\nb\n");
  // A hand edit of the file swaps A and B: the draft, which the file cannot
  // see, stays right after A.
  const swapped = reconcile(withDraft, parseFeature("# F\n\n## S1: B @v1 [proposed]\n\nb\n\n## S2: A @v1 [proposed]\n\na\n"));
  expect(names(docToFeature(swapped))).toEqual(["B", "A", "D"]);
});

test("interleaveDrafts places each draft after the nearest held entry before it", () => {
  const key = (s: string) => s;
  expect(interleaveDrafts(["b", "a"], ["d0", "a", "d1", "d2", "b", "d3"], key)).toEqual([
    "d0", "b", "d3", "a", "d1", "d2",
  ]);
  expect(interleaveDrafts(["a"], [], key)).toEqual(["a"]);
  expect(interleaveDrafts([], ["d"], key)).toEqual(["d"]);
});

test("two peers moving scenarios concurrently converge on one order", () => {
  const base = importFeatureDoc(parseFeature(NUMBERED));
  const ours = parseFeature(NUMBERED);
  ours.scenarios = [ours.scenarios[1]!, ours.scenarios[0]!, ours.scenarios[2]!]; // Alpha, Zed, Mid
  const theirs = parseFeature(NUMBERED);
  theirs.scenarios = [theirs.scenarios[2]!, theirs.scenarios[1]!, theirs.scenarios[0]!]; // Mid, Alpha, Zed
  const left = reconcile(A.clone(base), ours);
  const right = reconcile(A.clone(base), theirs);
  const mergedLeft = A.merge(A.clone(left), right);
  const mergedRight = A.merge(A.clone(right), left);
  expect(projectFeature(mergedLeft)).toBe(projectFeature(mergedRight));
  // the next reconcile normalizes the ranks to 1..N in that order
  const settled = reconcile(mergedLeft, parseFeature(projectFeature(mergedLeft)));
  expect(orderSpecs(settled.specs).map((s) => s.rank)).toEqual([1, 2, 3]);
});

test("the legacy numberless file is a projection of a rank-less document, so it is not drift", () => {
  const doc = importFeatureDoc(parseFeature(LEGACY));
  expect(isProjectionOf(LEGACY, doc)).toBe(true);
  expect(isProjectionOf(serializeFeature(parseFeature(LEGACY)), doc)).toBe(true);
  expect(isProjectionOf(LEGACY.replace("zed", "zed!"), doc)).toBe(false);
  // a numberless file out of the legacy order was never the projection
  expect(isProjectionOf(LEGACY_UNSORTED, doc)).toBe(false);
});

// --- the merge -------------------------------------------------------------

test("mergeOrder lets the side that moved win, ours when both did, and keeps the other side's additions next to where it put them", () => {
  const kept = new Set(["A", "B", "C", "D"]);
  expect(mergeOrder(["A", "B", "C"], ["C", "A", "B"], ["A", "B", "C", "D"], kept)).toEqual(["C", "D", "A", "B"]);
  expect(mergeOrder(["A", "B", "C"], ["A", "B", "C"], ["C", "A", "B"], new Set(["A", "B", "C"]))).toEqual(["C", "A", "B"]);
  expect(mergeOrder(["A", "B", "C"], ["B", "A", "C"], ["C", "B", "A"], new Set(["A", "B", "C"]))).toEqual(["B", "A", "C"]);
  // a deletion on one side does not read as a move on the other
  expect(mergeOrder(["A", "B", "C"], ["A", "C"], ["C", "A", "B"], new Set(["A", "C"]))).toEqual(["C", "A"]);
});

test("threeWayFeature keeps a reorder made on one side", () => {
  const base = parseFeature(NUMBERED);
  const ours = parseFeature(NUMBERED);
  ours.scenarios = [ours.scenarios[2]!, ours.scenarios[0]!, ours.scenarios[1]!];
  const theirs = parseFeature(NUMBERED.replace("alpha", "alpha, edited there"));
  const r = threeWayFeature(base, ours, theirs);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(names(r.feature)).toEqual(["Mid", "Zed", "Alpha"]);
  expect(r.feature.scenarios[2]!.body).toBe("alpha, edited there");
});

// --- the editor's view and the sync tick ------------------------------------

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-order-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a save in a new order writes the file renumbered, and the editor reads it back in that order", async () => {
  const file = await createFeature(root, "Quote Policy", NUMBERED);
  const moved = parseFeature(NUMBERED);
  moved.scenarios = [moved.scenarios[1]!, moved.scenarios[2]!, moved.scenarios[0]!];
  await saveFeature(root, file, serializeFeature(moved));
  expect(headings((await readFeature(root, file))!)).toEqual([
    "## S1: Alpha @v1 [published]",
    "## S2: Mid @v2 [proposed]",
    "## S3: Zed @v1 [proposed]",
  ]);
  const view = (await readFeatureView(root, file))!;
  expect(names(view.parsed)).toEqual(["Alpha", "Mid", "Zed"]);
  // a draft saved between two scenarios shows there, unnumbered in the file
  const withDraft = { ...view.parsed, scenarios: [...view.parsed.scenarios] };
  withDraft.scenarios.splice(1, 0, { name: "Idea", version: 1, status: "draft", body: "idea", tests: [] });
  await saveFeature(root, file, serializeFeature(withDraft));
  expect(headings((await readFeature(root, file))!)).toEqual([
    "## S1: Alpha @v1 [published]",
    "## S2: Mid @v2 [proposed]",
    "## S3: Zed @v1 [proposed]",
  ]);
  const again = (await readFeatureView(root, file))!;
  expect(names(again.parsed)).toEqual(["Alpha", "Idea", "Mid", "Zed"]);
  expect(headings(again.content)).toEqual([
    "## S1: Alpha @v1 [published]",
    "## Idea @v1 [draft]",
    "## S2: Mid @v2 [proposed]",
    "## S3: Zed @v1 [proposed]",
  ]);
});

test("the sync tick leaves a file from before the numbers alone until it is saved", async () => {
  const file = "specs/legacy.feature.md";
  await Bun.write(join(root, file), LEGACY);
  await importDrift(root);
  await importDrift(root);
  expect(await readFeature(root, file)).toBe(LEGACY);
  expect(await loadFeatureDoc(root, file)).not.toBeNull();
  // read in the legacy order, numbered that way in the editor's view
  const view = (await readFeatureView(root, file))!;
  expect(names(view.parsed)).toEqual(["Alpha", "Mid", "Zed"]);
  // the first save numbers it
  await saveFeature(root, file, serializeFeature({ ...view.parsed, description: "Quotes." }));
  expect(headings((await readFeature(root, file))!)).toEqual([
    "## S1: Alpha @v1 [published]",
    "## S2: Mid @v2 [proposed]",
    "## S3: Zed @v1 [proposed]",
  ]);
  // and a hand edit that moves a heading is read in its new place, renumbered
  const text = (await readFeature(root, file))!;
  const hand = text.replace("## S2: Mid @v2 [proposed]\n\nmid\n\n", "") + "\n## S2: Mid @v2 [proposed]\n\nmid\n";
  await Bun.write(join(root, file), hand);
  await importDrift(root);
  expect(headings((await readFeature(root, file))!)).toEqual([
    "## S1: Alpha @v1 [published]",
    "## S2: Zed @v1 [proposed]",
    "## S3: Mid @v2 [proposed]",
  ]);
});
