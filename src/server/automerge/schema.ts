// The Automerge system-of-record for a feature file. The markdown
// `<slug>.feature.md` in the data repo is a deterministic projection of this
// document (src/server/automerge/project.ts); concurrent edits merge at the
// CRDT level instead of surfacing as git conflicts. Scenario identity in the
// projection stays (name, version) — the ids below never appear in markdown.
// They are private to the document: the editor only ever holds them as opaque
// handles (parser.ts `Scenario.id`) and hands them back on a save, so a
// scenario renamed in the dialog stays one scenario (reconcile.ts).

import type { ScenarioStatus } from "../parser";

// v2: `status` replaced the `published`/`proposed` booleans of v1 and added
// the doc-only `draft` state. loadFeatureDoc migrates v1 docs on load.
export const SCHEMA_VERSION = 2;

// Type aliases rather than interfaces: Automerge's Doc/from constraints want
// the implicit index signature only aliases carry.

export type ScenarioEntry = {
  /** Stable identity across renames and merges; minted at import. */
  id: string;
  name: string;
  version: number;
  /**
   * draft | proposed | published. Only proposed and published scenarios are
   * projected into the `.feature.md`; a draft lives in the document alone.
   */
  status: ScenarioStatus;
  /** Scenario markdown (tests section excluded) — collaborative text. */
  body: string;
  /** GitHub urls of the automated tests covering this scenario. */
  tests: string[];
};

export type FeatureDoc = {
  schemaVersion: number;
  /** Stable identity of the feature, independent of its file path. */
  id: string;
  name: string;
  /** Free markdown between the feature heading and the first scenario. */
  description: string;
  scenarios: ScenarioEntry[];
};
