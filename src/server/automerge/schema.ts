// The Automerge system-of-record for a feature file. The markdown
// `<slug>.feature.md` in the data repo is a deterministic projection of this
// document (src/server/automerge/project.ts); concurrent edits merge at the
// CRDT level instead of surfacing as git conflicts. Scenario identity in the
// projection stays (name, version) — the ids below never appear in markdown.

export const SCHEMA_VERSION = 1;

// Type aliases rather than interfaces: Automerge's Doc/from constraints want
// the implicit index signature only aliases carry.

export type ScenarioEntry = {
  /** Stable identity across renames and merges; minted at import. */
  id: string;
  name: string;
  version: number;
  published: boolean;
  proposed: boolean;
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
