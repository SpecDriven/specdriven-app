// Test management (specs/app/tests.feature.md): a library of test
// cases, plans that group them, and executions that record one result per
// case of a plan. Everything lives in one Automerge document per data repo
// (src/server/automerge/schema.ts TestingDoc) with no markdown side: the
// chunks under `.specdriven/automerge/test-management/project/` are the only copy,
// committed and pushed by the sync tick like any other saved change. Every
// mutation below goes through one door — load (or mint) the document, apply
// one A.change, save the delta — so two people working the same plan merge at
// the CRDT level instead of overwriting each other.

import * as A from "@automerge/automerge";
import { randomUUID } from "node:crypto";
import {
  CASE_PRIORITIES,
  RESULT_STATUSES,
  type CasePriority,
  type CaseResult,
  type ResultStatus,
  type SpecRef,
  type TestCase,
  type TestPlan,
  type TestPlanExecution,
  type TestingDoc,
} from "./automerge/schema";
import {
  createTestingDoc,
  loadTestingDoc,
  newTestingDoc,
  saveTestingDoc,
} from "./automerge/store";
import { getLogger, withSpan } from "./telemetry";

export type {
  CasePriority,
  CaseResult,
  ResultStatus,
  SpecRef,
  TestCase,
  TestPlan,
  TestPlanExecution,
} from "./automerge/schema";
import { cleanLine, cleanText } from "./text";

const log = getLogger("testing");

/** What the module's pane loads: every entity, as plain JSON. */
export interface TestingView {
  /** Oldest first — the library keeps creation order. */
  cases: TestCase[];
  /** Oldest first. */
  plans: TestPlan[];
  /** Newest first — the latest run is what a plan reports. */
  executions: TestPlanExecution[];
}

/** An id that names nothing — the API answers 404. */
export class NotFoundError extends Error {}

export function isResultStatus(value: unknown): value is ResultStatus {
  return typeof value === "string" && (RESULT_STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is CasePriority {
  return typeof value === "string" && (CASE_PRIORITIES as readonly string[]).includes(value);
}

/**
 * A request's `refs`, validated into shape — each a feature file name, with
 * or without one scenario's (name, version) — or null when malformed.
 * Duplicates collapse to one; order is kept.
 */
export function parseSpecRefs(value: unknown): SpecRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SpecRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const { fileName, scenario } = (entry ?? {}) as { fileName?: unknown; scenario?: unknown };
    if (typeof fileName !== "string" || !fileName.trim()) return null;
    let ref: SpecRef = { fileName: fileName.trim() };
    if (scenario !== undefined && scenario !== null) {
      const { name, version } = (scenario ?? {}) as { name?: unknown; version?: unknown };
      if (typeof name !== "string" || !Number.isInteger(version) || (version as number) < 1) {
        return null;
      }
      // Trimmed only: a reference names an existing feature and scenario,
      // and must still match one whose heading kept inner spaces.
      ref = { fileName: fileName.trim(), scenario: { name: name.trim(), version: version as number } };
    }
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** One string per reference, for de-duplication and React keys. */
export function refKey(ref: SpecRef): string {
  return ref.scenario ? `${ref.fileName}#${ref.scenario.name}@v${ref.scenario.version}` : ref.fileName;
}

// --- Reading -----------------------------------------------------------------

/**
 * The whole module as the pane shows it; empty lists — and no document made
 * — while the repo has none yet. Reading must never write: a peer only
 * browsing the tab has nothing to push.
 */
export async function readTesting(dataDir: string): Promise<TestingView> {
  const loaded = await loadTestingDoc(dataDir);
  return loaded === null ? { cases: [], plans: [], executions: [] } : viewOf(loaded.doc);
}

function viewOf(doc: A.Doc<TestingDoc>): TestingView {
  const js = A.toJS(doc) as TestingDoc;
  const byCreated = (a: { createdAt: string }, b: { createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt);
  return {
    cases: Object.values(js.cases).sort(byCreated),
    plans: Object.values(js.plans).sort(byCreated),
    executions: Object.values(js.executions).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  };
}

// --- The one door for writes -------------------------------------------------

/**
 * Load the document — minting it on the module's first write in this repo —
 * apply one change, and save the delta since the load. Returns the document
 * after the change, for the caller to read the entity it touched.
 */
async function mutate(
  dataDir: string,
  message: string,
  change: (d: TestingDoc, now: string) => void,
): Promise<A.Doc<TestingDoc>> {
  return withSpan("testing.mutate", { "specdriven.dir": dataDir, "testing.op": message }, async () => {
    const loaded = (await loadTestingDoc(dataDir)) ?? (await createTestingDoc(dataDir, newTestingDoc()));
    const now = new Date().toISOString();
    const next = A.change(loaded.doc, { message }, (d) => change(d, now));
    await saveTestingDoc(dataDir, next, loaded.heads);
    log.debug(message);
    return next;
  });
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireCase(d: TestingDoc, id: string): TestCase {
  const c = d.cases[id];
  if (!c) throw new NotFoundError(`Test case not found: ${id}`);
  return c;
}

function requirePlan(d: TestingDoc, id: string): TestPlan {
  const p = d.plans[id];
  if (!p) throw new NotFoundError(`Test plan not found: ${id}`);
  return p;
}

function requireExecution(d: TestingDoc, id: string): TestPlanExecution {
  const e = d.executions[id];
  if (!e) throw new NotFoundError(`Test execution not found: ${id}`);
  return e;
}

function requiredName(value: unknown, what: string): string {
  const name = typeof value === "string" ? cleanLine(value) : "";
  if (!name) throw new Error(`${what} is required`);
  return name;
}

/** Collaborative text: replaced as edits, so concurrent typing merges. */
function setText(obj: object, key: string, value: string): void {
  if ((obj as Record<string, string>)[key] !== value) A.updateText(obj, [key], value);
}

/** A whole-value optional field: set, or removed when empty/null. */
function setAssigned(obj: { assigned?: string }, value: string | null | undefined): void {
  if (value === undefined) return;
  const name = value?.trim() ?? "";
  if (name) {
    if (obj.assigned !== name) obj.assigned = name;
  } else if (obj.assigned !== undefined) {
    delete obj.assigned;
  }
}

/**
 * Bring an ordered id list to `target` with the fewest list operations:
 * drop what left (descending, so indices stay valid), then walk the target
 * moving or inserting what is out of place. Concurrent edits to different
 * positions merge as inserts and deletes rather than as a wholesale replace.
 */
function reconcileIds(list: string[], target: string[]): void {
  const want = new Set(target);
  for (let i = list.length - 1; i >= 0; i--) {
    if (!want.has(list[i]!)) A.deleteAt(list, i);
  }
  for (let i = 0; i < target.length; i++) {
    const id = target[i]!;
    if (list[i] === id) continue;
    const j = list.indexOf(id, i + 1);
    if (j !== -1) A.deleteAt(list, j);
    A.insertAt(list, i, id);
  }
}

// --- Cases -------------------------------------------------------------------

export interface CaseInput {
  title?: unknown;
  body?: unknown;
  priority?: unknown;
  refs?: unknown;
}

function caseFields(input: CaseInput): {
  title?: string;
  body?: string;
  priority?: CasePriority;
  refs?: SpecRef[];
} {
  const out: ReturnType<typeof caseFields> = {};
  if (input.title !== undefined) out.title = requiredName(input.title, "Test case title");
  if (input.body !== undefined) {
    if (typeof input.body !== "string") throw new Error("body must be a string");
    out.body = cleanText(input.body);
  }
  if (input.priority !== undefined) {
    if (!isPriority(input.priority)) {
      throw new Error(`priority must be one of ${CASE_PRIORITIES.join(", ")}`);
    }
    out.priority = input.priority;
  }
  if (input.refs !== undefined) {
    const refs = parseSpecRefs(input.refs);
    if (refs === null) throw new Error("refs must be a list of feature or scenario references");
    out.refs = refs;
  }
  return out;
}

export async function createCase(dataDir: string, input: CaseInput): Promise<TestCase> {
  const fields = caseFields({ priority: "medium", body: "", refs: [], ...input });
  const title = requiredName(fields.title, "Test case title");
  const id = randomUUID();
  const doc = await mutate(dataDir, `Create test case: ${title}`, (d, now) => {
    d.cases[id] = {
      id,
      title,
      body: fields.body ?? "",
      priority: fields.priority ?? "medium",
      refs: fields.refs ?? [],
      createdAt: now,
      updatedAt: now,
    };
  });
  return plain(doc.cases[id]!);
}

export async function updateCase(dataDir: string, id: string, input: CaseInput): Promise<TestCase> {
  const fields = caseFields(input);
  const doc = await mutate(dataDir, `Update test case ${id}`, (d, now) => {
    const c = requireCase(d, id);
    if (fields.title !== undefined) setText(c, "title", fields.title);
    if (fields.body !== undefined) setText(c, "body", fields.body);
    if (fields.priority !== undefined && c.priority !== fields.priority) c.priority = fields.priority;
    // References are replaced whole: a small list, rarely edited by two
    // people at once, and a mix of two people's lists would be worse than
    // one winner.
    if (fields.refs !== undefined && !sameRefs(c.refs, fields.refs)) c.refs = fields.refs;
    c.updatedAt = now;
  });
  return plain(doc.cases[id]!);
}

function sameRefs(a: SpecRef[], b: SpecRef[]): boolean {
  return a.length === b.length && a.every((ref, i) => refKey(ref) === refKey(b[i]!));
}

/**
 * Delete a case from the library and from every plan that lists it. Runs
 * keep their snapshot: the result stands even when the case is gone.
 */
export async function deleteCase(dataDir: string, id: string): Promise<void> {
  await mutate(dataDir, `Delete test case ${id}`, (d, now) => {
    requireCase(d, id);
    delete d.cases[id];
    for (const plan of Object.values(d.plans)) {
      for (let i = plan.caseIds.length - 1; i >= 0; i--) {
        if (plan.caseIds[i] === id) {
          A.deleteAt(plan.caseIds, i);
          plan.updatedAt = now;
        }
      }
    }
  });
}

// --- Plans -------------------------------------------------------------------

export interface PlanInput {
  name?: unknown;
  description?: unknown;
  caseIds?: unknown;
  /** A member's name, or null/"" for nobody. */
  assigned?: unknown;
}

function planFields(input: PlanInput): {
  name?: string;
  description?: string;
  caseIds?: string[];
  assigned?: string | null;
} {
  const out: ReturnType<typeof planFields> = {};
  if (input.name !== undefined) out.name = requiredName(input.name, "Test plan name");
  if (input.description !== undefined) {
    if (typeof input.description !== "string") throw new Error("description must be a string");
    out.description = cleanText(input.description);
  }
  if (input.caseIds !== undefined) {
    if (!Array.isArray(input.caseIds) || input.caseIds.some((x) => typeof x !== "string")) {
      throw new Error("caseIds must be a list of test case ids");
    }
    out.caseIds = [...new Set(input.caseIds as string[])];
  }
  if (input.assigned !== undefined) {
    if (input.assigned !== null && typeof input.assigned !== "string") {
      throw new Error("assigned must be a member name or null");
    }
    out.assigned = input.assigned as string | null;
  }
  return out;
}

export async function createPlan(dataDir: string, input: PlanInput): Promise<TestPlan> {
  const fields = planFields(input);
  const name = requiredName(fields.name, "Test plan name");
  const id = randomUUID();
  const doc = await mutate(dataDir, `Create test plan: ${name}`, (d, now) => {
    for (const caseId of fields.caseIds ?? []) requireCase(d, caseId);
    d.plans[id] = {
      id,
      name,
      description: fields.description ?? "",
      caseIds: fields.caseIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    setAssigned(d.plans[id]!, fields.assigned);
  });
  return plain(doc.plans[id]!);
}

export async function updatePlan(dataDir: string, id: string, input: PlanInput): Promise<TestPlan> {
  const fields = planFields(input);
  const doc = await mutate(dataDir, `Update test plan ${id}`, (d, now) => {
    const p = requirePlan(d, id);
    if (fields.name !== undefined) setText(p, "name", fields.name);
    if (fields.description !== undefined) setText(p, "description", fields.description);
    if (fields.caseIds !== undefined) {
      for (const caseId of fields.caseIds) requireCase(d, caseId);
      reconcileIds(p.caseIds, fields.caseIds);
    }
    setAssigned(p, fields.assigned);
    p.updatedAt = now;
  });
  return plain(doc.plans[id]!);
}

/** Delete a plan. Its runs stay — they are history, listed as a deleted plan's. */
export async function deletePlan(dataDir: string, id: string): Promise<void> {
  await mutate(dataDir, `Delete test plan ${id}`, (d) => {
    requirePlan(d, id);
    delete d.plans[id];
  });
}

// --- Executions --------------------------------------------------------------

export interface ExecutionInput {
  name?: unknown;
  assigned?: unknown;
  /** true finishes the run now; false reopens it. */
  finish?: unknown;
}

function executionFields(input: ExecutionInput): {
  name?: string;
  assigned?: string | null;
  finish?: boolean;
} {
  const out: ReturnType<typeof executionFields> = {};
  if (input.name !== undefined) out.name = requiredName(input.name, "Execution name");
  if (input.assigned !== undefined) {
    if (input.assigned !== null && typeof input.assigned !== "string") {
      throw new Error("assigned must be a member name or null");
    }
    out.assigned = input.assigned as string | null;
  }
  if (input.finish !== undefined) {
    if (typeof input.finish !== "boolean") throw new Error("finish must be a boolean");
    out.finish = input.finish;
  }
  return out;
}

/**
 * Start a run of a plan: the plan's cases as they stand are the run's for
 * good, each untested until somebody records a result.
 */
export async function startExecution(
  dataDir: string,
  planId: string,
  input: ExecutionInput = {},
): Promise<TestPlanExecution> {
  const fields = executionFields(input);
  const id = randomUUID();
  const doc = await mutate(dataDir, `Start test execution of plan ${planId}`, (d, now) => {
    const plan = requirePlan(d, planId);
    if (plan.caseIds.length === 0) throw new Error("The plan has no test cases to run");
    const ordinal = Object.values(d.executions).filter((e) => e.planId === planId).length + 1;
    const caseIds = [...plan.caseIds];
    const results: { [caseId: string]: CaseResult } = {};
    for (const caseId of caseIds) results[caseId] = { status: "untested", comment: "" };
    d.executions[id] = {
      id,
      planId,
      name: fields.name ?? `Run ${ordinal} — ${now.slice(0, 10)}`,
      caseIds,
      results,
      startedAt: now,
    };
    setAssigned(d.executions[id]!, fields.assigned);
  });
  return plain(doc.executions[id]!);
}

export interface ResultInput {
  status?: unknown;
  comment?: unknown;
  /** Who recorded it — the signed-in user's name, when there is one. */
  by?: string | null;
}

/** Record a case's result in a run — the whole result, replaced. */
export async function setResult(
  dataDir: string,
  executionId: string,
  caseId: string,
  input: ResultInput,
): Promise<TestPlanExecution> {
  if (!isResultStatus(input.status)) {
    throw new Error(`status must be one of ${RESULT_STATUSES.join(", ")}`);
  }
  if (input.comment !== undefined && typeof input.comment !== "string") {
    throw new Error("comment must be a string");
  }
  const status = input.status;
  const doc = await mutate(dataDir, `Record ${status} for case ${caseId}`, (d, now) => {
    const e = requireExecution(d, executionId);
    if (!e.caseIds.includes(caseId)) throw new NotFoundError("That case is not part of this run");
    const previous = e.results[caseId];
    const result: CaseResult = {
      status,
      comment: input.comment !== undefined ? cleanLine(input.comment as string) : (previous?.comment ?? ""),
      at: now,
    };
    if (input.by) result.by = input.by;
    e.results[caseId] = result;
  });
  return plain(doc.executions[executionId]!);
}

export async function updateExecution(
  dataDir: string,
  id: string,
  input: ExecutionInput,
): Promise<TestPlanExecution> {
  const fields = executionFields(input);
  const doc = await mutate(dataDir, `Update test execution ${id}`, (d, now) => {
    const e = requireExecution(d, id);
    if (fields.name !== undefined) setText(e, "name", fields.name);
    setAssigned(e, fields.assigned);
    if (fields.finish === true && e.finishedAt === undefined) e.finishedAt = now;
    if (fields.finish === false && e.finishedAt !== undefined) delete e.finishedAt;
  });
  return plain(doc.executions[id]!);
}

export async function deleteExecution(dataDir: string, id: string): Promise<void> {
  await mutate(dataDir, `Delete test execution ${id}`, (d) => {
    requireExecution(d, id);
    delete d.executions[id];
  });
}
