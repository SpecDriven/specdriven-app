// The Automerge system-of-record for a feature file. The markdown
// `<slug>.feature.md` in the data repo is a deterministic projection of this
// document (src/server/automerge/project.ts); concurrent edits merge at the
// CRDT level instead of surfacing as git conflicts. Spec identity in the
// projection stays (name, version) — the ids below never appear in markdown.
// They are private to the document: the editor only ever holds them as opaque
// handles (parser.ts `Scenario.id`) and hands them back on a save, so a
// scenario renamed in the dialog stays one scenario (reconcile.ts).

import type { EntryKind, ExternalLink, PullRequestLink, ScenarioStatus } from "../parser";
import type { EventModel, Layout, Links } from "../eventModel/types";

// v2: `status` replaced the `published`/`proposed` booleans of v1 and added
// the doc-only `draft` state.
// v3: the `scenarios` list became `specs`, and each entry carries a `type`
// (Scenario or Rule). loadFeatureDoc migrates v1 and v2 docs on load.
export const SCHEMA_VERSION = 3;

/** What kind of spec an entry is. Entries migrated from v1/v2 are Scenarios. */
export type SpecType = "Scenario" | "Rule";

// Type aliases rather than interfaces: Automerge's Doc/from constraints want
// the implicit index signature only aliases carry.

export type SpecEntry = {
  /** Stable identity across renames and merges; minted at import. */
  id: string;
  type: SpecType;
  name: string;
  version: number;
  /**
   * draft | proposed | published. Only proposed and published specs are
   * projected into the `.feature.md`; a draft lives in the document alone.
   */
  status: ScenarioStatus;
  /** Spec markdown (tests section excluded) — collaborative text. */
  body: string;
  /** GitHub urls of the automated tests covering this spec. */
  tests: string[];
  /**
   * The ticket tracking this scenario in a project management tool
   * (specs/external-links/project-management-jira-linear-etc.feature.md).
   * Absent when there is none; set whole, so concurrent edits resolve to
   * one link rather than a mix of two. Added after schema v2 as an optional
   * key — older documents simply lack it, no migration needed.
   */
  link?: ExternalLink;
  /**
   * The pull requests implementing this spec
   * (specs/external-links/related-pull-requests.feature.md). Document-only:
   * the projection never writes them, so nothing markdown-driven can drop
   * them. A list, not a set-whole value, so two peers linking different
   * pull requests concurrently end with both. Optional key, no migration.
   */
  prs?: PullRequestLink[];
};

export type FeatureDoc = {
  schemaVersion: number;
  /** Stable identity of the feature, independent of its file path. */
  id: string;
  name: string;
  /** Free markdown between the feature heading and the first spec. */
  description: string;
  specs: SpecEntry[];
  /** The ticket tracking the feature as a whole, if any (see SpecEntry.link). */
  link?: ExternalLink;
  /** The pull requests implementing the feature as a whole (see SpecEntry.prs). */
  prs?: PullRequestLink[];
  /**
   * Name of the project member the feature is assigned to
   * (src/server/members.ts). Absent when nobody is assigned; set whole, like
   * `link`, so concurrent assignments resolve to one member rather than a mix
   * of two names. Added after schema v3 as an optional key — older documents
   * simply lack it, no migration needed.
   */
  assigned?: string;
};

// Page documents — the roadmap folder's (specs/app/roadmap.feature.md) and
// the tasks folder's (specs/app/tasks.feature.md) — get the same treatment as
// features: the markdown file in the data repo's `roadmap/` or `tasks/`
// folder is a projection of the document below, so two people editing the
// same page merge at the CRDT level instead of conflicting in git. Their own
// schema line — a page has no scenarios, so nothing of FeatureDoc applies to
// it beyond the identity and the assignment. One shape serves both folders:
// a task is a markdown page with an assignee, which is what a roadmap page
// is too.
export const PAGE_SCHEMA_VERSION = 1;

export type PageDoc = {
  schemaVersion: number;
  /** Stable identity of the document, independent of its file path. */
  id: string;
  /** The page's `# <name>` heading; empty for a file that opens without one. */
  name: string;
  /** Everything below the heading — collaborative markdown. */
  body: string;
  /**
   * Name of the project member the page is assigned to
   * (src/server/members.ts). Absent when nobody is assigned; set whole, like
   * a feature's `assigned`, so concurrent assignments resolve to one member
   * rather than a mix of two names.
   */
  assigned?: string;
  /**
   * How long a task is estimated to take, in minutes (specs/app/tasks
   * .feature.md "Add task to Google Calendar"). Set whole like `assigned`.
   */
  estimate?: number;
  /**
   * Whether the page is finished — a task's Done (specs/app/tasks.feature
   * .md). Absent until somebody ticks it off, and set whole like `assigned`,
   * so two people finishing the same task agree rather than merge.
   */
  done?: boolean;
  /**
   * A notebook entry's author, the day it was written and whether it is an
   * observation or a decision
   * (specs/app/engineering-notebook.feature.md). Absent on a roadmap page or
   * a task. Each is set whole like `assigned` — none of them is text to
   * merge — and the author and date are written once at creation, so only
   * the kind is ever changed after the fact.
   */
  author?: string;
  date?: string;
  kind?: EntryKind;
  /**
   * The earlier decision this entry replaces. Set whole: two people pointing
   * one entry at different predecessors resolve to one link rather than a
   * mix of two.
   */
  supersedes?: { title: string; url: string };
};

// Event Model documents (roadmap/support-event-modeling.md): the
// `models/<slug>.model.json` file in the data repo is a projection of the
// document below — canonical JSON (src/server/eventModel/serialize.ts) —
// so two people moving cards on the same canvas merge at the CRDT level.
// The model half keeps the published schema's shape (src/server/eventModel/
// types.ts) as nested maps and lists, so a title edited here and a card
// moved there both land; titles and descriptions are collaborative text.
export const MODEL_SCHEMA_VERSION = 1;

export type ModelDoc = {
  schemaVersion: number;
  /** Stable identity of the document, independent of its file path. */
  id: string;
  /** The model's name — the file's `name`, what the sidebar lists. */
  name: string;
  /** The published schema's half: the slices and everything in them. */
  model: EventModel;
  /** Where each card sits on the canvas. */
  layout: Layout;
  /** Which feature file holds each slice's scenarios. */
  links: Links;
  /** Name of the project member the model is assigned to; set whole. */
  assigned?: string;
};

// Test management (specs/app/tests.feature.md): a lightweight
// TestRail/Xray-style module — a library of test cases, plans that group
// them, and executions that record one result per case of a plan. Unlike
// features and pages, nothing here has a markdown projection: this document
// is the only copy, and it travels through git as chunks like the others.
// One document per data repo, so every entity of the module lives in one
// place and a plan's `caseIds` never point outside the document. Maps keyed
// by id rather than lists, so two peers creating and deleting concurrently
// never fight over positions.
export const TESTING_SCHEMA_VERSION = 1;

/** How one run of one case ended (TestRail's set, minus Retest). */
export type ResultStatus = "untested" | "passed" | "failed" | "blocked" | "skipped";

export const RESULT_STATUSES: readonly ResultStatus[] = [
  "untested",
  "passed",
  "failed",
  "blocked",
  "skipped",
];

export type CasePriority = "low" | "medium" | "high";

export const CASE_PRIORITIES: readonly CasePriority[] = ["low", "medium", "high"];

/**
 * What a test case covers: a whole feature (its repo-relative file name), or
 * one scenario of it — the `scenario` key tells which. Scenario identity is
 * (name, version), the same pick the code gen session dialog uses.
 */
export type SpecRef = {
  fileName: string;
  scenario?: { name: string; version: number };
};

export type TestCase = {
  id: string;
  title: string;
  /** Preconditions, steps, expected results — collaborative markdown. */
  body: string;
  priority: CasePriority;
  /** Replaced whole on save: small, and rarely edited by two people at once. */
  refs: SpecRef[];
  createdAt: string;
  updatedAt: string;
};

export type TestPlan = {
  id: string;
  name: string;
  /** Collaborative markdown. */
  description: string;
  /** The plan's cases in order; reconciled in place like a feature's specs. */
  caseIds: string[];
  /** Project member the plan is assigned to; set whole, like a page's. */
  assigned?: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseResult = {
  status: ResultStatus;
  comment: string;
  /** Who recorded it, when — for the runner's "by" column. */
  by?: string;
  at?: string;
};

export type TestPlanExecution = {
  id: string;
  planId: string;
  name: string;
  /** The plan's cases when the run started — later plan edits leave it alone. */
  caseIds: string[];
  /** One current result per case of the snapshot; history is other runs. */
  results: { [caseId: string]: CaseResult };
  assigned?: string;
  startedAt: string;
  finishedAt?: string;
};

export type TestingDoc = {
  schemaVersion: number;
  /** The fixed genesis id (store.ts newTestingDoc) — one lineage everywhere. */
  id: string;
  cases: { [id: string]: TestCase };
  plans: { [id: string]: TestPlan };
  executions: { [id: string]: TestPlanExecution };
};
