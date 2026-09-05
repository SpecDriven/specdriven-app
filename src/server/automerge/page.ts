// The Automerge system-of-record for a markdown page — a roadmap page
// (specs/app/roadmap.feature.md) or a task (specs/app/tasks.feature.md) —
// the plain-markdown counterpart of project.ts + reconcile.ts. A page's
// `<folder>/<name>.md` is a deterministic projection of its document, so two
// people editing the same page merge at the CRDT level — the body as
// collaborative text, the assignment replaced whole — instead of meeting in a
// git conflict.
//
// A page has no scenarios and no ticket link, so there is one projection form
// rather than the feature's two: the document's markdown is the file's bytes.
// Roadmap pages and tasks share this module whole — a task is a markdown page
// with an assignee, which is exactly what a roadmap page is.

import * as A from "@automerge/automerge";
import { serializePage, type MarkdownPage } from "../parser";
import type { PageDoc } from "./schema";
import { newPageDoc } from "./store";

/** The doc's view of the page. */
export function docToPage(doc: A.Doc<PageDoc>): MarkdownPage {
  return {
    name: doc.name,
    body: doc.body,
    ...(doc.assigned ? { assigned: doc.assigned } : {}),
  };
}

/** The markdown this document projects to. */
export function projectPage(doc: A.Doc<PageDoc>): string {
  return serializePage(docToPage(doc));
}

/** Whether `text` is what this document projects to. */
export function isPageProjectionOf(text: string, doc: A.Doc<PageDoc>): boolean {
  return text === projectPage(doc);
}

/** Create a document from a parsed page (first import). */
export function importPageDoc(page: MarkdownPage): A.Doc<PageDoc> {
  return newPageDoc({
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
export function reconcilePage(doc: A.Doc<PageDoc>, target: MarkdownPage): A.Doc<PageDoc> {
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
