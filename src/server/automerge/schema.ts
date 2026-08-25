// The Automerge system-of-record for a feature file. The markdown
// `<slug>.feature.md` in the data repo is a deterministic projection of this
// document (src/server/automerge/project.ts); concurrent edits merge at the
// CRDT level instead of surfacing as git conflicts. Spec identity in the
// projection stays (name, version) — the ids below never appear in markdown.
// They are private to the document: the editor only ever holds them as opaque
// handles (parser.ts `Scenario.id`) and hands them back on a save, so a
// scenario renamed in the dialog stays one scenario (reconcile.ts).

import type { ExternalLink, ScenarioStatus } from "../parser";

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
  /**
   * Name of the project member the feature is assigned to
   * (src/server/members.ts). Absent when nobody is assigned; set whole, like
   * `link`, so concurrent assignments resolve to one member rather than a mix
   * of two names. Added after schema v3 as an optional key — older documents
   * simply lack it, no migration needed.
   */
  assigned?: string;
};
