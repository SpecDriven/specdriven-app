// Traces from the Lean verification of the sync core
// (verification/lean/SpecDriven/Sync/Theorems/Hypotheses.lean, REPORT.md):
// hypotheses H1 and H2 of docs/lean-sync-verification-prompt.md, played
// against the real implementation over real git transport. Both were
// confirmed weaknesses and are fixed: H1 since the ops-arrived resolution
// folds in what their markdown holds beyond their own document
// (driftSync.ts `theirChunks`), the published case of H2 since publishing
// records the body (schema.ts `publishedBody`). Their tests pin the fixes.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureDoc } from "../../src/server/automerge/store";
import { snapshotOf } from "../../src/server/automerge/schema";
import { importDrift } from "../../src/server/automerge/driftSync";
import { projectFeature } from "../../src/server/automerge/project";
import * as A from "@automerge/automerge";
import { importFeatureDoc, reconcile } from "../../src/server/automerge/reconcile";
import { publishFeature, readFeature, saveFeature } from "../../src/server/features";
import { parseFeature } from "../../src/server/parser";
import { conflictedFiles } from "../../src/server/git";
import { syncDataDir } from "../../src/server/reload";
import { git, stopServers, twoClones } from "../helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-leanhyp-"));
});

afterEach(async () => {
  stopServers();
  await rm(root, { recursive: true, force: true });
});

const FILE = "specs/seed.feature.md";
const ONE = "# Seed\n\n## Story @v1 [proposed]\n\n- line one\n- line two\n";
const TWO =
  "# Seed\n\n## Alpha @v1 [proposed]\n\n- alpha one\n- alpha two\n\n## Beta @v1 [proposed]\n\n- beta one\n- beta two\n";

/** Both clones with the seed feature imported into one shared document. */
async function seededClones(seed: string) {
  const clones = await twoClones(root, { [FILE]: seed });
  await syncDataDir(clones.a);
  await syncDataDir(clones.b);
  return clones;
}

async function settle(dir: string) {
  await syncDataDir(dir);
  await syncDataDir(dir);
}

/** A markdown-only commit on origin, as a GitHub PR merge would leave it. */
async function pushMarkdownOnly(dir: string, text: string, message: string) {
  await Bun.write(join(dir, FILE), text);
  await git(dir, "add", FILE);
  await git(dir, "commit", "-m", message);
  await git(dir, "push");
}

// H1 Mixed-origin conflict (fixed). B saves Alpha through the app (operations
// in chunk files) and, in the same push, hand-edits Beta (no operations). A's
// concurrent save makes the pull conflict on the markdown. `autoResolveOne`
// used to see that operations arrived, skip the three-way merge and re-project
// the merged document — which never saw the hand edit. It now rebuilds B's
// document from the chunks B pushed and folds B's markdown in three-way
// against that document's projection, where the hand edit is the only
// difference. Lean: Hypotheses.lean `H1_hand_edit_folded`.
test("H1: a hand edit riding a push with operations is absorbed by the ops-arrived resolution", async () => {
  const { a, b } = await seededClones(TWO);

  const viaApp = TWO.replace("- alpha one", "- alpha one, from B's app");
  await saveFeature(b, FILE, viaApp);
  const handEdited = viaApp.replace("- beta one", "- beta one, hand-edited on B");
  await Bun.write(join(b, FILE), handEdited);
  await git(b, "add", "-A");
  await git(b, "commit", "-m", "app save plus hand edit");
  await git(b, "push");

  await saveFeature(a, FILE, TWO.replace("- alpha two", "- alpha two, from A"));
  await settle(a);
  expect(await conflictedFiles(a)).toEqual([]);
  await syncDataDir(b);
  await syncDataDir(a);

  const mdA = (await readFeature(a, FILE))!;
  expect(mdA).toBe((await readFeature(b, FILE))!);
  expect(mdA).toContain("from B's app");
  expect(mdA).toContain("from A");
  expect(mdA).toContain("hand-edited on B");
});

// H1 within one scenario. The hand edit touches the same scenario B also
// saved through the app in that push, on a line of its own; A's concurrent
// save makes the pull conflict. Against their document's projection the hand
// edit is the only change of theirs, so all three edits survive.
test("H1: a hand edit to the scenario the same push saved through the app is absorbed too", async () => {
  const { a, b } = await seededClones(TWO);

  const viaApp = TWO.replace("- alpha one", "- alpha one, from B's app");
  await saveFeature(b, FILE, viaApp);
  await Bun.write(join(b, FILE), viaApp.replace("- alpha two", "- alpha two, hand-edited on B"));
  await git(b, "add", "-A");
  await git(b, "commit", "-m", "app save plus hand edit");
  await git(b, "push");

  await saveFeature(a, FILE, TWO.replace("- alpha one", "- alpha one, from A"));
  await settle(a);
  expect(await conflictedFiles(a)).toEqual([]);
  await syncDataDir(b);
  await syncDataDir(a);

  const mdA = (await readFeature(a, FILE))!;
  expect(mdA).toBe((await readFeature(b, FILE))!);
  expect(mdA).toContain("from B's app");
  expect(mdA).toContain("from A");
  expect(mdA).toContain("hand-edited on B");
  expect(mdA.match(/from B's app/g)).toHaveLength(1);
});

// H1 residual. Between B's push and A's pull, A's own saves compact A's
// document (store.ts compactDoc), deleting chunk files B's side still has:
// B's document cannot be rebuilt as B pushed it, so a hand edit cannot be
// told apart from the operations. The resolution falls back to the merged
// document's projection — no dialog, both peers converge — and logs that
// the hand edit was not folded in.
// Lean: Hypotheses.lean `H1_unrebuilt_ignores_theirs`.
test("H1 residual: when compaction removed their chunks the resolution falls back to the merged document", async () => {
  const { a, b } = await seededClones(TWO);

  const viaApp = TWO.replace("- alpha one", "- alpha one, from B's app");
  await saveFeature(b, FILE, viaApp);
  await Bun.write(join(b, FILE), viaApp.replace("- beta one", "- beta one, hand-edited on B"));
  await git(b, "add", "-A");
  await git(b, "commit", "-m", "app save plus hand edit");
  await git(b, "push");

  for (let i = 1; i <= 12; i++) {
    await saveFeature(a, FILE, TWO.replace("- alpha two", `- alpha two, from A ${i}`));
  }
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await settle(a);
  } finally {
    console.warn = warn;
  }
  expect(await conflictedFiles(a)).toEqual([]);
  expect(warnings.some((w) => w.includes("their document could not be rebuilt"))).toBe(true);
  await syncDataDir(b);
  await syncDataDir(a);

  const mdA = (await readFeature(a, FILE))!;
  expect(mdA).toBe((await readFeature(b, FILE))!);
  expect(mdA).toContain("from B's app");
  expect(mdA).toContain("from A 12");
  expect(mdA).not.toContain("hand-edited on B");
});

// H2 Concurrent absorb duplicates text, then self-heals. Both peers absorb
// the same markdown-only edit before either pushes; each mints its own
// updateText splice for the same insertion, and the merged document holds
// the insertion twice. The file is identical on both sides, so the pull is
// clean, the doubled document is not a projection of it, and the drift pass
// drives the document back to the file. Lean: `H2_doubled`, `H2_heals`.
test("H2: concurrent absorbs double the text in the document, and the next drift pass heals it", async () => {
  const { a, b } = await seededClones(ONE);

  await pushMarkdownOnly(b, ONE.replace("- line two", "- line two, edited on GitHub"), "PR merge");
  await git(a, "pull");
  await importDrift(a); // absorbs: operations on A, not yet pushed
  await importDrift(b); // absorbs: a second, concurrent set of operations on B

  await syncDataDir(a); // commits and pushes A's chunks
  // B's chunks and A's meet, without the drift pass that a tick would run
  // right after the pull: the merged document holds the insertion twice.
  await git(b, "add", "-A");
  await git(b, "commit", "-m", "B's absorb");
  await git(b, "pull", "--no-rebase");
  const merged = (await loadFeatureDoc(b, FILE))!.doc;
  expect(merged.specs[0]!.body).toBe("- line one\n- line two, edited on GitHub, edited on GitHub");
  expect(await readFeature(b, FILE)).toBe(ONE.replace("- line two", "- line two, edited on GitHub"));

  await syncDataDir(b); // the drift pass: the file is not a projection, absorb
  await syncDataDir(a);
  const docA = (await loadFeatureDoc(a, FILE))!.doc;
  const docB = (await loadFeatureDoc(b, FILE))!.doc;
  expect(docA.specs[0]!.body).toBe("- line one\n- line two, edited on GitHub");
  expect(docB.specs[0]!.body).toBe(docA.specs[0]!.body);
  expect(projectFeature(docA)).toBe((await readFeature(a, FILE))!);
});

// H2, the published case (fixed). Between the two absorbs A publishes the
// scenario, recording the body it publishes. B's pull merges A's operations
// (published, body once, recorded) with B's own absorb (body once): the live
// text holds the insertion twice, but the entry is held to and rendered as
// the recorded body, so the file is a projection, the gate is satisfied, and
// B's drift pass drives the live text back to the recorded body before it
// looks at the file. Before the record existed the gate read the doubled
// live text, refused the single-bodied file and "repaired" it to the doubled
// projection, locking the duplicate in on every peer.
// Lean: Hypotheses.lean `H2_publish_heals`, `H2_publish_heals_on_tick`.
test("H2: a publish between two concurrent absorbs heals to the published body", async () => {
  const { a, b } = await seededClones(ONE);

  await pushMarkdownOnly(b, ONE.replace("- line two", "- line two, edited on GitHub"), "PR merge");
  await git(a, "pull");
  await importDrift(a);
  await importDrift(b);

  await publishFeature(a, FILE, (await readFeature(a, FILE))!); // A: published, body once, recorded, pushed
  await settle(b); // B: merges (live text doubled), then the drift pass heals it to the recorded body
  await syncDataDir(a);

  const docA = (await loadFeatureDoc(a, FILE))!.doc;
  const docB = (await loadFeatureDoc(b, FILE))!.doc;
  expect(docA.specs[0]!.status).toBe("published");
  expect(snapshotOf(docA.specs[0]!)).toBe("- line one\n- line two, edited on GitHub");
  expect(docB.specs[0]!.body).toBe(docA.specs[0]!.body);
  expect(docA.specs[0]!.body).toBe("- line one\n- line two, edited on GitHub");
  expect(await readFeature(a, FILE)).toBe((await readFeature(b, FILE))!);
});

// H4 Same-body claim mis-match. Two empty-bodied scenarios `a` and `b`; the
// markdown now holds only `c`. Nothing in the markdown says whether `a` or
// `b` was renamed, and the body pass attaches `c` to the first unclaimed
// entry: `a`'s identity continues as `c` and `b`'s entry is removed. An
// editor save carries the renamed entry's id and lands on the right one
// (Lean T14). Lean: Hypotheses.lean `H4_markdown_picks_first`,
// `H4_hint_picks_named`.
test("H4: a markdown-only rename of one of two same-body scenarios lands on the first entry", () => {
  const doc = importFeatureDoc(parseFeature("# F\n\n## a @v1 [proposed]\n\n## b @v1 [proposed]\n"));
  const [a, b] = doc.specs.map((e) => e.id);
  const renamed = parseFeature("# F\n\n## c @v1 [proposed]\n");

  const fromMarkdown = reconcile(doc, renamed);
  expect(fromMarkdown.specs.map((e) => [e.name, e.id])).toEqual([["c", a]]);

  const fromEditor = reconcile(A.clone(doc), renamed, { scenario: { name: "c", version: 1, id: b } });
  expect(fromEditor.specs.map((e) => [e.name, e.id])).toEqual([["c", b]]);
});
