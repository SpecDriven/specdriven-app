// The sources of an Import from Jira/Wiki
// (specs/external-links/jira-wiki-import.feature.md "The sources: up to five
// issues and five pages"): which urls are Jira issues and which Confluence
// pages, and how many of each one import may read. Pure — shared by the
// server (./jiraWikiImport.ts) and the dialog, which hints before anything
// is sent — so nothing here may reach a Node API.

import { parseParentPageUrl, type ParentPageRef } from "./confluenceUrl";
import { parseJiraIssueUrl } from "./jiraUrl";

export const MAX_JIRA_SOURCES = 5;
export const MAX_WIKI_SOURCES = 5;
/** Scenarios proposed per turn; what the sources hold beyond that is named, not written. */
export const MAX_SCENARIOS = 15;

/** A url the dialog accepted: which service, and what it names there. */
export type SourceRef =
  | { kind: "jira"; url: string; base: string; key: string }
  | { kind: "wiki"; url: string; base: string; page: ParentPageRef };

/** What a url names, or null when it is neither a Jira issue nor a Confluence page. */
export function classifySource(url: string): SourceRef | null {
  const trimmed = url.trim();
  const issue = parseJiraIssueUrl(trimmed);
  if (issue) return { kind: "jira", url: trimmed, base: issue.base, key: issue.key };
  const page = parseParentPageUrl(trimmed);
  if (page) return { kind: "wiki", url: trimmed, base: page.base, page };
  return null;
}

/** What is wrong with a set of sources as a whole, or null. */
export function sourcesProblem(refs: SourceRef[]): string | null {
  if (refs.length === 0) return "Add at least one Jira issue or Confluence page.";
  if (refs.filter((r) => r.kind === "jira").length > MAX_JIRA_SOURCES) {
    return `At most ${MAX_JIRA_SOURCES} Jira issues can be read at once.`;
  }
  if (refs.filter((r) => r.kind === "wiki").length > MAX_WIKI_SOURCES) {
    return `At most ${MAX_WIKI_SOURCES} Confluence pages can be read at once.`;
  }
  return null;
}
