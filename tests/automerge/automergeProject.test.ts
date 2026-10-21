// Projection and reconciliation: markdown is a deterministic projection of
// the Automerge doc, reconciliation drives the doc toward a parsed Feature,
// concurrent doc edits survive a reconcile, and published scenarios are
// immutable through the reconciliation door too.

import { test, expect } from "bun:test";
import * as A from "@automerge/automerge";
import { parseFeature, serializeFeature } from "../../src/server/parser";
import { docToFeature, projectFeature } from "../../src/server/automerge/project";
import { healPublished, importFeatureDoc, reconcile } from "../../src/server/automerge/reconcile";
import { snapshotOf } from "../../src/server/automerge/schema";

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

// A status marker edited down is the two-step way around the body check: a
// demoted scenario is free to change (or, as a doc-only draft, to drop out of
// the markdown) and to be published again under the same version.
test("reconcile refuses to demote a published scenario", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  for (const status of ["proposed", "draft"]) {
    const demoted = parseFeature(SAMPLE.replace("@v2 [published]", `@v2 [${status}]`));
    expect(() => reconcile(doc, demoted)).toThrow(/published and immutable/);
  }
  expect(docToFeature(doc).scenarios.find((s) => s.name === "Declined Quote")!.status).toBe(
    "published",
  );
});

test("only a forced reconcile may demote a published scenario", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE.replace("@v2 [published]", "@v2 [proposed]"));
  const next = reconcile(doc, target, { force: true });
  expect(next.specs.find((e) => e.name === "Declined Quote")!.status).toBe("proposed");
});

// Publishing records the body (schema.ts publishedBody), as a scalar rather
// than collaborative text, so concurrent publishes resolve to one body.
test("publishing records the body as an immutable string", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const published = doc.specs.find((e) => e.name === "Declined Quote")!;
  expect(A.isImmutableString(published.publishedBody)).toBe(true);
  expect(snapshotOf(published)).toBe(published.body);
  expect(doc.specs.find((e) => e.name === "Basic Quote")!.publishedBody).toBeUndefined();

  const next = reconcile(doc, parseFeature(SAMPLE.replace("@v1 [proposed]", "@v1 [published]")));
  const basic = next.specs.find((e) => e.name === "Basic Quote")!;
  expect(A.isImmutableString(basic.publishedBody)).toBe(true);
  expect(snapshotOf(basic)).toBe(basic.body);
});

// Two peers absorbing the same markdown edit each splice it in, and the CRDT
// merge keeps both copies. The entry is held to and rendered as its recorded
// body, so the merged file still reads as a projection, the gate still
// passes, and the live text heals.
function doubled() {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const i = doc.specs.findIndex((e) => e.name === "Declined Quote");
  const merged = A.change(doc, (d) => {
    A.splice(d, ["specs", i, "body"], d.specs[i]!.body.length, 0, "\n- **Then** the quote is declined");
  });
  expect(merged.specs[i]!.body).not.toBe(snapshotOf(merged.specs[i]!));
  return { merged, i };
}

test("a published spec projects its recorded body, not a live text a merge doubled", () => {
  const { merged, i } = doubled();
  expect(projectFeature(merged)).toBe(serializeFeature(parseFeature(SAMPLE)));
  expect(docToFeature(merged).scenarios.find((s) => s.name === "Declined Quote")!.body).toBe(
    snapshotOf(merged.specs[i]!)!,
  );
});

test("reconciling a doubled published spec against its own projection heals it", () => {
  const { merged, i } = doubled();
  const next = reconcile(merged, parseFeature(projectFeature(merged)));
  expect(next.specs[i]!.body).toBe(snapshotOf(merged.specs[i]!)!);
  expect(next.specs[i]!.status).toBe("published");
  expect(snapshotOf(next.specs[i]!)).toBe(snapshotOf(merged.specs[i]!));
});

test("healPublished drives a doubled live body back and is otherwise a no-op", () => {
  const { merged, i } = doubled();
  const healed = healPublished(merged);
  expect(healed.specs[i]!.body).toBe(snapshotOf(merged.specs[i]!)!);
  expect(projectFeature(healed)).toBe(projectFeature(merged));
  // Tidy already: the very same doc comes back, nothing minted.
  expect(healPublished(healed)).toBe(healed);
  const tidy = importFeatureDoc(parseFeature(SAMPLE));
  expect(healPublished(tidy)).toBe(tidy);
});

test("a changed body still fails the gate on a doubled published spec", () => {
  const { merged } = doubled();
  const tampered = parseFeature(SAMPLE.replace("the quote is declined", "the quote is accepted"));
  expect(() => reconcile(merged, tampered)).toThrow(/published and immutable/);
});

test("a forced reconcile re-records a changed published body and a demotion clears the record", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const rewritten = reconcile(
    A.clone(doc),
    parseFeature(SAMPLE.replace("the quote is declined", "the quote is accepted")),
    { force: true },
  );
  const entry = rewritten.specs.find((e) => e.name === "Declined Quote")!;
  expect(entry.body).toContain("the quote is accepted");
  expect(snapshotOf(entry)).toBe(entry.body);

  const demoted = reconcile(A.clone(doc), parseFeature(SAMPLE.replace("@v2 [published]", "@v2 [proposed]")), {
    force: true,
  });
  expect(demoted.specs.find((e) => e.name === "Declined Quote")!.publishedBody).toBeUndefined();
});

// An entry published before the key existed is held to its live body until
// its first reconcile records it — one op, once.
test("a published entry without a recorded body is stamped by its first reconcile", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const legacy = A.change(doc, (d) => {
    delete d.specs.find((e) => e.name === "Declined Quote")!.publishedBody;
  });
  expect(snapshotOf(legacy.specs.find((e) => e.name === "Declined Quote")!)).toBeUndefined();
  expect(healPublished(legacy)).toBe(legacy);

  const once = reconcile(legacy, parseFeature(projectFeature(legacy)));
  const stamped = once.specs.find((e) => e.name === "Declined Quote")!;
  expect(snapshotOf(stamped)).toBe(stamped.body);
  const twice = reconcile(once, parseFeature(projectFeature(once)));
  expect(A.getHeads(twice)).toEqual(A.getHeads(once));
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

// Draft scenarios are doc-only (specs/datastore/automerge-store.feature.md):
// they enter the document like any other scenario but the projection leaves
// them out of the `.feature.md`.
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
// (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
// Scenario Twice"): title and body both retyped since the tick that placed the
// draft, so the body pass cannot see a rename — the id claim renames the entry
// in place, and nothing lingers under the old name.
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

// The editor may name the scenario with a stray space (issue #173): the
// target's headings parse trimmed, and the claim matches them the same way,
// so the entry is still renamed in place rather than filed a second time.
test("an id claim with a stray space in the name still renames in place", () => {
  const withDraft = parseFeature(SAMPLE + "\n## Idea @v1 [proposed]\n\nsketch\n");
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), withDraft);
  const id = doc.specs.find((s) => s.name === "Idea")!.id;
  const renamed = parseFeature(SAMPLE + "\n## Better Idea @v1 [proposed]\n\nsketch, written out\n");
  const next = reconcile(doc, renamed, { scenario: { id, name: "Better Idea ", version: 1 } });
  const ideas = next.specs.filter((s) => s.name.includes("Idea"));
  expect(ideas.map((s) => [s.name, s.version, s.body, s.id])).toEqual([
    ["Better Idea", 1, "sketch, written out", id],
  ]);
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
