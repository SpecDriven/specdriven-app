// specs/app/tests.feature.md: a lightweight test management module —
// a library of test cases that may reference features or scenarios, plans
// that group cases, and executions that snapshot a plan and record one result
// per case. All of it in one Automerge document, none of it in markdown.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTestingDoc } from "../src/server/automerge/store";
import {
  NotFoundError,
  createCase,
  createPlan,
  deleteCase,
  deleteExecution,
  deletePlan,
  parseSpecRefs,
  readTesting,
  refKey,
  setResult,
  startExecution,
  updateCase,
  updateExecution,
  updatePlan,
} from "../src/server/testing";
import { builtinManifests } from "../src/plugins/builtin/manifests";
import { readProfile } from "../src/plugins/profile";

/** The legacy `testing` switch, read as the profile reads it (src/plugins/profile.ts). */
const normalizeTesting = (value: unknown): boolean =>
  readProfile(value === undefined ? {} : { testing: value }, builtinManifests).enabled.includes("tests");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-testing-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the Test management setting is off unless explicitly turned on", () => {
  expect(normalizeTesting(undefined)).toBe(false);
  expect(normalizeTesting("true")).toBe(false);
  expect(normalizeTesting(false)).toBe(false);
  expect(normalizeTesting(true)).toBe(true);
});

test("reading an unused repo returns empty lists and writes nothing", async () => {
  expect(await readTesting(root)).toEqual({ cases: [], plans: [], executions: [] });
  expect(await hasTestingDoc(root)).toBe(false);
  expect(await readdir(root)).toEqual([]);
});

test("spec references are validated and de-duplicated", () => {
  expect(parseSpecRefs("nope")).toBeNull();
  expect(parseSpecRefs([{ fileName: "" }])).toBeNull();
  expect(parseSpecRefs([{ fileName: "specs/a.feature.md", scenario: { name: "X" } }])).toBeNull();
  expect(parseSpecRefs([{ fileName: "specs/a.feature.md", scenario: { name: "X", version: 0 } }])).toBeNull();
  expect(
    parseSpecRefs([
      { fileName: "specs/a.feature.md" },
      { fileName: "specs/a.feature.md", scenario: { name: "Basic", version: 2 } },
      { fileName: "specs/a.feature.md" },
    ]),
  ).toEqual([
    { fileName: "specs/a.feature.md" },
    { fileName: "specs/a.feature.md", scenario: { name: "Basic", version: 2 } },
  ]);
  expect(refKey({ fileName: "specs/a.feature.md", scenario: { name: "Basic", version: 2 } })).toBe(
    "specs/a.feature.md#Basic@v2",
  );
});

test("a test case is created, edited and deleted through the document", async () => {
  const c = await createCase(root, {
    title: " Quote totals ",
    refs: [{ fileName: "specs/billing/quotes.feature.md", scenario: { name: "Basic Quote", version: 1 } }],
  });
  expect(c.title).toBe("Quote totals");
  expect(c.priority).toBe("medium");
  expect(c.body).toBe("");
  expect(c.refs).toHaveLength(1);
  expect(await hasTestingDoc(root)).toBe(true);

  const edited = await updateCase(root, c.id, { body: "1. Open a quote\n2. Check the total", priority: "high" });
  expect(edited.body).toBe("1. Open a quote\n2. Check the total");
  expect(edited.priority).toBe("high");
  expect(edited.refs).toEqual(c.refs);
  expect(edited.updatedAt >= c.updatedAt).toBe(true);

  await expect(updateCase(root, c.id, { priority: "urgent" })).rejects.toThrow("priority must be one of");
  await expect(updateCase(root, c.id, { title: "  " })).rejects.toThrow("title is required");
  await expect(updateCase(root, "missing", { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
  await expect(createCase(root, {})).rejects.toThrow("Test case title is required");

  await deleteCase(root, c.id);
  expect((await readTesting(root)).cases).toEqual([]);
  await expect(deleteCase(root, c.id)).rejects.toBeInstanceOf(NotFoundError);
});

test("a plan groups cases in order and drops a deleted case", async () => {
  const a = await createCase(root, { title: "A" });
  const b = await createCase(root, { title: "B" });
  const c = await createCase(root, { title: "C" });
  const plan = await createPlan(root, { name: "Release 1", caseIds: [a.id, b.id] });
  expect(plan.caseIds).toEqual([a.id, b.id]);
  expect(plan.assigned).toBeUndefined();

  const reordered = await updatePlan(root, plan.id, { caseIds: [c.id, b.id, a.id], assigned: "Ada" });
  expect(reordered.caseIds).toEqual([c.id, b.id, a.id]);
  expect(reordered.assigned).toBe("Ada");
  const unassigned = await updatePlan(root, plan.id, { assigned: null, caseIds: [b.id, a.id] });
  expect(unassigned.assigned).toBeUndefined();
  expect(unassigned.caseIds).toEqual([b.id, a.id]);
  await expect(updatePlan(root, plan.id, { caseIds: ["nope"] })).rejects.toBeInstanceOf(NotFoundError);
  await expect(createPlan(root, { name: "" })).rejects.toThrow("Test plan name is required");

  await deleteCase(root, b.id);
  expect((await readTesting(root)).plans[0]!.caseIds).toEqual([a.id]);

  await deletePlan(root, plan.id);
  expect((await readTesting(root)).plans).toEqual([]);
});

test("an execution snapshots the plan and records one result per case", async () => {
  const a = await createCase(root, { title: "A" });
  const b = await createCase(root, { title: "B" });
  const empty = await createPlan(root, { name: "Empty" });
  await expect(startExecution(root, empty.id)).rejects.toThrow("no test cases");
  const plan = await createPlan(root, { name: "Release 1", caseIds: [a.id, b.id] });

  const run = await startExecution(root, plan.id);
  expect(run.planId).toBe(plan.id);
  expect(run.name).toMatch(/^Run 1 — \d{4}-\d{2}-\d{2}$/);
  expect(run.caseIds).toEqual([a.id, b.id]);
  expect(run.results).toEqual({
    [a.id]: { status: "untested", comment: "" },
    [b.id]: { status: "untested", comment: "" },
  });
  expect(run.finishedAt).toBeUndefined();

  // Editing the plan afterwards leaves the run's snapshot alone.
  await updatePlan(root, plan.id, { caseIds: [b.id] });
  expect((await readTesting(root)).executions[0]!.caseIds).toEqual([a.id, b.id]);

  const passed = await setResult(root, run.id, a.id, { status: "passed", comment: "ok", by: "Ada" });
  expect(passed.results[a.id]).toMatchObject({ status: "passed", comment: "ok", by: "Ada" });
  expect(passed.results[a.id]!.at).toBeDefined();
  // A status change without a comment keeps the comment.
  const failed = await setResult(root, run.id, a.id, { status: "failed" });
  expect(failed.results[a.id]!.comment).toBe("ok");
  await expect(setResult(root, run.id, a.id, { status: "meh" })).rejects.toThrow("status must be one of");
  await expect(setResult(root, run.id, "nope", { status: "passed" })).rejects.toBeInstanceOf(NotFoundError);

  const second = await startExecution(root, plan.id, { name: "Smoke", assigned: "Bob" });
  expect(second.name).toBe("Smoke");
  expect(second.assigned).toBe("Bob");
  expect(second.caseIds).toEqual([b.id]);

  const finished = await updateExecution(root, run.id, { finish: true });
  expect(finished.finishedAt).toBeDefined();
  const reopened = await updateExecution(root, run.id, { finish: false, name: "Run 1 (redo)" });
  expect(reopened.finishedAt).toBeUndefined();
  expect(reopened.name).toBe("Run 1 (redo)");

  // Newest first.
  expect((await readTesting(root)).executions.map((e) => e.id)).toEqual([second.id, run.id]);

  // Deleting the plan keeps its runs; deleting a run removes it.
  await deletePlan(root, plan.id);
  expect((await readTesting(root)).executions).toHaveLength(2);
  await deleteExecution(root, second.id);
  expect((await readTesting(root)).executions.map((e) => e.id)).toEqual([run.id]);
});
