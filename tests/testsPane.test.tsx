// specs/app/tests.feature.md on the client: the module's roll-ups
// (a plan reports its latest run, a case its latest verdict), the palette's
// search over the store, the store transitions a mutation applies, and the
// rows and badges the pane renders. Pure helpers and static markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanRow, ProgressBar, RefChip, ResultBadge, ResultRow, RunRow } from "../src/frontend/TestsPane";
import {
  EMPTY_TESTING,
  applyEntity,
  executionProgress,
  latestResultFor,
  planRollup,
  progressSummary,
  refHref,
  refLabel,
  removeEntity,
  searchTests,
  testsKey,
  testsTitle,
  type TestCase,
  type TestPlan,
  type TestPlanExecution,
} from "../src/frontend/testing";
import type { FeatureListing } from "../src/server/features";

const T0 = "2026-09-01T10:00:00.000Z";
const T1 = "2026-09-02T10:00:00.000Z";
const T2 = "2026-09-03T10:00:00.000Z";

const caseA: TestCase = {
  id: "a", title: "Quote totals", body: "Check the total", priority: "high",
  refs: [{ fileName: "billing/quotes.feature.md", scenario: { name: "Basic Quote", version: 2 } }],
  createdAt: T0, updatedAt: T0,
};
const caseB: TestCase = {
  id: "b", title: "Renewal notice", body: "", priority: "low",
  refs: [{ fileName: "billing/renewals.feature.md" }],
  createdAt: T1, updatedAt: T1,
};
const plan: TestPlan = {
  id: "p", name: "Release 1", description: "Smoke", caseIds: ["a", "b"], createdAt: T0, updatedAt: T0,
};
const run1: TestPlanExecution = {
  id: "r1", planId: "p", name: "Run 1", caseIds: ["a", "b"],
  results: { a: { status: "failed", comment: "off by one" }, b: { status: "passed", comment: "" } },
  startedAt: T1, finishedAt: T1,
};
const run2: TestPlanExecution = {
  id: "r2", planId: "p", name: "Run 2", caseIds: ["a"],
  results: { a: { status: "passed", comment: "", by: "Ada", at: T2 } },
  startedAt: T2,
};
const store = { ...EMPTY_TESTING, loaded: true, cases: [caseA, caseB], plans: [plan], executions: [run2, run1] };
const features: FeatureListing[] = [
  { fileName: "billing/quotes.feature.md", name: "Quotes", scenarios: [{ name: "Basic Quote", version: 2, status: "published" }] },
];

describe("roll-ups", () => {
  test("a run's progress counts each verdict", () => {
    expect(executionProgress(run1)).toEqual({ total: 2, untested: 0, passed: 1, failed: 1, blocked: 0, skipped: 0, done: 2 });
    expect(progressSummary(executionProgress(run1))).toBe("2/2 run · 1 passed, 1 failed");
    expect(progressSummary(executionProgress({ ...run2, results: {} }))).toBe("0/1 run");
  });

  test("a case's latest verdict comes from the most recent run that included it", () => {
    expect(latestResultFor("a", store.executions)?.result.status).toBe("passed");
    expect(latestResultFor("a", store.executions)?.execution.id).toBe("r2");
    // b was not in run 2, so run 1 still speaks for it.
    expect(latestResultFor("b", store.executions)?.execution.id).toBe("r1");
    expect(latestResultFor("zzz", store.executions)).toBeNull();
    expect(latestResultFor("a", store.executions, "other-plan")).toBeNull();
  });

  test("a plan reports its latest run", () => {
    const rollup = planRollup(plan, store.executions);
    expect(rollup.latest?.id).toBe("r2");
    expect(rollup.runs).toBe(2);
    expect(rollup.progress?.done).toBe(1);
    expect(planRollup({ ...plan, id: "q" }, store.executions)).toEqual({ latest: null, progress: null, runs: 0 });
  });
});

describe("store transitions", () => {
  test("applyEntity replaces or adds, keeping the server's order", () => {
    const edited = applyEntity(store, "case", { ...caseA, title: "Quote totals (v2)" });
    expect(edited.cases.map((c) => c.title)).toEqual(["Quote totals (v2)", "Renewal notice"]);
    const older: TestPlanExecution = { ...run1, id: "r0", startedAt: T0 };
    expect(applyEntity(store, "execution", older).executions.map((e) => e.id)).toEqual(["r2", "r1", "r0"]);
    const newer: TestCase = { ...caseB, id: "c", createdAt: "2026-09-09T00:00:00.000Z" };
    expect(applyEntity(store, "case", newer).cases.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("removing a case takes it out of every plan", () => {
    const next = removeEntity(store, "case", "a");
    expect(next.cases.map((c) => c.id)).toEqual(["b"]);
    expect(next.plans[0]!.caseIds).toEqual(["b"]);
    expect(removeEntity(store, "plan", "p").plans).toEqual([]);
    expect(removeEntity(store, "execution", "r1").executions.map((e) => e.id)).toEqual(["r2"]);
  });
});

describe("links, titles, search", () => {
  test("a reference links to the feature or the scenario page", () => {
    expect(refHref(caseA.refs[0]!)).toBe("/features/billing/quotes/scenarios/basic-quote/v2");
    expect(refHref(caseB.refs[0]!)).toBe("/features/billing/renewals");
    expect(refLabel(caseA.refs[0]!, features)).toBe("Quotes › Basic Quote v2");
    // An unlisted feature falls back to its path.
    expect(refLabel(caseB.refs[0]!, features)).toBe("billing/renewals");
  });

  test("titles and keys follow the view", () => {
    expect(testsTitle({ kind: "plans" }, store)).toBe("Test plans");
    expect(testsTitle({ kind: "plan", id: "p" }, store)).toBe("Release 1");
    expect(testsTitle({ kind: "case", id: "nope" }, store)).toBe("Test case");
    expect(testsTitle({ kind: "run", id: "r2" }, store)).toBe("Run 2");
    expect(testsKey({ kind: "cases" })).toBe("tests:cases");
    expect(testsKey({ kind: "run", id: "r2" })).toBe("tests:run:r2");
  });

  test("the palette searches plans, then cases, then runs", () => {
    expect(searchTests("", store)).toEqual([]);
    expect(searchTests("quote", store).map((h) => `${h.kind}:${h.id}`)).toEqual(["case:a"]);
    expect(searchTests("release", store).map((h) => h.kind)).toEqual(["plan"]);
    expect(searchTests("run", store).map((h) => h.id)).toEqual(["r2", "r1"]);
    // Every word must match; the body counts.
    expect(searchTests("check total", store).map((h) => h.id)).toEqual(["a"]);
    expect(searchTests("check nothing", store)).toEqual([]);
    expect(searchTests("run", store)[0]!.href).toBe("/tests/runs/r2");
  });
});

describe("markup", () => {
  const go = () => {};
  test("badges and bars carry their status classes", () => {
    expect(renderToStaticMarkup(<ResultBadge status="failed" />)).toContain('class="result-badge failed"');
    expect(renderToStaticMarkup(<ResultBadge status="untested" muted />)).toContain("untested muted");
    const bar = renderToStaticMarkup(<ProgressBar progress={executionProgress(run1)} />);
    expect(bar).toContain("progress-seg passed");
    expect(bar).toContain("progress-seg failed");
    expect(bar).not.toContain("progress-seg blocked");
    expect(bar).toContain("2/2 run");
  });

  test("a plan row links to the plan and its latest run", () => {
    const html = renderToStaticMarkup(
      <table><tbody><PlanRow plan={plan} executions={store.executions} assignments={true} go={go} /></tbody></table>,
    );
    expect(html).toContain('href="/tests/plans/p"');
    expect(html).toContain('href="/tests/runs/r2"');
    expect(html).toContain("Run 2");
    expect(html).toContain("2 runs");
    expect(html).toContain("—"); // unassigned
  });

  test("a run row shows its state; a deleted plan is named as such", () => {
    const html = renderToStaticMarkup(
      <table><tbody><RunRow run={run1} plan={null} go={go} showPlan /></tbody></table>,
    );
    expect(html).toContain("Deleted plan");
    expect(html).toContain("run-state finished");
    expect(renderToStaticMarkup(<table><tbody><RunRow run={run2} plan={plan} go={go} /></tbody></table>)).toContain("In progress");
  });

  test("a reference chip links to the scenario with its status glyph", () => {
    const html = renderToStaticMarkup(<RefChip spec={caseA.refs[0]!} features={features} />);
    expect(html).toContain('href="/features/billing/quotes/scenarios/basic-quote/v2"');
    expect(html).toContain("status-icon published");
    expect(html).toContain("Quotes › Basic Quote v2");
  });

  test("a result row offers the five verdicts and marks the recorded one", () => {
    const html = renderToStaticMarkup(
      <table><tbody><ResultRow index={0} run={run2} caseId="a" testCase={caseA} features={features} go={go} readOnly={false} /></tbody></table>,
    );
    const radios = [...html.matchAll(/role="radio"[^>]*aria-checked="(true|false)"[^>]*class="result-opt (\w+)/g)].map((m) => `${m[2]}:${m[1]}`);
    expect(radios).toEqual(["untested:false", "passed:true", "failed:false", "blocked:false", "skipped:false"]);
    expect(html).toContain("Ada · ");
    // A finished run's row is read-only.
    const done = renderToStaticMarkup(
      <table><tbody><ResultRow index={1} run={run1} caseId="zzz" testCase={null} features={features} go={go} readOnly /></tbody></table>,
    );
    expect(done).toContain("(deleted case)");
    expect(done).toContain("disabled");
  });
});
