// What an Aha! feature becomes in the spec tree (specs/external-links/aha-
// import.feature.md "Import a feature by its url", "Requirements become
// scenarios"): the markdown handed to createFeature, and the Aha! links the
// feature and its scenarios carry afterwards. Pure — the route reads Aha!
// and writes the file; this only decides what is written.

import type { AhaFeature } from "./aha";
import { htmlToMarkdown } from "./html";
import type { ResourceLink } from "./parser";

/** What of the Aha! feature is imported: its requirements as scenarios, or the description alone. */
export type AhaImportScope = "requirements" | "description";

export function isAhaImportScope(value: unknown): value is AhaImportScope {
  return value === "requirements" || value === "description";
}

export interface AhaImportPlan {
  /** The feature's name, fit for createFeature (no `/`, one line). */
  name: string;
  /** The whole `.feature.md`. */
  text: string;
  /** The Aha! record the feature links. */
  featureLink: ResourceLink;
  /** The requirement each scenario links, by the heading it was written under. */
  scenarioLinks: { name: string; version: 1; link: ResourceLink }[];
}

/** The line that would otherwise be read as the feature's ticket link (parser.ts EXTERNAL_LINK_RE). */
const TICKET_LINE_RE = /^\s{0,3}\[[^\[\]:\n]+:[^\[\]\n]+\]\(https?:\/\/[^\s()]+\)\s*$/;

/**
 * An Aha! name as a feature name: one line, no `/` (createFeature reads a
 * `/` as a folder), never empty.
 */
export function featureNameFromAha(name: string, fallback: string): string {
  const clean = name.replace(/\s+/g, " ").replace(/\s*\/\s*/g, " - ").trim().slice(0, 200).trim();
  return clean || fallback;
}

/**
 * A requirement's name as a scenario heading: one line, without a leading
 * `S3:` or a trailing `@v2 [published]`, which the heading syntax would read
 * as the scenario's number, version and status.
 */
export function scenarioNameFromAha(name: string, fallback: string): string {
  const clean = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^S[1-9]\d*:\s+/, "")
    .replace(/\s+@?v[1-9]\d*(?:\s+\[\w+\])?$/, "")
    .trim()
    .slice(0, 200)
    .trim();
  return clean || fallback;
}

/** Description markdown with nothing the feature parser would lift out of it. */
function descriptionMarkdown(html: string): string {
  return htmlToMarkdown(html)
    .split("\n")
    .map((line) => {
      if (TICKET_LINE_RE.test(line)) return `\\${line.trimStart()}`;
      // A `### Tests` heading is the legacy test-link section (parser.ts).
      if (/^###\s+Tests\s*$/i.test(line)) return `#${line}`;
      return line;
    })
    .join("\n")
    .trim();
}

/** `_Imported from Aha! [APP-123](url) — In design, release "2026.4"._` */
function importLine(feature: AhaFeature): string {
  const facts = [feature.status.trim(), feature.release.trim() ? `release "${feature.release.trim()}"` : ""].filter(Boolean);
  return `_Imported from Aha! [${feature.referenceNum}](${feature.url})${facts.length ? ` — ${facts.join(", ")}` : ""}._`;
}

/** The markdown an Aha! feature becomes, and the links back. */
export function planAhaImport(feature: AhaFeature, scope: AhaImportScope): AhaImportPlan {
  const name = featureNameFromAha(feature.name, feature.referenceNum);
  const parts = [`# ${name}`, importLine(feature)];
  const description = descriptionMarkdown(feature.description);
  if (description) parts.push(description);
  const scenarioLinks: AhaImportPlan["scenarioLinks"] = [];
  if (scope === "requirements") {
    const taken = new Set<string>();
    feature.requirements.forEach((req, i) => {
      let heading = scenarioNameFromAha(req.name, `Requirement ${req.referenceNum || i + 1}`);
      for (let n = 2; taken.has(heading.toLowerCase()); n++) heading = `${heading.replace(/ \(\d+\)$/, "")} (${n})`;
      taken.add(heading.toLowerCase());
      parts.push(`## ${heading} @v1 [proposed]`);
      const body = descriptionMarkdown(req.description);
      if (body) parts.push(body);
      scenarioLinks.push({ name: heading, version: 1, link: { url: req.url, title: req.referenceNum } });
    });
  }
  return {
    name,
    text: parts.join("\n\n") + "\n",
    featureLink: { url: feature.url, title: feature.referenceNum },
    scenarioLinks,
  };
}
