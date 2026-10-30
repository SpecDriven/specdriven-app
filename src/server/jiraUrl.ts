// Jira issue urls (specs/external-links/jira-wiki-import.feature.md): which
// Jira a url belongs to and which issue it names. Pure — shared by the
// server routes and the import dialog, which hints at a missing token before
// anything is sent.
//
// Jira Server / Data Center spells an issue url several ways:
//
//   https://jira.acme.com/browse/ABC-123
//   https://jira.acme.com/projects/ABC/issues/ABC-123
//   https://jira.acme.com/secure/RapidBoard.jspa?...&selectedIssue=ABC-123
//
// and an install may sit under a context path (https://acme.com/jira/...).
// The site's base url is everything before `/browse/`, `/projects/` or
// `/secure/`, so the context path stays part of it.

/** An issue as a url names it: the site and the issue key. */
export interface JiraIssueRef {
  /** The site's base url: origin plus any context path, no trailing slash. */
  base: string;
  /** The issue key, upper-cased: ABC-123. */
  key: string;
}

const MARKERS = ["/browse/", "/projects/", "/secure/"] as const;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

/** Whether text is shaped like an issue key — ABC-123 — whatever its case. */
export function isJiraIssueKey(text: string): boolean {
  return KEY.test(text.trim());
}

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The issue a Jira url names, or null when it names none this app can read. */
export function parseJiraIssueUrl(raw: string): JiraIssueRef | null {
  const url = httpUrl(raw);
  if (!url) return null;
  const path = url.pathname;
  const found = MARKERS.map((m) => ({ m, at: path.indexOf(m) }))
    .filter((x) => x.at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  if (!found) return null;
  const base = `${url.origin}${path.slice(0, found.at)}`.replace(/\/+$/, "");
  const rest = path
    .slice(found.at + found.m.length)
    .split("/")
    .filter((s) => s !== "");
  const key = (() => {
    if (found.m === "/browse/") return rest[0];
    // /projects/ABC/issues/ABC-123[?filter=...]
    if (found.m === "/projects/") return rest[1] === "issues" ? rest[2] : undefined;
    // A board or search with the issue opened at its side.
    return url.searchParams.get("selectedIssue") ?? undefined;
  })();
  if (!key || !KEY.test(key)) return null;
  return { base, key: key.toUpperCase() };
}

/**
 * A site's base url as typed in Settings — `https://jira.acme.com`,
 * `https://acme.com/jira/`, or any issue url of it — or null when it is no
 * http(s) url. Query and fragment are dropped, the trailing slash too.
 */
export function normalizeJiraBase(raw: string): string | null {
  const issue = parseJiraIssueUrl(raw);
  if (issue) return issue.base;
  const url = httpUrl(raw);
  if (!url) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Whether two urls are the same Jira: same origin, same context path. */
export function sameJiraBase(a: string, b: string): boolean {
  const x = normalizeJiraBase(a);
  const y = normalizeJiraBase(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

/** The url Jira shows an issue at. */
export function jiraIssueUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}
