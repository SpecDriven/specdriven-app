// The test management module's urls (specs/app/tests.feature.md "Tests views
// have urls"), owned by the plugin rather than by src/frontend/route.ts:
//
//   /tests                                          test plans
//   /tests/cases                                    the test case library
//   /tests/cases/<id>, /tests/plans/<id>, /tests/runs/<id>

/**
 * The module's views: the plan list, the case library, or one case, plan or
 * run by its document id.
 */
export type TestsRoute =
  | { kind: "plans" }
  | { kind: "cases" }
  | { kind: "case"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "run"; id: string };

const TESTS_SEGMENTS: Record<string, "case" | "plan" | "run"> = {
  cases: "case",
  plans: "plan",
  runs: "run",
};

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The view a url names, or null when the url is not the module's. `/tests`
 * is the plan list, `/tests/cases` the library, and an id after `cases`,
 * `plans` or `runs` opens that one; anything else under `/tests` falls back
 * to the plan list.
 */
export function parseTestsRoute(pathname: string): TestsRoute | null {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== "tests") return null;
  if (segs[1] === "cases" && !segs[2]) return { kind: "cases" };
  const kind = segs[1] ? TESTS_SEGMENTS[segs[1]] : undefined;
  if (kind && segs[2]) return { kind, id: segs[2] };
  return { kind: "plans" };
}

/** The url of a view — the inverse of parseTestsRoute. */
export function testsPath(view: TestsRoute): string {
  switch (view.kind) {
    case "plans":
      return "/tests";
    case "cases":
      return "/tests/cases";
    case "case":
      return `/tests/cases/${encodeURIComponent(view.id)}`;
    case "plan":
      return `/tests/plans/${encodeURIComponent(view.id)}`;
    case "run":
      return `/tests/runs/${encodeURIComponent(view.id)}`;
  }
}
