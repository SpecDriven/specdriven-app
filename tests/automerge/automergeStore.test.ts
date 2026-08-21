// The chunked Automerge store under `.specdriven/automerge/features/`:
// content-addressed write-once chunks so concurrent peers union-merge in git,
// deterministic merge of divergent copies, foreign-lineage chunks skipped,
// and compaction folding change files into a snapshot.

import { test, expect, beforeEach, afterEach } from "bun:test";
import * as A from "@automerge/automerge";
import { mkdtemp, readdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeatureDoc,
  docDir,
  loadFeatureDoc,
  newFeatureDoc,
  removeFeatureDoc,
  saveFeatureDoc,
} from "../../src/server/automerge/store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-amstore-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FILE = "policy/quote-policy.feature.md";

function sampleDoc() {
  return newFeatureDoc({
    name: "Quote Policy",
    description: "Quotes for potential customers.",
    scenarios: [
      {
        id: crypto.randomUUID(),
        name: "Basic Quote",
        version: 1,
        status: "proposed",
        body: "- **Given** an account\n- **Then** a quote",
        tests: [],
      },
    ],
  });
}

test("loadFeatureDoc is null for a feature with no document", async () => {
  expect(await loadFeatureDoc(root, FILE)).toBeNull();
});

test("create/load round-trips the document and its identity", async () => {
  const doc = sampleDoc();
  await createFeatureDoc(root, FILE, doc);
  const loaded = await loadFeatureDoc(root, FILE);
  expect(loaded).not.toBeNull();
  expect(A.toJS(loaded!.doc)).toEqual(A.toJS(doc));
  expect(loaded!.docId).toBe(doc.id);
  expect(loaded!.skippedChunks).toEqual([]);
});

test("saveFeatureDoc appends an incremental chunk that loads back", async () => {
  const created = await createFeatureDoc(root, FILE, sampleDoc());
  const next = A.change(A.clone(created.doc), (d) => {
    A.updateText(d, ["scenarios", 0, "body"], "- **Given** a premium account\n- **Then** a quote");
  });
  await saveFeatureDoc(root, FILE, next, created.heads);
  const files = await readdir(docDir(root, FILE));
  expect(files.filter((f) => f.startsWith("changes-")).length).toBe(1);
  const loaded = await loadFeatureDoc(root, FILE);
  expect(loaded!.doc.scenarios[0]!.body).toContain("premium account");
});

test("a no-op save writes nothing", async () => {
  const created = await createFeatureDoc(root, FILE, sampleDoc());
  await saveFeatureDoc(root, FILE, created.doc, created.heads);
  const files = await readdir(docDir(root, FILE));
  expect(files.filter((f) => f.startsWith("changes-"))).toEqual([]);
});

// Two peers diverge from the same document and each writes its own chunk;
// unioning the chunk files (what a git merge of both pushes produces) loads
// into one document containing both edits, identically for both peers.
test("divergent copies union-merge deterministically", async () => {
  const created = await createFeatureDoc(root, FILE, sampleDoc());

  const peerA = A.change(A.clone(created.doc), (d) => {
    A.splice(d, ["scenarios", 0, "body"], 0, 0, "A: ");
  });
  const peerB = A.change(A.clone(created.doc), (d) => {
    d.scenarios[0]!.tests.push("https://github.com/acme/repo/blob/main/t.test.ts");
  });

  // Each peer appends its chunk to its own copy of the directory.
  const dirA = join(root, "peer-a");
  const dirB = join(root, "peer-b");
  await cp(docDir(root, FILE), docDir(dirA, FILE), { recursive: true });
  await cp(docDir(root, FILE), docDir(dirB, FILE), { recursive: true });
  await saveFeatureDoc(dirA, FILE, peerA, created.heads);
  await saveFeatureDoc(dirB, FILE, peerB, created.heads);

  // Union both directories into each peer, as a git merge would.
  await cp(docDir(dirB, FILE), docDir(dirA, FILE), { recursive: true, force: false });
  await cp(docDir(dirA, FILE), docDir(dirB, FILE), { recursive: true, force: false });

  const mergedA = await loadFeatureDoc(dirA, FILE);
  const mergedB = await loadFeatureDoc(dirB, FILE);
  expect(mergedA!.doc.scenarios[0]!.body.startsWith("A: ")).toBe(true);
  expect(mergedA!.doc.scenarios[0]!.tests.length).toBe(1);
  expect(A.toJS(mergedA!.doc)).toEqual(A.toJS(mergedB!.doc));
  expect(A.getHeads(mergedA!.doc)).toEqual(A.getHeads(mergedB!.doc));
});

// After a concurrent rename recreates a directory, chunks from a different
// document lineage can share a directory. Automerge merges them with
// deterministic per-key conflict resolution, so every peer converges on the
// same winner; nothing is fatal and the drift pass repairs content later.
test("chunks from a foreign document merge deterministically", async () => {
  const ours = await createFeatureDoc(root, FILE, sampleDoc());
  const foreignRoot = join(root, "foreign");
  const foreign = await createFeatureDoc(foreignRoot, FILE, sampleDoc());
  const foreignSnapshot = (await readdir(docDir(foreignRoot, FILE))).find((f) =>
    f.startsWith("snapshot-"),
  )!;
  await cp(
    join(docDir(foreignRoot, FILE), foreignSnapshot),
    join(docDir(root, FILE), foreignSnapshot),
  );
  // The other direction: the foreign dir also receives our snapshot.
  const ourSnapshot = (await readdir(docDir(root, FILE))).find(
    (f) => f.startsWith("snapshot-") && f !== foreignSnapshot,
  )!;
  await cp(join(docDir(root, FILE), ourSnapshot), join(docDir(foreignRoot, FILE), ourSnapshot));

  const mergedOurs = await loadFeatureDoc(root, FILE);
  const mergedForeign = await loadFeatureDoc(foreignRoot, FILE);
  expect(mergedOurs).not.toBeNull();
  expect(mergedOurs!.doc.name).toBe("Quote Policy");
  // Both peers converge on the same winning lineage.
  expect(A.toJS(mergedOurs!.doc)).toEqual(A.toJS(mergedForeign!.doc));
  expect([ours.doc.id, foreign.doc.id]).toContain(mergedOurs!.doc.id);
});

test("compaction folds change files into one snapshot that still loads", async () => {
  let { doc, heads } = await createFeatureDoc(root, FILE, sampleDoc());
  for (let i = 0; i < 13; i++) {
    const next = A.change(A.clone(doc), (d) => {
      A.splice(d, ["scenarios", 0, "body"], 0, 0, `${i} `);
    });
    await saveFeatureDoc(root, FILE, next, heads);
    const loaded = (await loadFeatureDoc(root, FILE))!;
    doc = loaded.doc;
    heads = loaded.heads;
  }
  const files = await readdir(docDir(root, FILE));
  expect(files.filter((f) => f.startsWith("changes-")).length).toBeLessThan(12);
  expect(files.filter((f) => f.startsWith("snapshot-")).length).toBe(1);
  const loaded = await loadFeatureDoc(root, FILE);
  expect(loaded!.doc.scenarios[0]!.body).toContain("12 ");
  expect(loaded!.doc.scenarios[0]!.body).toContain("0 ");
});

test("removeFeatureDoc deletes the directory", async () => {
  await createFeatureDoc(root, FILE, sampleDoc());
  await removeFeatureDoc(root, FILE);
  expect(await loadFeatureDoc(root, FILE)).toBeNull();
});

// A schema v1 document — statuses as `published`/`proposed` booleans —
// migrates on load: `status` appears, the booleans go, the version bumps.
// loadFeatureDoc returns pre-migration heads, so the next save persists the
// migration ops and a reload needs no second migration.
test("a v1 document's booleans migrate to the status field on load", async () => {
  type V1Entry = {
    id: string;
    name: string;
    version: number;
    published: boolean;
    proposed: boolean;
    body: string;
    tests: string[];
  };
  type V1Doc = {
    schemaVersion: number;
    id: string;
    name: string;
    description: string;
    scenarios: V1Entry[];
  };
  const v1 = A.from<V1Doc>({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "Quote Policy",
    description: "",
    scenarios: [
      { id: crypto.randomUUID(), name: "Done", version: 1, published: true, proposed: false, body: "done", tests: [] },
      { id: crypto.randomUUID(), name: "Pending", version: 1, published: false, proposed: true, body: "pending", tests: [] },
      { id: crypto.randomUUID(), name: "Idea", version: 1, published: false, proposed: false, body: "idea", tests: [] },
    ],
  });
  await createFeatureDoc(root, FILE, v1 as unknown as Parameters<typeof createFeatureDoc>[2]);

  const loaded = (await loadFeatureDoc(root, FILE))!;
  expect(loaded.doc.schemaVersion).toBe(2);
  const plain = A.toJS(loaded.doc);
  expect(
    Object.fromEntries(plain.scenarios.map((s) => [s.name, s.status])),
  ).toEqual({ Done: "published", Pending: "proposed", Idea: "draft" });
  for (const s of plain.scenarios) {
    expect(Object.keys(s)).not.toContain("published");
    expect(Object.keys(s)).not.toContain("proposed");
  }

  await saveFeatureDoc(root, FILE, loaded.doc, loaded.heads);
  const reloaded = (await loadFeatureDoc(root, FILE))!;
  expect(reloaded.doc.schemaVersion).toBe(2);
  expect(reloaded.heads).toEqual(A.getHeads(reloaded.doc));
  expect(A.getHeads(reloaded.doc)).toEqual(A.getHeads(loaded.doc));
});
