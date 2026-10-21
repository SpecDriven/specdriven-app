// Two peers, one origin, real git transport (tests/helpers/fixtures.ts): the
// Automerge documents ride the repo alongside the markdown projections, and
// one sync tick (reload.ts syncDataDir) merges concurrent work that used to
// need the conflict dialog. Also: markdown-only edits (older app versions,
// GitHub) are absorbed, published tampering is repaired, deletions win.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureDoc, saveFeatureDoc } from "../../src/server/automerge/store";
import { importDrift } from "../../src/server/automerge/driftSync";
import { projectFeature } from "../../src/server/automerge/project";
import { snapshotOf } from "../../src/server/automerge/schema";
import * as A from "@automerge/automerge";
import { moveScenario, publishFeature, readFeature, saveFeature } from "../../src/server/features";
import { conflictedFiles } from "../../src/server/git";
import { syncDataDir } from "../../src/server/reload";
import { git, stopServers, twoClones } from "../helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-amsync-"));
});

afterEach(async () => {
  stopServers();
  await rm(root, { recursive: true, force: true });
});

const SEED = "# Seed\n\n## Story @v1 [proposed]\n\n- line one\n- line two\n";

/** Both clones with the seed feature already imported into a shared doc. */
async function seededClones() {
  const clones = await twoClones(root, { "specs/seed.feature.md": SEED });
  await syncDataDir(clones.a); // imports the seed into a doc and pushes it
  await syncDataDir(clones.b); // pulls the doc: both peers share one lineage
  return clones;
}

/**
 * Two cron ticks, like the real 60s loop needs after a local save: the first
 * refuses to pull over the dirty file and just commits (and its push may be
 * rejected), the second pulls, auto-merges and pushes.
 */
async function settle(dir: string) {
  await syncDataDir(dir);
  await syncDataDir(dir);
}

test("concurrent edits to the same scenario merge with no conflict dialog", async () => {
  const { a, b } = await seededClones();

  // Both peers edit the same line of the same scenario body.
  await saveFeature(a, "specs/seed.feature.md", SEED.replace("- line one", "- line one, from A"));
  await saveFeature(b, "specs/seed.feature.md", SEED.replace("- line one", "- (B) line one"));

  await syncDataDir(a); // pushes A's markdown and ops
  await settle(b); // pull conflicts on the markdown; the doc auto-merges
  expect(await conflictedFiles(b)).toEqual([]);
  await syncDataDir(a); // A pulls the merge back

  const mdA = await readFeature(a, "specs/seed.feature.md");
  const mdB = await readFeature(b, "specs/seed.feature.md");
  expect(mdA).toBe(mdB!);
  expect(mdA).toContain("from A");
  expect(mdA).toContain("(B) line one");
  const docA = (await loadFeatureDoc(a, "specs/seed.feature.md"))!;
  const docB = (await loadFeatureDoc(b, "specs/seed.feature.md"))!;
  expect(projectFeature(docA.doc)).toBe(mdA!);
  expect(projectFeature(docB.doc)).toBe(mdB!);
});

test("a concurrent first import (two minted lineages) converges", async () => {
  const clones = await twoClones(root, { "specs/seed.feature.md": "# Seed\n" });
  const { a, b } = clones;

  // Neither peer has pulled the other's doc: both mint one for the seed.
  await saveFeature(a, "specs/seed.feature.md", "# Seed\n\n## From A @v1\n\nalpha\n");
  await saveFeature(b, "specs/seed.feature.md", "# Seed\n\n## From B @v1\n\nbeta\n");
  await syncDataDir(a);
  await settle(b); // conflicted markdown and docid; both lineages fold
  expect(await conflictedFiles(b)).toEqual([]);
  await syncDataDir(a);

  const mdA = await readFeature(a, "specs/seed.feature.md");
  expect(mdA).toBe((await readFeature(b, "specs/seed.feature.md"))!);
  expect(mdA).toContain("## From A @v1");
  expect(mdA).toContain("## From B @v1");
  const docA = (await loadFeatureDoc(a, "specs/seed.feature.md"))!;
  const docB = (await loadFeatureDoc(b, "specs/seed.feature.md"))!;
  expect(docA.doc.id).toBe(docB.doc.id);
  expect(docA.docId).toBe(docA.doc.id); // the docid file records the winner
});

test("a markdown-only edit from an old-version peer is absorbed three-way", async () => {
  const { a, b } = await seededClones();

  // A (this app version) edits one line locally; B simulates an old app
  // version: plain markdown commit, no chunk files touched.
  await saveFeature(a, "specs/seed.feature.md", SEED.replace("- line two", "- line two, from A"));
  await Bun.write(join(b, "specs/seed.feature.md"), SEED.replace("- line one", "- line one, from B"));
  await git(b, "add", "specs/seed.feature.md");
  await git(b, "commit", "-m", "old-version edit");
  await git(b, "push");

  await settle(a); // pull conflicts; B's edit has no ops: three-way merge
  expect(await conflictedFiles(a)).toEqual([]);
  const mdA = await readFeature(a, "specs/seed.feature.md");
  expect(mdA).toContain("line two, from A");
  expect(mdA).toContain("line one, from B");
  expect(projectFeature((await loadFeatureDoc(a, "specs/seed.feature.md"))!.doc)).toBe(mdA!);
});

test("external drift is absorbed into the doc on a clean pull", async () => {
  const { a, b } = await seededClones();

  // B pushes a markdown-only change; A has no local edits, so the pull is a
  // clean fast-forward and the drift pass absorbs it into the doc.
  await Bun.write(join(b, "specs/seed.feature.md"), SEED.replace("- line two", "- line two, edited on GitHub"));
  await git(b, "add", "specs/seed.feature.md");
  await git(b, "commit", "-m", "external edit");
  await git(b, "push");

  await syncDataDir(a);
  const doc = (await loadFeatureDoc(a, "specs/seed.feature.md"))!.doc;
  expect(doc.specs[0]!.body).toContain("edited on GitHub");
  expect(projectFeature(doc)).toBe((await readFeature(a, "specs/seed.feature.md"))!);
});

// A hand edit may add a chipless heading; it parses as a draft, and drafts
// are doc-only — the scenario is absorbed into the document while the
// projection rewrites the file without it.
test("a chipless hand-added scenario is absorbed as a doc-only draft", async () => {
  const { a, b } = await seededClones();

  await Bun.write(join(b, "specs/seed.feature.md"), SEED + "\n## Sketch @v1\n\nan idea\n");
  await git(b, "add", "specs/seed.feature.md");
  await git(b, "commit", "-m", "hand-added draft");
  await git(b, "push");

  await syncDataDir(a);
  const doc = (await loadFeatureDoc(a, "specs/seed.feature.md"))!.doc;
  expect(doc.specs.find((s) => s.name === "Sketch")?.status).toBe("draft");
  const md = await readFeature(a, "specs/seed.feature.md");
  expect(md).not.toContain("Sketch");
  expect(projectFeature(doc)).toBe(md!);
});

test("drift that tampers with a published scenario is repaired from the doc", async () => {
  const { a, b } = await seededClones();
  await publishFeature(a, "specs/seed.feature.md", (await readFeature(a, "specs/seed.feature.md"))!);
  await syncDataDir(a);
  await syncDataDir(b);
  const published = await readFeature(a, "specs/seed.feature.md");
  expect(published).toContain("[published]");

  // B rewrites the published body directly in the markdown.
  await Bun.write(join(b, "specs/seed.feature.md"), published!.replace("- line one", "- tampered"));
  await git(b, "add", "specs/seed.feature.md");
  await git(b, "commit", "-m", "tamper");
  await git(b, "push");

  await syncDataDir(a); // drift refused: the file is repaired from the doc
  expect(await readFeature(a, "specs/seed.feature.md")).toBe(published!);
  await syncDataDir(b); // the repair propagates back
  expect(await readFeature(b, "specs/seed.feature.md")).toBe(published!);
});

test("drift that demotes a published scenario is repaired from the doc", async () => {
  const { a, b } = await seededClones();
  await publishFeature(a, "specs/seed.feature.md", (await readFeature(a, "specs/seed.feature.md"))!);
  await syncDataDir(a);
  await syncDataDir(b);
  const published = (await readFeature(a, "specs/seed.feature.md"))!;

  // Demoted to a draft the scenario would drop out of the markdown; demoted to
  // proposed its body could then be rewritten and published again as v1.
  for (const status of ["draft", "proposed"]) {
    await Bun.write(join(b, "specs/seed.feature.md"), published.replace("[published]", `[${status}]`));
    await git(b, "commit", "-qam", `demote to ${status}`);
    await git(b, "push");

    await syncDataDir(a);
    expect(await readFeature(a, "specs/seed.feature.md")).toBe(published);
    expect((await loadFeatureDoc(a, "specs/seed.feature.md"))!.doc.specs[0]!.status).toBe("published");
    await syncDataDir(b);
    expect(await readFeature(b, "specs/seed.feature.md")).toBe(published);
  }
});

// The two-step way around the body check, run by the drift pass alone:
// demote to proposed, then rewrite the body and publish it again as v1. The
// demotion is refused and repaired, so the rewrite still meets a published v1.
test("drift that demotes, edits, then republishes is repaired from the doc", async () => {
  const file = "specs/billing.feature.md";
  const dir = join(root, "data");
  await Bun.write(
    join(dir, file),
    "# Billing\n\n## Refund @v1 [published]\n\n- **Given** a cancelled policy\n" +
      "- **Then** the unearned premium is refunded\n",
  );
  await importDrift(dir);
  const published = (await readFeature(dir, file))!;
  expect(published).toContain("## Refund @v1 [published]");

  await Bun.write(join(dir, file), published.replace("[published]", "[proposed]"));
  expect(await importDrift(dir)).toBe("repaired 1 file(s) from their documents");
  expect(await readFeature(dir, file)).toBe(published);

  await Bun.write(join(dir, file), published.replace("the unearned premium is refunded", "nothing is refunded"));
  expect(await importDrift(dir)).toBe("repaired 1 file(s) from their documents");
  expect(await readFeature(dir, file)).toBe(published);
  const entry = (await loadFeatureDoc(dir, file))!.doc.specs[0]!;
  expect(entry.status).toBe("published");
  expect(entry.body).toContain("the unearned premium is refunded");
});

// A CRDT merge of two peers' identical absorbs leaves a published spec's live
// text doubled. The spec is held to and rendered as the body it was published
// with, so a file carrying that body is a projection, and the drift pass heals the live text before it
// looks at the file. A peer still rendering the doubled text (an older build)
// pushes a doubled file; that is drift against the recorded body, refused and
// repaired, with the heal saved in the same tick so the old peer stops.
async function doubledPublished(dir: string, file: string) {
  const loaded = (await loadFeatureDoc(dir, file))!;
  const i = loaded.doc.specs.findIndex((e) => e.status === "published");
  const merged = A.change(loaded.doc, (d) => {
    A.splice(d, ["specs", i, "body"], d.specs[i]!.body.length, 0, "\n- line two");
  });
  await saveFeatureDoc(dir, file, merged, loaded.heads);
  return i;
}

test("a published spec whose live text a merge doubled is healed by the drift pass, file untouched", async () => {
  const file = "specs/billing.feature.md";
  const dir = join(root, "data");
  await Bun.write(join(dir, file), "# Billing\n\n## Refund @v1 [published]\n\n- line one\n- line two\n");
  await importDrift(dir);
  const published = (await readFeature(dir, file))!;
  const i = await doubledPublished(dir, file);
  expect((await loadFeatureDoc(dir, file))!.doc.specs[i]!.body).toBe("- line one\n- line two\n- line two");

  expect(await importDrift(dir)).toBe("healed 1 published scenario(s)");
  expect(await readFeature(dir, file)).toBe(published);
  const entry = (await loadFeatureDoc(dir, file))!.doc.specs[i]!;
  expect(entry.body).toBe("- line one\n- line two");
  expect(snapshotOf(entry)).toBe("- line one\n- line two");
  expect(await importDrift(dir)).toBe("");
});

test("a file holding the doubled text of a published spec is repaired to the recorded body", async () => {
  const file = "specs/billing.feature.md";
  const dir = join(root, "data");
  await Bun.write(join(dir, file), "# Billing\n\n## Refund @v1 [published]\n\n- line one\n- line two\n");
  await importDrift(dir);
  const published = (await readFeature(dir, file))!;
  const i = await doubledPublished(dir, file);
  // What a peer on an older build writes: the doubled live text as the file.
  await Bun.write(join(dir, file), published.replace("- line two\n", "- line two\n- line two\n"));

  expect(await importDrift(dir)).toBe("repaired 1 file(s) from their documents; healed 1 published scenario(s)");
  expect(await readFeature(dir, file)).toBe(published);
  expect((await loadFeatureDoc(dir, file))!.doc.specs[i]!.body).toBe("- line one\n- line two");
  expect(await importDrift(dir)).toBe("");
});

test("an external feature deletion also drops the document", async () => {
  const { a, b } = await seededClones();

  await git(b, "rm", "-q", "specs/seed.feature.md");
  await git(b, "commit", "-m", "delete feature");
  await git(b, "push");

  await syncDataDir(a);
  expect(await readFeature(a, "specs/seed.feature.md")).toBeNull();
  expect(await loadFeatureDoc(a, "specs/seed.feature.md")).toBeNull();
});

test("publish over a concurrent edit merges instead of conflicting", async () => {
  const { a, b } = await seededClones();

  // B saves and pushes an edit; A publishes concurrently without pulling first.
  await saveFeature(b, "specs/seed.feature.md", SEED.replace("- line two", "- line two, from B"));
  await syncDataDir(b);
  const result = await publishFeature(
    a,
    "specs/seed.feature.md",
    SEED.replace("- line one", "- line one, from A"),
  );
  expect(result.status).toBe("published");
  const mdA = await readFeature(a, "specs/seed.feature.md");
  expect(mdA).toContain("[published]");
  expect(mdA).toContain("line one, from A");
  expect(mdA).toContain("line two, from B");

  await syncDataDir(b);
  expect(await readFeature(b, "specs/seed.feature.md")).toBe(mdA!);
});

// When the other side's push carried operations, its markdown folds in
// against its own document's projection, not the git merge base: what that
// document already holds — here B's body edit — must not read as an edit to
// a scenario A has since renamed or moved away, or the pull would land in
// the conflict dialog the operations had already made unnecessary.
test("a rename racing an in-app edit of the same line merges with no conflict dialog", async () => {
  const { a, b } = await seededClones();

  await saveFeature(b, "specs/seed.feature.md", SEED.replace("- line two", "- line two, from B"));
  await syncDataDir(b);
  const id = (await loadFeatureDoc(a, "specs/seed.feature.md"))!.doc.specs[0]!.id;
  await saveFeature(
    a,
    "specs/seed.feature.md",
    SEED.replace("## Story @v1", "## Story renamed @v1").replace("- line two", "- line two, from A"),
    { name: "Story renamed", version: 1, id },
  );
  await settle(a);
  expect(await conflictedFiles(a)).toEqual([]);

  const mdA = (await readFeature(a, "specs/seed.feature.md"))!;
  expect(mdA).toContain("## Story renamed @v1");
  expect(mdA).not.toContain("## Story @v1");
  expect(mdA).toContain("from A");
  expect(mdA).toContain("from B");
});

test("a move racing an in-app edit of the moved scenario merges with no conflict dialog", async () => {
  const other = "specs/other.feature.md";
  const clones = await twoClones(root, {
    "specs/seed.feature.md": SEED,
    [other]: "# Other\n\n## Elsewhere @v1 [proposed]\n\n- x\n",
  });
  const { a, b } = clones;
  await syncDataDir(a);
  await syncDataDir(b);

  await saveFeature(b, "specs/seed.feature.md", SEED.replace("- line two", "- line two, from B"));
  await syncDataDir(b);
  await moveScenario(a, "specs/seed.feature.md", { name: "Story", version: 1 }, other);
  await settle(a);
  expect(await conflictedFiles(a)).toEqual([]);
  expect(await readFeature(a, other)).toContain("## Story @v1");
});
