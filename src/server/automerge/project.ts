// Markdown is a projection of the Automerge document: the same
// `serializeFeature` that always defined the file format, fed from the doc
// instead of an edit buffer. Deterministic by construction — same doc, same
// bytes — so every peer that merges to the same heads writes the same
// `.feature.md`, and git never sees two peers disagree about a merged result.
//
// Draft scenarios are the exception: they live in the document only
// (specs/datastore/automerge-store.feature.md), so the projection writes just
// the published and proposed ones.
//
// External links (specs/external-links/project-management-jira-linear-etc.
// feature.md) are the other: they are in the document always, and in the
// projection only while "Publish external links" is on in Settings. That
// setting is per user, so peers can legitimately disagree on the bytes — a
// file holding either form is a faithful projection (isProjectionOf), and
// neither peer rewrites the other's form just to flip the links. qTest test
// case links (specs/external-links/qtest-test-cases.feature.md) are external
// links too, and follow the same setting.
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
  plainAttributes,
  plainFeatureFlags,
  serializeFeature,
  type ExternalLink,
  type Feature,
  type PullRequestLink,
  type ResourceLink,
  type ScenarioFile,
} from "../parser";
import { readProjectSettings } from "../members";
import { effectiveBody, ticketLinksOf, type FeatureDoc } from "./schema";

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

/** Plain copies of the Aha! or Figma links held in the doc; undefined when none. */
function plainResources(links: ResourceLink[] | undefined): ResourceLink[] | undefined {
  return links && links.length > 0 ? links.map((l) => ({ url: l.url, title: l.title })) : undefined;
}

/** Plain copies of the files listed in the doc; undefined when none. */
function plainFiles(files: ScenarioFile[] | undefined): ScenarioFile[] | undefined {
  return files && files.length > 0
    ? files.map((f) => ({ name: f.name, file: f.file, size: f.size }))
    : undefined;
}

/** What orders a spec among its feature's: its rank, then the legacy keys. */
export interface Ranked {
  rank?: number;
  name: string;
  version: number;
}

/**
 * The order of a feature's specs (specs/ui/ui.feature.md "number
 * scenarios"): by `rank` — the position the last write stamped (schema.ts) —
 * then by name and version, which is the whole order for a document from
 * before the ranks and the tie-break when two peers moved scenarios
 * concurrently. Unranked specs sort after ranked ones.
 */
export function compareSpecs(a: Ranked, b: Ranked): number {
  const ra = a.rank ?? Number.POSITIVE_INFINITY;
  const rb = b.rank ?? Number.POSITIVE_INFINITY;
  return (ra - rb || 0) || a.name.localeCompare(b.name) || a.version - b.version;
}

export function orderSpecs<T extends Ranked>(specs: readonly T[]): T[] {
  return [...specs].sort(compareSpecs);
}

/**
 * One order for the scenarios a file holds and the document's drafts, which
 * it does not: the file's order stands for what it holds (a hand edit that
 * moved a heading is the user's order, absorbed or not), and each draft goes
 * right after the nearest entry before it in the document's order that the
 * file holds — at the front when there is none. The editor's view
 * (features.ts featureView) and reconcile both place drafts through this,
 * so a draft the editor opened next to its source stays there across saves.
 * `held` is the file's scenarios in file order, `docOrder` the document's
 * specs in rank order — drafts included — and `key` identifies one across
 * both lists.
 */
export function interleaveDrafts<T>(held: T[], docOrder: T[], key: (s: T) => string): T[] {
  const result = [...held];
  const heldKeys = new Set(held.map(key));
  let insertAt = 0;
  for (const entry of docOrder) {
    const k = key(entry);
    if (heldKeys.has(k)) {
      insertAt = result.findIndex((s) => key(s) === k) + 1;
    } else {
      result.splice(insertAt, 0, entry);
      insertAt++;
    }
  }
  return result;
}

/**
 * The doc's view of the domain model — drafts included — in rank order
 * (orderSpecs). Pull request, Aha! and Figma links and stored files come
 * along (the editor shows them) but serializeFeature never writes them, so
 * the projection below stays free of them.
 */
export function docToFeature(doc: A.Doc<FeatureDoc>): Feature {
  const feature: Feature = {
    name: doc.name,
    description: doc.description,
    scenarios: orderSpecs(doc.specs).map((s) => {
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
        const qtest = plainLink(s.qtest);
        const prs = plainPrs(s.prs);
        const aha = plainResources(s.aha);
        const figma = plainResources(s.figma);
        const files = plainFiles(s.files);
        const flags = plainFeatureFlags(s.flags);
        const attributes = plainAttributes(s.attributes);
        return {
          ...scenario,
          ...(s.negative ? { negative: true as const } : {}),
          ...(flags ? { flags } : {}),
          ...(attributes ? { attributes } : {}),
          ...(link ? { link } : {}),
          ...(qtest ? { qtest } : {}),
          ...(prs ? { prs } : {}),
          ...(aha ? { aha } : {}),
          ...(figma ? { figma } : {}),
          ...(files ? { files } : {}),
          ...(s.createdBy ? { createdBy: s.createdBy } : {}),
          ...(s.updatedBy ? { updatedBy: s.updatedBy } : {}),
        };
      }),
  };
  const flags = plainFeatureFlags(doc.flags);
  if (flags) feature.flags = flags;
  const attributes = plainAttributes(doc.attributes);
  if (attributes) feature.attributes = attributes;
  // The tickets: the list, or the single link of a document from before it.
  const links = ticketLinksOf(doc);
  if (links.length) feature.links = links;
  const qtest = plainLink(doc.qtest);
  if (qtest) feature.qtest = qtest;
  const confluence = plainLink(doc.confluence);
  if (confluence) feature.confluence = confluence;
  if (doc.confluencePage) {
    const { id, version, parentUrl } = doc.confluencePage;
    feature.confluencePage = { id, version, ...(typeof parentUrl === "string" ? { parentUrl } : {}) };
  }
  const prs = plainPrs(doc.prs);
  if (prs) feature.prs = prs;
  const aha = plainResources(doc.aha);
  if (aha) feature.aha = aha;
  const figma = plainResources(doc.figma);
  if (figma) feature.figma = figma;
  if (doc.assigned) feature.assigned = doc.assigned;
  if (doc.createdBy) feature.createdBy = doc.createdBy;
  if (doc.updatedBy) feature.updatedBy = doc.updatedBy;
  return feature;
}

/**
 * The `.feature.md` text this document projects to (drafts left out), the
 * scenarios numbered by position. `numbers: false` is the form a file
 * written before the numbers has — isProjectionOf's business only.
 */
export function projectFeature(
  doc: A.Doc<FeatureDoc>,
  { publishExternalLinks, publishAuthors = false }: ProjectionOptions = projection,
  numbers = true,
): string {
  const feature = docToFeature(doc);
  return serializeFeature(
    {
      ...feature,
      scenarios: feature.scenarios.filter((s) => s.status !== "draft"),
    },
    { links: publishExternalLinks, authors: publishAuthors, numbers },
  );
}

/**
 * Whether `text` is what this document projects to — in this peer's form or
 * another one, links written or not, authors written or not, scenarios
 * numbered or not. The drift pass asks this before absorbing a file, so a
 * peer whose "Publish external links" setting differs — or one that has not
 * seen the repo's `authors-in-markdown` change yet — is not read as an
 * external edit, and the two never take turns rewriting the same file. The
 * numberless form is the file as written before the scenario numbers: it is
 * not an edit either, and keeps its form until something in it is saved
 * (parser.ts: numbers are a label for the order, regenerated on write).
 */
export function isProjectionOf(text: string, doc: A.Doc<FeatureDoc>): boolean {
  for (const publishExternalLinks of [true, false]) {
    for (const publishAuthors of [false, true]) {
      for (const numbers of [true, false]) {
        if (text === projectFeature(doc, { publishExternalLinks, publishAuthors }, numbers)) {
          return true;
        }
      }
    }
  }
  return false;
}
