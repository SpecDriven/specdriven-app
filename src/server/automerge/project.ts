// Markdown is a projection of the Automerge document: the same
// `serializeFeature` that always defined the file format, fed from the doc
// instead of an edit buffer. Deterministic by construction — same doc, same
// bytes — so every peer that merges to the same heads writes the same
// `.feature.md`, and git never sees two peers disagree about a merged result.

import type * as A from "@automerge/automerge";
import { serializeFeature, sortScenarios, type Feature } from "../parser";
import type { FeatureDoc } from "./schema";

/** The doc's view of the domain model, in canonical scenario order. */
export function docToFeature(doc: A.Doc<FeatureDoc>): Feature {
  return {
    name: doc.name,
    description: doc.description,
    scenarios: sortScenarios(
      doc.scenarios.map((s) => ({
        name: s.name,
        version: s.version,
        published: s.published,
        proposed: s.proposed,
        body: s.body,
        tests: [...s.tests],
      })),
    ),
  };
}

/** The `.feature.md` text this document projects to. */
export function projectFeature(doc: A.Doc<FeatureDoc>): string {
  return serializeFeature(docToFeature(doc));
}
