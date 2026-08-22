// Markdown is a projection of the Automerge document: the same
// `serializeFeature` that always defined the file format, fed from the doc
// instead of an edit buffer. Deterministic by construction — same doc, same
// bytes — so every peer that merges to the same heads writes the same
// `.feature.md`, and git never sees two peers disagree about a merged result.
//
// Draft scenarios are the exception: they live in the document only
// (specs/automerge-store.spec.md), so the projection writes just the
// published and proposed ones.
//
// External links (specs/external-links/project-management-jira-linear-etc.
// feature.md) are the other: they are in the document always, and in the
// projection only while "Publish external links" is on in Settings. That
// setting is per user, so peers can legitimately disagree on the bytes — a
// file holding either form is a faithful projection (isProjectionOf), and
// neither peer rewrites the other's form just to flip the links.

import type * as A from "@automerge/automerge";
import { serializeFeature, sortScenarios, type ExternalLink, type Feature } from "../parser";
import type { FeatureDoc } from "./schema";

export interface ProjectionOptions {
  /** Write external links into the `.feature.md` (Settings, default ON). */
  publishExternalLinks: boolean;
}

const projection: ProjectionOptions = { publishExternalLinks: true };

/** The settings the projection follows from now on — applied at app start
    and whenever Settings change (src/server/api.ts). */
export function setProjectionOptions(options: Partial<ProjectionOptions>): void {
  Object.assign(projection, options);
}

export function projectionOptions(): ProjectionOptions {
  return { ...projection };
}

/** A plain copy of a link held in the doc (Automerge hands out proxies). */
function plainLink(link: ExternalLink | undefined): ExternalLink | undefined {
  return link ? { program: link.program, ticket: link.ticket, url: link.url } : undefined;
}

/** The doc's view of the domain model — drafts included — in canonical order. */
export function docToFeature(doc: A.Doc<FeatureDoc>): Feature {
  const feature: Feature = {
    name: doc.name,
    description: doc.description,
    scenarios: sortScenarios(
      doc.specs.map((s) => {
        const scenario = {
          name: s.name,
          version: s.version,
          status: s.status,
          body: s.body,
          tests: [...s.tests],
        };
        const link = plainLink(s.link);
        return link ? { ...scenario, link } : scenario;
      }),
    ),
  };
  const link = plainLink(doc.link);
  if (link) feature.link = link;
  return feature;
}

/** The `.feature.md` text this document projects to (drafts left out). */
export function projectFeature(
  doc: A.Doc<FeatureDoc>,
  { publishExternalLinks }: ProjectionOptions = projection,
): string {
  const feature = docToFeature(doc);
  return serializeFeature(
    {
      ...feature,
      scenarios: feature.scenarios.filter((s) => s.status !== "draft"),
    },
    { links: publishExternalLinks },
  );
}

/**
 * Whether `text` is what this document projects to — in this peer's form or
 * the other one, links written or not. The drift pass asks this before
 * absorbing a file, so a peer whose "Publish external links" setting
 * differs is not read as an external edit, and the two never take turns
 * rewriting the same file.
 */
export function isProjectionOf(text: string, doc: A.Doc<FeatureDoc>): boolean {
  return (
    text === projectFeature(doc, { publishExternalLinks: true }) ||
    text === projectFeature(doc, { publishExternalLinks: false })
  );
}
