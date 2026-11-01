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
    ...(doc.estimate ? { estimate: doc.estimate } : {}),
    ...(doc.done ? { done: true } : {}),
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.date ? { date: doc.date } : {}),
    ...(doc.kind ? { kind: doc.kind } : {}),
    ...(doc.supersedes ? { supersedes: { ...doc.supersedes } } : {}),
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
    ...(page.estimate ? { estimate: page.estimate } : {}),
    ...(page.done ? { done: true } : {}),
    ...(page.author ? { author: page.author } : {}),
    ...(page.date ? { date: page.date } : {}),
    ...(page.kind ? { kind: page.kind } : {}),
    ...(page.supersedes ? { supersedes: { ...page.supersedes } } : {}),
  });
}

/**
 * Drive the document toward a parsed page: heading and body as text splices,
 * so concurrent edits merge at character level, and every metadata field set
 * whole — none of them is text to merge, and concurrent changes to them
 * resolve to the same winner on every peer (reconcile.ts). The notebook's
 * author, date, kind and supersession follow the same rule
 * (specs/app/engineering-notebook.feature.md).
 */
export function reconcilePage(doc: A.Doc<PageDoc>, target: MarkdownPage): A.Doc<PageDoc> {
  const assigned = doc.assigned;
  const estimate = doc.estimate;
  const done = doc.done;
  const author = doc.author;
  const date = doc.date;
  const kind = doc.kind;
  const supersedes = doc.supersedes ? { ...doc.supersedes } : undefined;
  return A.change(doc, (d) => {
    if (d.name !== target.name) A.updateText(d, ["name"], target.name);
    if (d.body !== target.body) A.updateText(d, ["body"], target.body);
    if ((assigned ?? "") !== (target.assigned ?? "")) {
      if (target.assigned) d.assigned = target.assigned;
      else delete d.assigned;
    }
    if ((estimate ?? 0) !== (target.estimate ?? 0)) {
      if (target.estimate) d.estimate = target.estimate;
      else delete d.estimate;
    }
    if ((done ?? false) !== (target.done ?? false)) {
      if (target.done) d.done = true;
      else delete d.done;
    }
    if ((author ?? "") !== (target.author ?? "")) {
      if (target.author) d.author = target.author;
      else delete d.author;
    }
    if ((date ?? "") !== (target.date ?? "")) {
      if (target.date) d.date = target.date;
      else delete d.date;
    }
    if ((kind ?? "") !== (target.kind ?? "")) {
      if (target.kind) d.kind = target.kind;
      else delete d.kind;
    }
    if (!sameLink(supersedes, target.supersedes)) {
      if (target.supersedes) d.supersedes = { ...target.supersedes };
      else delete d.supersedes;
    }
  });
}

/** Two supersession links are the same link, or both absent. */
function sameLink(a?: { title: string; url: string }, b?: { title: string; url: string }): boolean {
  if (!a || !b) return !a && !b;
  return a.title === b.title && a.url === b.url;
}

/**
 * Archive or restore a page (specs/app/roadmap.feature.md "Archive a roadmap
 * page"): the record set whole, or taken out. Nothing else of the document
 * changes, so a restored page projects to exactly what it was archived as.
 */
export function setArchived(
  doc: A.Doc<PageDoc>,
  archived: { at: string; by?: string } | null,
): A.Doc<PageDoc> {
  return A.change(doc, (d) => {
    if (archived) d.archived = { at: archived.at, ...(archived.by ? { by: archived.by } : {}) };
    else delete d.archived;
  });
}
