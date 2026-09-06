// The test management module's document (specs/app/tests.feature.md)
// in the chunked store: minted identically on every peer so two repos that
// each start using the module before syncing still share one lineage, saved
// and loaded under its own kind, and merged across two clones by the sync
// tick like any other document — with no markdown file beside it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import * as A from "@automerge/automerge";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TESTING_DOC_ID,
  createTestingDoc,
  hasTestingDoc,
  loadTestingDoc,
  newTestingDoc,
  saveTestingDoc,
  testingDocDirRel,
} from "../../src/server/automerge/store";
import type { TestingDoc } from "../../src/server/automerge/schema";
import { setGitEngine } from "../../src/server/git";
import { syncDataDir } from "../../src/server/reload";
import { createCase, createPlan, readTesting } from "../../src/server/testing";
import { git, stopServers, twoClones } from "../helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-amtesting-"));
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

test("the genesis document is identical on every peer", () => {
  const a = newTestingDoc();
  const b = newTestingDoc();
  expect(A.getHeads(a)).toEqual(A.getHeads(b));
  expect(a.id).toBe(TESTING_DOC_ID);
  expect(A.toJS(a)).toEqual({
    schemaVersion: 1,
    id: TESTING_DOC_ID,
    cases: {},
    plans: {},
    executions: {},
  });
});

test("two independently minted documents merge their edits", () => {
  const a = A.change(A.clone(newTestingDoc()), (d) => {
    d.cases["c1"] = {
      id: "c1", title: "One", body: "", priority: "medium", refs: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  });
  const b = A.change(A.clone(newTestingDoc()), (d) => {
    d.plans["p1"] = {
      id: "p1", name: "Plan", description: "", caseIds: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  });
  const merged = A.loadIncremental(A.load<TestingDoc>(A.save(a)), A.save(b));
  expect(Object.keys(merged.cases)).toEqual(["c1"]);
  expect(Object.keys(merged.plans)).toEqual(["p1"]);
});

test("create/save/load round-trips under the testing kind", async () => {
  expect(await hasTestingDoc(root)).toBe(false);
  expect(await loadTestingDoc(root)).toBeNull();
  const created = await createTestingDoc(root, newTestingDoc());
  expect(await hasTestingDoc(root)).toBe(true);
  const next = A.change(A.clone(created.doc), (d) => {
    d.plans["p1"] = {
      id: "p1", name: "Release 1", description: "", caseIds: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  });
  await saveTestingDoc(root, next, created.heads);
  const loaded = await loadTestingDoc(root);
  expect(loaded!.doc.plans["p1"]!.name).toBe("Release 1");
  expect(loaded!.docId).toBe(TESTING_DOC_ID);
  const files = await readdir(join(root, testingDocDirRel()));
  expect(files.filter((f) => f.startsWith("snapshot-"))).toHaveLength(1);
  expect(files.filter((f) => f.startsWith("changes-"))).toHaveLength(1);
  expect(files).toContain("docid");
  // No markdown anywhere: the document is the only copy.
  expect((await readdir(root)).filter((f) => f.endsWith(".md"))).toEqual([]);
});

// The module's first use on two machines before either pushes: each mints
// the document, and the sync ticks union the two. Like any local save, the
// second peer needs two ticks (tests/automerge/automergeSync.test.ts settle):
// git refuses to pull over its still-untracked chunk files, so the first
// tick only commits them and the second pulls, merges and pushes — and the
// merge is clean, since both peers' genesis files are byte-identical.
test("two clones that each start the module converge through the sync tick", async () => {
  const clones = await twoClones(root);
  await createCase(clones.a, { title: "Quote totals" });
  await createPlan(clones.b, { name: "Release 1" });
  await syncDataDir(clones.a);
  await syncDataDir(clones.b);
  await syncDataDir(clones.b);
  await syncDataDir(clones.a);
  const a = await readTesting(clones.a);
  const b = await readTesting(clones.b);
  expect(a.cases.map((c) => c.title)).toEqual(["Quote totals"]);
  expect(a.plans.map((p) => p.name)).toEqual(["Release 1"]);
  expect(b.cases.map((c) => c.title)).toEqual(["Quote totals"]);
  expect(b.plans.map((p) => p.name)).toEqual(["Release 1"]);
  // Both docid files agree — one lineage, no conflict to resolve.
  expect((await git(clones.a, "status", "--porcelain")).text().trim()).toBe("");
  expect((await git(clones.b, "status", "--porcelain")).text().trim()).toBe("");
});
