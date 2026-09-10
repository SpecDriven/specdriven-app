// Deep-link urls (specs/navigation.spec.md):
//
//   /                                               home
//   /roadmap/<page>                                 roadmap page
//   /tasks/<task>                                   task
//   /models/<model>                                 an Event Model's canvas
//   /features/<feature>                             feature page
//   /features/<feature>/scenarios/<scenario>        latest version of the scenario
//   /features/<feature>/scenarios/<scenario>/v<N>   exactly version N
//   /tests                                          test plans (specs/app/tests.feature.md)
//   /tests/cases                                    the test case library
//   /tests/cases/<id>, /tests/plans/<id>, /tests/runs/<id>
//   /issues                                         GitHub issues (specs/app/github-issues.feature.md)
//   /issues/new                                     the new-issue form
//   /issues/<number>                                one issue
//
// <feature> is the file path minus `.feature.md` and may span several
// segments when the feature lives in a folder (`billing/quotes`); <scenario>
// is slugify(scenario name). The first `scenarios` segment with something
// after it splits feature from scenario — so a folder literally named
// `scenarios` is not addressable by deep link. Segments after the scenario
// version are ignored, and a path that doesn't start with a known shape is
// home.

import { slugify } from "../server/parser";
import type { Scenario } from "../server/parser";

export interface ScenarioRef {
  slug: string;
  /** Absent means "latest version of this name". */
  version?: number;
}

export interface Route {
  /** Feature file name, with the `.feature.md` suffix restored. */
  feature?: string;
  scenario?: ScenarioRef;
  /**
   * A special folder's page — a roadmap page (specs/app/roadmap.feature.md)
   * or a task (specs/app/tasks.feature.md) — as its file name, repo-relative
   * and with the `.md` suffix restored: `roadmap/pricing.md`, `tasks/ship.md`.
   * The folder it opens with is what says which of the two it is.
   */
  page?: string;
  /**
   * An Event Model (roadmap/support-event-modeling.md) as its file name,
   * repo-relative and with the `.model.json` suffix restored:
   * `models/cart.model.json`.
   */
  model?: string;
  /** A view of the test management module (specs/app/tests.feature.md). */
  tests?: TestsRoute;
  /** A view of the GitHub issues module (specs/app/github-issues.feature.md). */
  issues?: IssuesRoute;
}

/** The GitHub issues module's views: the list, the new-issue form, or one issue. */
export type IssuesRoute = { kind: "list" } | { kind: "new" } | { kind: "issue"; number: number };

/**
 * The test management module's views: the plan list, the case library, or
 * one case, plan or run by its document id.
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

const VERSION_SEG = /^v([1-9]\d*)$/;

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  // The test management module: `/tests` is its plan list, `/tests/cases`
  // the library, and an id after `cases`, `plans` or `runs` opens that one.
  // Anything else under `/tests` falls back to the plan list.
  if (segs[0] === "tests") {
    if (segs[1] === "cases" && !segs[2]) return { tests: { kind: "cases" } };
    const kind = segs[1] ? TESTS_SEGMENTS[segs[1]] : undefined;
    if (kind && segs[2]) return { tests: { kind, id: segs[2] } };
    return { tests: { kind: "plans" } };
  }
  // GitHub issues: `/issues` is the list, `/issues/new` the form, and a
  // number opens that issue. Anything else under `/issues` is the list.
  if (segs[0] === "issues") {
    if (segs[1] === "new" && !segs[2]) return { issues: { kind: "new" } };
    const number = segs[1] && /^[1-9]\d*$/.test(segs[1]) && !segs[2] ? Number(segs[1]) : null;
    if (number !== null) return { issues: { kind: "issue", number } };
    return { issues: { kind: "list" } };
  }
  // A roadmap page or a task is a plain path under the folder it lives in; a
  // hand-typed link may carry the `.md` suffix already.
  if (segs[0] && PAGE_FOLDERS.includes(segs[0]) && segs[1]) {
    const path = segs.slice(1).join("/").replace(/\.md$/, "");
    return { page: `${segs[0]}/${path}.md` };
  }
  // An Event Model is a plain path under its folder the same way; a link
  // may carry the `.model.json` suffix already.
  if (segs[0] === MODELS_FOLDER && segs[1]) {
    const path = segs.slice(1).join("/").replace(/\.model\.json$/, "");
    return { model: `${MODELS_FOLDER}/${path}.model.json` };
  }
  if (segs[0] !== "features" || !segs[1]) return {};
  // The feature path runs up to the first `scenarios` segment that has a slug
  // after it (folders make feature paths multi-segment).
  let split = segs.findIndex((s, i) => i >= 2 && s === "scenarios" && segs[i + 1]);
  if (split === -1) {
    // No scenario ref: the whole tail is the feature path, except a trailing
    // bare `scenarios` — that's a mangled scenario link tail, not a folder.
    const last = segs.length - 1;
    split = last >= 2 && segs[last] === "scenarios" ? last : segs.length;
  }
  const parts = segs.slice(1, split);
  // Accept a stem that already carries the `.feature.md` (or legacy
  // `.feature`) suffix — hand-edited links shouldn't double it up.
  const stem = parts.join("/").replace(/\.feature(\.md)?$/, "");
  const route: Route = { feature: `${stem}.feature.md` };
  if (segs[split] !== "scenarios" || !segs[split + 1]) return route;
  route.scenario = { slug: segs[split + 1]! };
  const version = segs[split + 2]?.match(VERSION_SEG);
  if (version) route.scenario.version = Number(version[1]);
  return route;
}

/**
 * Scheme the desktop app registers with the OS (specs/navigation.spec.md
 * "links from outside the app"). Inside the desktop window the origin is
 * `app://specdriven`, which nothing else on the machine can reach, so links
 * meant to be shared use this scheme over the same paths.
 */
export const DESKTOP_SCHEME = "specdriven";

/** `/features/quotes` -> `specdriven://features/quotes`. */
export function desktopLink(path: string): string {
  return `${DESKTOP_SCHEME}://${path.replace(/^\/+/, "")}`;
}

/**
 * Sidebar display name for the configured data repo
 * (specs/app-start.spec.md): just the folder or GitHub repo name — the
 * parent folders stay in the header's tooltip and in the edit dialog.
 */
export function repoDisplayName(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.git$/, "") || repo;
}

/** The special folders' names, shared with the server (src/server/pages.ts). */
export const PAGE_FOLDERS = ["roadmap", "tasks"];

/** The Event Models' folder, shared with the server (src/server/models.ts). */
export const MODELS_FOLDER = "models";

/** `models/shop/cart.model.json` -> `/models/shop/cart`. */
export function modelLink(fileName: string): string {
  const stem = fileName.slice(MODELS_FOLDER.length + 1).replace(/\.model\.json$/, "");
  return `/${MODELS_FOLDER}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** The folder a page's file name lives in — `roadmap` or `tasks`. */
export function pageFolderOf(fileName: string): string {
  return fileName.split("/")[0] ?? "";
}

/** `roadmap/q3/pricing.md` -> `/roadmap/q3/pricing`; `tasks/ship.md` likewise. */
export function pageLink(fileName: string): string {
  const folder = pageFolderOf(fileName);
  const stem = fileName.slice(folder.length + 1).replace(/\.md$/, "");
  return `/${folder}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** The url of a test management view — the inverse of parseRoute's `tests`. */
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

/** The url of a GitHub issues view — the inverse of parseRoute's `issues`. */
export function issuesPath(view: IssuesRoute): string {
  switch (view.kind) {
    case "list":
      return "/issues";
    case "new":
      return "/issues/new";
    case "issue":
      return `/issues/${view.number}`;
  }
}

export function featurePath(fileName: string): string {
  const stem = fileName.replace(/\.feature\.md$/, "");
  // Folder segments keep their `/`s; anything a url can't carry is escaped.
  return `/features/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

export function scenarioPath(
  fileName: string,
  scenario: Pick<Scenario, "name" | "version">,
): string {
  return `${featurePath(fileName)}/scenarios/${slugify(scenario.name)}/v${scenario.version}`;
}

/**
 * The url of what is on screen (specs/navigation.spec.md "URL scheme"): the
 * scenario's own url while its page is open, otherwise the feature's, and `/`
 * with no feature open. A roadmap page or a task takes the same pane a
 * feature does, so while one is open its own url is what the address bar
 * shows (specs/app/tasks.feature.md "Support deep link just like Features").
 */
export function pagePath(
  fileName: string | null,
  scenario: Pick<Scenario, "name" | "version"> | null,
  page: string | null = null,
  model: string | null = null,
): string {
  if (model) return modelLink(model);
  if (page) return pageLink(page);
  if (!fileName) return "/";
  return scenario ? scenarioPath(fileName, scenario) : featurePath(fileName);
}

/**
 * Resolve a scenario ref against a parsed feature: exact version when the ref
 * has one, otherwise the highest version of that name. On slug collisions the
 * first match in file order wins (specs/navigation.spec.md). Returns the
 * scenario's list index, or null if nothing matches.
 */
export function resolveScenario(scenarios: Scenario[], ref: ScenarioRef): number | null {
  let best: number | null = null;
  scenarios.forEach((s, i) => {
    if (slugify(s.name) !== ref.slug) return;
    if (ref.version !== undefined) {
      if (s.version === ref.version && best === null) best = i;
    } else if (best === null || s.version > scenarios[best]!.version) {
      best = i;
    }
  });
  return best;
}
