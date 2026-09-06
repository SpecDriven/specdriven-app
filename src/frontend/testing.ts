// The test management module's client store (specs/app/tests.feature.md):
// the module's cases, plans and executions as one snapshot read from
// GET /api/tests, kept current by the mutations below — each applies the
// entity the server returns — and by the app's reload tick. Module-level
// state read through useSyncExternalStore, like the coding agent pane's
// (src/frontend/agentChat.ts), so App.tsx holds only which view is open.
// The pure helpers at the bottom — roll-ups, labels, links, palette search
// — take the snapshot as an argument, so they test without a DOM or a server.

import { useSyncExternalStore } from "react";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import type {
  CasePriority,
  CaseResult,
  ResultStatus,
  SpecRef,
  TestCase,
  TestPlan,
  TestPlanExecution,
} from "../server/automerge/schema";
import type { TestingView } from "../server/testing";
import { toast } from "./Toasts";
import { featurePath, scenarioPath, testsPath, type TestsRoute } from "./route";

export type {
  CasePriority,
  CaseResult,
  ResultStatus,
  SpecRef,
  TestCase,
  TestPlan,
  TestPlanExecution,
};

export interface TestingStore extends TestingView {
  /** Whether GET /api/tests has answered since the last reset. */
  loaded: boolean;
  error: string | null;
}

export const EMPTY_TESTING: TestingStore = {
  cases: [],
  plans: [],
  executions: [],
  loaded: false,
  error: null,
};

let state: TestingStore = EMPTY_TESTING;
const listeners = new Set<() => void>();
/** Editors with an unsaved draft; a refresh must not overwrite them. */
const dirtyKeys = new Set<string>();

function set(next: TestingStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useTesting(): TestingStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** For tests and the odd imperative read. */
export function testingState(): TestingStore {
  return state;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Run a mutation; a failure is a toast, and the caller gets null. */
async function attempt<T>(work: () => Promise<T>, failure: string): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    toast.error(`${failure}: ${(e as Error).message}`);
    return null;
  }
}

const jsonBody = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

export const testing = {
  /** GET /api/tests into the store; the pane shows `error` when it fails. */
  async load(): Promise<void> {
    try {
      const view = await call<TestingView>("/api/tests");
      set({ ...view, loaded: true, error: null });
    } catch (e) {
      set({ ...state, loaded: true, error: (e as Error).message });
    }
  },
  /** The reload tick's refresh: skipped while an editor holds an unsaved draft. */
  async refresh(): Promise<void> {
    if (dirtyKeys.size > 0) return;
    await testing.load();
  },
  /** Forget everything — the module was switched off, or the data repo changed. */
  reset(): void {
    dirtyKeys.clear();
    set(EMPTY_TESTING);
  },
  /** Editors report their unsaved state here (see refresh). */
  setDirty(key: string, dirty: boolean): void {
    if (dirty) dirtyKeys.add(key);
    else dirtyKeys.delete(key);
  },

  createCase(input: { title: string; body?: string; priority?: CasePriority; refs?: SpecRef[] }) {
    return attempt(async () => {
      const { case: c } = await call<{ case: TestCase }>("/api/tests/cases", {
        method: "POST",
        body: JSON.stringify(input),
      });
      set(applyEntity(state, "case", c));
      return c;
    }, "Could not create the test case");
  },
  updateCase(id: string, patch: Partial<Pick<TestCase, "title" | "body" | "priority" | "refs">>) {
    return attempt(async () => {
      const { case: c } = await call<{ case: TestCase }>(
        `/api/tests/cases/${encodeURIComponent(id)}`,
        jsonBody(patch),
      );
      set(applyEntity(state, "case", c));
      return c;
    }, "Could not save the test case");
  },
  deleteCase(id: string) {
    return attempt(async () => {
      await call(`/api/tests/cases/${encodeURIComponent(id)}`, { method: "DELETE" });
      set(removeEntity(state, "case", id));
      return true;
    }, "Could not delete the test case");
  },

  createPlan(input: { name: string; caseIds?: string[] }) {
    return attempt(async () => {
      const { plan } = await call<{ plan: TestPlan }>("/api/tests/plans", {
        method: "POST",
        body: JSON.stringify(input),
      });
      set(applyEntity(state, "plan", plan));
      return plan;
    }, "Could not create the test plan");
  },
  updatePlan(
    id: string,
    patch: Partial<Pick<TestPlan, "name" | "description" | "caseIds">> & { assigned?: string | null },
  ) {
    return attempt(async () => {
      const { plan } = await call<{ plan: TestPlan }>(
        `/api/tests/plans/${encodeURIComponent(id)}`,
        jsonBody(patch),
      );
      set(applyEntity(state, "plan", plan));
      return plan;
    }, "Could not save the test plan");
  },
  deletePlan(id: string) {
    return attempt(async () => {
      await call(`/api/tests/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
      set(removeEntity(state, "plan", id));
      return true;
    }, "Could not delete the test plan");
  },

  startExecution(planId: string, input: { name?: string; assigned?: string } = {}) {
    return attempt(async () => {
      const { execution } = await call<{ execution: TestPlanExecution }>(
        `/api/tests/plans/${encodeURIComponent(planId)}/executions`,
        { method: "POST", body: JSON.stringify(input) },
      );
      set(applyEntity(state, "execution", execution));
      return execution;
    }, "Could not start the run");
  },
  setResult(executionId: string, caseId: string, input: { status: ResultStatus; comment?: string }) {
    return attempt(async () => {
      const { execution } = await call<{ execution: TestPlanExecution }>(
        `/api/tests/executions/${encodeURIComponent(executionId)}/results/${encodeURIComponent(caseId)}`,
        jsonBody(input),
      );
      set(applyEntity(state, "execution", execution));
      return execution;
    }, "Could not record the result");
  },
  updateExecution(id: string, patch: { name?: string; assigned?: string | null; finish?: boolean }) {
    return attempt(async () => {
      const { execution } = await call<{ execution: TestPlanExecution }>(
        `/api/tests/executions/${encodeURIComponent(id)}`,
        jsonBody(patch),
      );
      set(applyEntity(state, "execution", execution));
      return execution;
    }, "Could not save the run");
  },
  deleteExecution(id: string) {
    return attempt(async () => {
      await call(`/api/tests/executions/${encodeURIComponent(id)}`, { method: "DELETE" });
      set(removeEntity(state, "execution", id));
      return true;
    }, "Could not delete the run");
  },
};

// --- Pure store transitions ----------------------------------------------------

export type EntityKind = "case" | "plan" | "execution";

const byCreated = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

/**
 * The store with one entity replaced or added, in the server's order: cases
 * and plans oldest first, executions newest first (src/server/testing.ts).
 */
export function applyEntity(
  store: TestingStore,
  kind: EntityKind,
  entity: TestCase | TestPlan | TestPlanExecution,
): TestingStore {
  const replace = <T extends { id: string }>(list: T[], item: T): T[] => [
    ...list.filter((x) => x.id !== item.id),
    item,
  ];
  switch (kind) {
    case "case":
      return { ...store, cases: replace(store.cases, entity as TestCase).sort(byCreated) };
    case "plan":
      return { ...store, plans: replace(store.plans, entity as TestPlan).sort(byCreated) };
    case "execution":
      return {
        ...store,
        executions: replace(store.executions, entity as TestPlanExecution).sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        ),
      };
  }
}

/** The store without one entity; a deleted case leaves every plan too. */
export function removeEntity(store: TestingStore, kind: EntityKind, id: string): TestingStore {
  switch (kind) {
    case "case":
      return {
        ...store,
        cases: store.cases.filter((c) => c.id !== id),
        plans: store.plans.map((p) =>
          p.caseIds.includes(id) ? { ...p, caseIds: p.caseIds.filter((x) => x !== id) } : p,
        ),
      };
    case "plan":
      return { ...store, plans: store.plans.filter((p) => p.id !== id) };
    case "execution":
      return { ...store, executions: store.executions.filter((e) => e.id !== id) };
  }
}

// --- Vocabulary -------------------------------------------------------------------

/** The runner's order: the neutral state first, then the verdicts. */
export const RESULT_ORDER: readonly ResultStatus[] = [
  "untested",
  "passed",
  "failed",
  "blocked",
  "skipped",
];

export const RESULT_LABEL: Record<ResultStatus, string> = {
  untested: "Untested",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped",
};

/** One-key verdicts in the runner: u/p/f/b/s on a focused row. */
export const RESULT_KEYS: Record<string, ResultStatus> = {
  u: "untested",
  p: "passed",
  f: "failed",
  b: "blocked",
  s: "skipped",
};

export const PRIORITY_ORDER: readonly CasePriority[] = ["low", "medium", "high"];

export const PRIORITY_LABEL: Record<CasePriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

// --- Roll-ups ------------------------------------------------------------------------

export interface Progress {
  total: number;
  untested: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  /** Cases with a verdict — everything but untested. */
  done: number;
}

/** Counts per status over a run's snapshot. */
export function executionProgress(exec: TestPlanExecution): Progress {
  const p: Progress = { total: 0, untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, done: 0 };
  for (const caseId of exec.caseIds) {
    const status = exec.results[caseId]?.status ?? "untested";
    p.total++;
    p[status]++;
  }
  p.done = p.total - p.untested;
  return p;
}

/** A run's headline: what it has decided, in the runner's words. */
export function progressSummary(p: Progress): string {
  if (p.total === 0) return "No cases";
  const parts = RESULT_ORDER.filter((s) => s !== "untested" && p[s] > 0).map(
    (s) => `${p[s]} ${RESULT_LABEL[s].toLowerCase()}`,
  );
  return `${p.done}/${p.total} run${parts.length ? ` · ${parts.join(", ")}` : ""}`;
}

/** The runs of one plan, newest first (the store's order). */
export function executionsOf(planId: string, executions: TestPlanExecution[]): TestPlanExecution[] {
  return executions.filter((e) => e.planId === planId);
}

/**
 * The latest word on a case: its result in the most recent run that included
 * it — Xray's "consolidated status" — or null when it was never run. Scoped
 * to a plan's runs when `planId` is given.
 */
export function latestResultFor(
  caseId: string,
  executions: TestPlanExecution[],
  planId?: string,
): { result: CaseResult; execution: TestPlanExecution } | null {
  for (const execution of executions) {
    if (planId !== undefined && execution.planId !== planId) continue;
    if (!execution.caseIds.includes(caseId)) continue;
    const result = execution.results[caseId];
    if (result) return { result, execution };
  }
  return null;
}

/** What a plan's row reports: its latest run and that run's progress. */
export function planRollup(
  plan: TestPlan,
  executions: TestPlanExecution[],
): { latest: TestPlanExecution | null; progress: Progress | null; runs: number } {
  const runs = executionsOf(plan.id, executions);
  const latest = runs[0] ?? null;
  return { latest, progress: latest ? executionProgress(latest) : null, runs: runs.length };
}

// --- References, links, labels -------------------------------------------------------

/** Where a reference points: the feature page, or the scenario's own page. */
export function refHref(ref: SpecRef): string {
  return ref.scenario ? scenarioPath(ref.fileName, ref.scenario) : featurePath(ref.fileName);
}

/** "Quotes › Basic Quote v2" — the feature's display name when it is listed. */
export function refLabel(ref: SpecRef, features: FeatureListing[]): string {
  const feature = features.find((f) => f.fileName === ref.fileName);
  const name = feature?.name || ref.fileName.replace(/\.feature\.md$/, "");
  return ref.scenario ? `${name} › ${ref.scenario.name} v${ref.scenario.version}` : name;
}

/** One string per reference, for keys and de-duplication. */
export function refKeyOf(ref: SpecRef): string {
  return ref.scenario ? `${ref.fileName}#${ref.scenario.name}@v${ref.scenario.version}` : ref.fileName;
}

/**
 * The members a plan's or run's "Assigned" dropdown offers — the project's,
 * plus whoever it is assigned to when that name left the list.
 */
export function assignableMembers(members: ProjectMember[], assigned?: string): ProjectMember[] {
  if (!assigned || members.some((m) => m.name === assigned)) return members;
  return [...members, { name: assigned }];
}

/** "Sep 5, 14:02" — for run rows and result cells. */
export function formatWhen(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The window title's tail for a view, or "" for the lists. */
export function testsTitle(view: TestsRoute, store: TestingView): string {
  switch (view.kind) {
    case "plans":
      return "Test plans";
    case "cases":
      return "Test cases";
    case "case":
      return store.cases.find((c) => c.id === view.id)?.title ?? "Test case";
    case "plan":
      return store.plans.find((p) => p.id === view.id)?.name ?? "Test plan";
    case "run":
      return store.executions.find((e) => e.id === view.id)?.name ?? "Test run";
  }
}

/** The error boundary's key: a view's identity, so a crash resets on navigation. */
export function testsKey(view: TestsRoute): string {
  return "id" in view ? `tests:${view.kind}:${view.id}` : `tests:${view.kind}`;
}

// --- Palette search -----------------------------------------------------------------

export interface TestsHit {
  kind: "case" | "plan" | "run";
  id: string;
  label: string;
  sub?: string;
  href: string;
  view: TestsRoute;
}

/**
 * The palette's search over the module (specs/search.feature.md): every word
 * of the query must appear in a case's title or body, a plan's name or
 * description, or a run's name — matched client-side, since the server's
 * full-text index knows only markdown. Plans first, then cases, then runs.
 */
export function searchTests(query: string, store: TestingView, limit = 20): TestsHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matches = (text: string) => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
  };
  const hits: TestsHit[] = [];
  for (const p of store.plans) {
    if (matches(`${p.name}\n${p.description}`)) {
      const view: TestsRoute = { kind: "plan", id: p.id };
      hits.push({ kind: "plan", id: p.id, label: p.name, sub: `${p.caseIds.length} case(s)`, href: testsPath(view), view });
    }
  }
  for (const c of store.cases) {
    if (matches(`${c.title}\n${c.body}`)) {
      const view: TestsRoute = { kind: "case", id: c.id };
      hits.push({ kind: "case", id: c.id, label: c.title, sub: PRIORITY_LABEL[c.priority], href: testsPath(view), view });
    }
  }
  for (const e of store.executions) {
    if (matches(e.name)) {
      const plan = store.plans.find((p) => p.id === e.planId);
      const view: TestsRoute = { kind: "run", id: e.id };
      hits.push({ kind: "run", id: e.id, label: e.name, sub: plan?.name ?? "Deleted plan", href: testsPath(view), view });
    }
  }
  return hits.slice(0, limit);
}
