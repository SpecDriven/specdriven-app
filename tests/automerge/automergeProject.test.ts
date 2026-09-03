// Projection and reconciliation: markdown is a deterministic projection of
// the Automerge doc, reconciliation drives the doc toward a parsed Feature,
// concurrent doc edits survive a reconcile, and published scenarios are
// immutable through the reconciliation door too.

import { test, expect } from "bun:test";
import * as A from "@automerge/automerge";
import { parseFeature, serializeFeature } from "../../src/server/parser";
import { docToFeature, projectFeature } from "../../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../../src/server/automerge/reconcile";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **When** the customer requests a quote
- **Then** a quote is provided

[test: https://github.com/acme/repo/blob/main/quote.test.ts ]

## Declined Quote @v2 [published]

- **Given** the customer has no account
- **Then** the quote is declined
`;

test("import then project is a fixpoint of the canonical serialization", () => {
  const feature = parseFeature(SAMPLE);
  const doc = importFeatureDoc(feature);
  expect(projectFeature(doc)).toBe(serializeFeature(feature));
  expect(docToFeature(doc)).toEqual(feature);
});

test("reconcile drives the projection to the target text", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const edited = SAMPLE.replace("a quote is provided", "a quote is emailed");
  const next = reconcile(doc, parseFeature(edited));
  expect(projectFeature(next)).toBe(serializeFeature(parseFeature(edited)));
});

test("reconcile is idempotent — a second pass changes nothing", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE.replace("Quotes for", "Insurance quotes for"));
  const once = reconcile(doc, target);
  const heads = A.getHeads(once);
  const twice = reconcile(once, target);
  expect(A.getHeads(twice)).toEqual(heads);
});

// The reason reconcile uses updateText rather than assignment: an edit
// arriving as a whole file merges with a concurrent CRDT edit to the same
// body instead of overwriting it.
test("a reconciled edit merges with a concurrent doc edit", () => {
  const base = importFeatureDoc(parseFeature(SAMPLE));

  const reconciled = reconcile(
    A.clone(base),
    parseFeature(SAMPLE.replace("a quote is provided", "a quote is provided within a day")),
  );
  const concurrent = A.change(A.clone(base), (d) => {
    const i = d.specs.findIndex((s) => s.name === "Basic Quote");
    A.splice(d, ["specs", i, "body"], 0, 0, "- **Given** a sunny day\n");
  });

  const merged = docToFeature(A.merge(reconciled, concurrent));
  const body = merged.scenarios.find((s) => s.name === "Basic Quote")!.body;
  expect(body).toContain("within a day");
  expect(body).toContain("a sunny day");
});

test("reconcile refuses to change a published body", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const tampered = parseFeature(SAMPLE.replace("the quote is declined", "the quote is accepted"));
  expect(() => reconcile(doc, tampered)).toThrow(/published and immutable/);
});

test("reconcile refuses to drop a published scenario", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE);
  target.scenarios = target.scenarios.filter((s) => s.status !== "published");
  expect(() => reconcile(doc, target)).toThrow(/published and immutable/);
});

test("tests links on a published scenario may still change", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE);
  target.scenarios.find((s) => s.status === "published")!.tests = [
    "https://github.com/acme/repo/blob/main/declined.test.ts",
  ];
  const next = reconcile(doc, target);
  expect(docToFeature(next).scenarios.find((s) => s.status === "published")!.tests).toEqual([
    "https://github.com/acme/repo/blob/main/declined.test.ts",
  ]);
});

test("a rename with an unchanged body keeps the scenario's identity", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const idBefore = doc.specs.find((s) => s.name === "Basic Quote")!.id;
  const renamed = parseFeature(SAMPLE.replace("## Basic Quote @v1", "## Fast Quote @v1"));
  const next = reconcile(doc, renamed);
  const after = next.specs.find((s) => s.name === "Fast Quote")!;
  expect(after.id).toBe(idBefore);
});

test("added and removed scenarios reconcile", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(
    SAMPLE.replace(
      "## Basic Quote @v1 [proposed]",
      "## Basic Quote @v1 [proposed]\n\nintro\n\n## Renewal Quote @v1 [proposed]",
    ),
  );
  const next = reconcile(doc, target);
  expect(projectFeature(next)).toBe(serializeFeature(target));
  expect(next.specs.some((s) => s.name === "Renewal Quote")).toBe(true);
});

// Draft scenarios are doc-only (specs/automerge-store.spec.md): they enter
// the document like any other scenario but the projection leaves them out of
// the `.feature.md`.
test("a draft scenario lands in the doc but stays out of the projection", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE + "\n## Idea @v1\n\nsketch\n");
  expect(target.scenarios.find((s) => s.name === "Idea")!.status).toBe("draft");
  const next = reconcile(doc, target);
  expect(next.specs.find((s) => s.name === "Idea")!.status).toBe("draft");
  expect(projectFeature(next)).not.toContain("Idea");
  expect(projectFeature(next)).toBe(serializeFeature(parseFeature(SAMPLE)));
});

// What markdown cannot see it must not delete: a markdown-derived target
// without the draft reconciles without dropping it.
test("reconcile keeps a doc-only draft the target does not mention", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Idea @v1\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const next = reconcile(doc, parseFeature(SAMPLE.replace("Quotes for", "Insurance quotes for")));
  const draft = next.specs.find((s) => s.name === "Idea");
  expect(draft).toBeDefined();
  expect(draft!.status).toBe("draft");
  expect(projectFeature(next)).not.toContain("Idea");
});

// A [proposed] chip on the draft's (name, version) in the markdown promotes
// the existing entry in place — same id, now projected.
test("a draft promotes to proposed when the markdown claims it", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Idea @v1\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const idBefore = doc.specs.find((s) => s.name === "Idea")!.id;
  const promoted = parseFeature(SAMPLE + "\n## Idea @v1 [proposed]\n\nsketch\n");
  const next = reconcile(doc, promoted);
  const after = next.specs.find((s) => s.name === "Idea")!;
  expect(after.id).toBe(idBefore);
  expect(after.status).toBe("proposed");
  expect(projectFeature(next)).toContain("## Idea @v1 [proposed]");
});

// The editor names the scenario it is saving by the document's id for it
// (specs/editor-autosave.feature.md "Autosave Never Adds the Same Scenario
// Twice"): title and body both retyped since the tick that placed the draft,
// so the body pass cannot see a rename — the id claim renames the entry in
// place, and nothing lingers under the old name.
test("a scenario claimed by its document id is renamed in place even with a new body", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Idea @v1\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const id = doc.specs.find((s) => s.name === "Idea")!.id;
  const renamed = parseFeature(SAMPLE + "\n## Better Idea @v1\n\nsketch, written out\n");
  const next = reconcile(doc, renamed, { scenario: { id, name: "Better Idea", version: 1 } });
  const drafts = next.specs.filter((s) => s.status === "draft");
  expect(drafts.map((s) => [s.name, s.body, s.id])).toEqual([
    ["Better Idea", "sketch, written out", id],
  ]);
  expect(projectFeature(next)).toBe(serializeFeature(parseFeature(SAMPLE)));
});

// The claim also covers a version re-derived from the new name, and the
// publish of that entry in the same save — the dialog's Publish.
test("the id claim may change the version and the status at once", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Declined Quote @v3\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const id = doc.specs.find((s) => s.name === "Declined Quote" && s.version === 3)!.id;
  const published = parseFeature(SAMPLE + "\n## Idea @v1 [published]\n\nfinal\n");
  const next = reconcile(doc, published, { scenario: { id, name: "Idea", version: 1 } });
  expect(next.specs.filter((s) => s.status === "draft")).toEqual([]);
  const after = next.specs.find((s) => s.name === "Idea")!;
  expect([after.id, after.version, after.status, after.body]).toEqual([id, 1, "published", "final"]);
  expect(projectFeature(next)).toBe(serializeFeature(published));
});

// A claim that no longer fits is ignored rather than acted on: the id is gone
// from the doc, the target has no scenario of that name and version, another
// entry already carries that identity, or the entry is published — whose
// identity no editor may move. (Each case reconciles its own clone — Automerge
// refuses a second change on a handle that has already been changed.)
test("an id claim that no longer applies changes nothing", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Idea @v1\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const ids = Object.fromEntries(doc.specs.map((s) => [s.name, s.id]));
  const shape = (d: typeof doc) => d.specs.map((s) => [s.name, s.version, s.status, s.id]);

  // The id is gone from the doc (the entry was deleted, or was never this doc's).
  const gone = reconcile(A.clone(doc), withDraft, {
    scenario: { id: "not-here", name: "Idea", version: 1 },
  });
  expect(shape(gone)).toEqual(shape(doc));

  // The target has no scenario of that name and version.
  const missing = reconcile(A.clone(doc), withDraft, {
    scenario: { id: ids["Idea"]!, name: "Elsewhere", version: 1 },
  });
  expect(shape(missing)).toEqual(shape(doc));

  // Another entry already carries that identity: it keeps it, and the draft stays.
  const taken = reconcile(A.clone(doc), parseFeature(SAMPLE), {
    scenario: { id: ids["Idea"]!, name: "Basic Quote", version: 1 },
  });
  expect(taken.specs.find((s) => s.name === "Basic Quote")!.id).toBe(ids["Basic Quote"]!);
  expect(taken.specs.find((s) => s.name === "Idea")!.status).toBe("draft");

  // A published entry keeps its identity: the next version drafted from it is
  // a new scenario, even if the editor were to send the source's id.
  const nextVersion = parseFeature(SAMPLE + "\n## Declined Quote @v3\n\nsketch\n");
  const drafted = reconcile(A.clone(doc), nextVersion, {
    scenario: { id: ids["Declined Quote"]!, name: "Declined Quote", version: 3 },
  });
  const declined = drafted.specs.filter((s) => s.name === "Declined Quote");
  expect(declined.map((s) => [s.version, s.status])).toEqual([
    [2, "published"],
    [3, "draft"],
  ]);
  expect(declined[0]!.id).toBe(ids["Declined Quote"]!);
  expect(declined[1]!.id).not.toBe(ids["Declined Quote"]!);
});
