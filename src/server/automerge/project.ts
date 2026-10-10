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
//
// Authorship (specs/app/specs-authorship.feature.md) is the same kind of
// exception, decided per data repo instead of per user: who created and last
// updated the feature and each spec is in the document always, and in the
// projection only while the repo's project-settings.json turns
// `authors-in-markdown` on (src/server/members.ts). A file in either form is
// a faithful projection, for the same reason as the links.
//
// A published spec projects the body it was published with (schema.ts
// `publishedBody`), not its live collaborative text: the two differ only
// while a merge artifact waits for the drift pass to heal it, and that
// artifact must never be rendered, written or absorbed.

import type * as A from "@automerge/automerge";
import {
  serializeFeature,
  sortScenarios,
  type ExternalLink,
  type Feature,
  type PullRequestLink,
  type ScenarioFile,
} from "../parser";
import { readProjectSettings } from "../members";
import { effectiveBody, type FeatureDoc } from "./schema";

export interface ProjectionOptions {
  /** Write external links into the `.feature.md` (Settings, default ON). */
  publishExternalLinks: boolean;
  /**
   * Write who created and last updated the feature and each spec into the
   * `.feature.md` — the data repo's `authors-in-markdown` (default OFF).
   * Not a device setting: projectionFor reads it from the repo.
   */
  publishAuthors?: boolean;
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

/**
 * The options a projection into this data repo follows: the device's
 * settings, plus whether the repo asks for authorship in its markdown
 * (project-settings.json `authors-in-markdown`). Every write of a
 * `.feature.md` projects through this, so each repo gets its own form.
 */
export async function projectionFor(dataDir: string): Promise<ProjectionOptions> {
  const { authorsInMarkdown } = await readProjectSettings(dataDir);
  return { ...projection, publishAuthors: authorsInMarkdown };
}

/** A plain copy of a link held in the doc (Automerge hands out proxies). */
function plainLink(link: ExternalLink | undefined): ExternalLink | undefined {
  return link ? { program: link.program, ticket: link.ticket, url: link.url } : undefined;
}

/** Plain copies of the pull request links held in the doc; undefined when none. */
function plainPrs(prs: PullRequestLink[] | undefined): PullRequestLink[] | undefined {
  return prs && prs.length > 0 ? prs.map((p) => ({ url: p.url, title: p.title })) : undefined;
}

/** Plain copies of the files listed in the doc; undefined when none. */
function plainFiles(files: ScenarioFile[] | undefined): ScenarioFile[] | undefined {
  return files && files.length > 0
    ? files.map((f) => ({ name: f.name, file: f.file, size: f.size }))
    : undefined;
}

/**
 * The doc's view of the domain model — drafts included — in canonical order.
 * Pull request links and stored files come along (the editor shows them) but
 * serializeFeature never writes them, so the projection below stays free of them.
 */
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
          // A published spec renders the body it was published with, not
          // the live text a merge may have doubled (schema.ts publishedBody).
          body: effectiveBody(s),
          tests: [...s.tests],
        };
        const link = plainLink(s.link);
        const prs = plainPrs(s.prs);
        const files = plainFiles(s.files);
        return {
          ...scenario,
          ...(link ? { link } : {}),
          ...(prs ? { prs } : {}),
          ...(files ? { files } : {}),
          ...(s.createdBy ? { createdBy: s.createdBy } : {}),
          ...(s.updatedBy ? { updatedBy: s.updatedBy } : {}),
        };
      }),
    ),
  };
  const link = plainLink(doc.link);
  if (link) feature.link = link;
  const prs = plainPrs(doc.prs);
  if (prs) feature.prs = prs;
  if (doc.assigned) feature.assigned = doc.assigned;
  if (doc.createdBy) feature.createdBy = doc.createdBy;
  if (doc.updatedBy) feature.updatedBy = doc.updatedBy;
  return feature;
}

/** The `.feature.md` text this document projects to (drafts left out). */
export function projectFeature(
  doc: A.Doc<FeatureDoc>,
  { publishExternalLinks, publishAuthors = false }: ProjectionOptions = projection,
): string {
  const feature = docToFeature(doc);
  return serializeFeature(
    {
      ...feature,
      scenarios: feature.scenarios.filter((s) => s.status !== "draft"),
    },
    { links: publishExternalLinks, authors: publishAuthors },
  );
}

/**
 * Whether `text` is what this document projects to — in this peer's form or
 * another one, links written or not, authors written or not. The drift pass
 * asks this before absorbing a file, so a peer whose "Publish external
 * links" setting differs — or one that has not seen the repo's
 * `authors-in-markdown` change yet — is not read as an external edit, and
 * the two never take turns rewriting the same file.
 */
export function isProjectionOf(text: string, doc: A.Doc<FeatureDoc>): boolean {
  for (const publishExternalLinks of [true, false]) {
    for (const publishAuthors of [false, true]) {
      if (text === projectFeature(doc, { publishExternalLinks, publishAuthors })) return true;
    }
  }
  return false;
}
