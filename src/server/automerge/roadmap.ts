// The Automerge system-of-record for a roadmap page (specs/app/roadmap.feature
// .md), the plain-markdown counterpart of project.ts + reconcile.ts. A page's
// `roadmap/<name>.md` is a deterministic projection of its document, so two
// people editing the same page merge at the CRDT level — the body as
// collaborative text, the assignment replaced whole — instead of meeting in a
// git conflict.
//
// A page has no scenarios and no ticket link, so there is one projection form
// rather than the feature's two: the document's markdown is the file's bytes.

import * as A from "@automerge/automerge";
import { serializeRoadmap, type Roadmap } from "../parser";
import type { RoadmapDoc } from "./schema";
import { newRoadmapDoc } from "./store";

/** The doc's view of the page. */
export function docToRoadmap(doc: A.Doc<RoadmapDoc>): Roadmap {
  return {
    name: doc.name,
    body: doc.body,
    ...(doc.assigned ? { assigned: doc.assigned } : {}),
  };
}

/** The markdown this document projects to. */
export function projectRoadmap(doc: A.Doc<RoadmapDoc>): string {
  return serializeRoadmap(docToRoadmap(doc));
}

/** Whether `text` is what this document projects to. */
export function isRoadmapProjectionOf(text: string, doc: A.Doc<RoadmapDoc>): boolean {
  return text === projectRoadmap(doc);
}

/** Create a document from a parsed roadmap page (first import). */
export function importRoadmapDoc(page: Roadmap): A.Doc<RoadmapDoc> {
  return newRoadmapDoc({
    name: page.name,
    body: page.body,
    ...(page.assigned ? { assigned: page.assigned } : {}),
  });
}

/**
 * Drive the document toward a parsed page: heading and body as text splices,
 * so concurrent edits merge at character level, and the assignment set whole
 * — it is one member, not text to merge, and concurrent assignments resolve
 * to the same winner on every peer (reconcile.ts).
 */
export function reconcileRoadmap(doc: A.Doc<RoadmapDoc>, target: Roadmap): A.Doc<RoadmapDoc> {
  const assigned = doc.assigned;
  return A.change(doc, (d) => {
    if (d.name !== target.name) A.updateText(d, ["name"], target.name);
    if (d.body !== target.body) A.updateText(d, ["body"], target.body);
    if ((assigned ?? "") !== (target.assigned ?? "")) {
      if (target.assigned) d.assigned = target.assigned;
      else delete d.assigned;
    }
  });
}
