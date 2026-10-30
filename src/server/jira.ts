// Jira Server / Data Center REST client
// (specs/external-links/jira-wiki-import.feature.md), REST API 2:
// https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/
//
// Every call carries a personal access token as a bearer token. The app only
// reads: who a token signs in as, and an issue with its fields rendered as
// HTML (`expand=renderedFields`), which the import turns into markdown.
// Nothing is written to Jira.

import { bodyExcerpt, failureAttributes, type FailureDetails } from "./httpFailure";
import { jiraIssueUrl } from "./jiraUrl";
import { getLogger } from "./telemetry";

const log = getLogger("jira");

/** A failed Jira call, with the HTTP status so the route can pass it on. */
export class JiraError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: FailureDetails,
  ) {
    super(message);
  }
}

/** Record a failed call in the app's log: server errors and unreachable sites as errors, refusals as warnings. */
function logFailure(error: JiraError): JiraError {
  const d = error.details;
  const attributes = d ? failureAttributes(d) : undefined;
  const serious = d?.status === undefined || d.status >= 500;
  log[serious ? "error" : "warn"](error.message, attributes);
  return error;
}

/** One GET to a site's REST API, with the token and headers it wants. */
export async function jiraRequest(base: string, path: string, token: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "SpecDriven",
    Authorization: `Bearer ${token}`,
  };
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, redirect: "manual" });
  } catch (e) {
    const cause = (e as Error).message;
    throw logFailure(
      new JiraError(`Could not reach Jira at ${base}: ${cause}`, 502, {
        method: "GET",
        url,
        cause,
        time: new Date().toISOString(),
      }),
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // A redirect from the REST API is a sign-in page or SSO, never data.
    throw logFailure(
      new JiraError(
        "Jira redirected the request — check the site url, and that the token is a personal access token",
        401,
        { ...(await answered(url, res)), location: res.headers.get("location") ?? undefined },
      ),
    );
  }
  if (!res.ok) throw logFailure(describeFailure(res, await answered(url, res)));
  return res;
}

async function answered(url: string, res: Response): Promise<FailureDetails> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  return {
    method: "GET",
    url,
    status: res.status,
    ...(res.statusText ? { statusText: res.statusText } : {}),
    ...(contentType ? { contentType } : {}),
    ...(text ? { body: bodyExcerpt(text, contentType) } : {}),
    time: new Date().toISOString(),
  };
}

/** A Jira failure as one sentence the dialog can show, with the status and details kept. */
function describeFailure(res: Response, details: FailureDetails): JiraError {
  const err = (message: string, status: number) => new JiraError(message, status, details);
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(details.body ?? "") as { errorMessages?: string[]; message?: string } | null;
    detail = parsed?.errorMessages?.filter(Boolean).join("; ") || parsed?.message;
  } catch {
    // Not JSON (an HTML error page, say): the detail box shows the body.
  }
  if (res.status === 401) return err("Jira rejected the token; save a new one in Settings → Jira.", 401);
  if (res.status === 403) {
    return err(`Jira refused the request — the token cannot see this issue${detail ? `: ${detail}` : ""}`, 403);
  }
  if (res.status === 404) return err("Jira reports no such issue, or the token cannot see it.", 404);
  return err(`Jira answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, 502);
}

async function jira<T>(base: string, path: string, token: string): Promise<T> {
  const res = await jiraRequest(base, path, token);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = res.headers.get("content-type") ?? "";
    throw logFailure(
      new JiraError("Jira answered with something that is not JSON — check the site url", 502, {
        method: "GET",
        url: `${base}${path}`,
        status: res.status,
        ...(contentType ? { contentType } : {}),
        ...(text ? { body: bodyExcerpt(text, contentType) } : {}),
        time: new Date().toISOString(),
      }),
    );
  }
}

// --- Shapes ------------------------------------------------------------------------

interface RawUser {
  name?: string;
  key?: string;
  displayName?: string;
  emailAddress?: string;
}

interface RawIssue {
  key: string;
  fields?: Record<string, unknown> & {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    labels?: string[];
    subtasks?: { key: string; fields?: { summary?: string } }[];
    comment?: { comments?: { author?: RawUser; body?: string }[] };
  };
  /** The same fields, rendered as HTML (`expand=renderedFields`). */
  renderedFields?: Record<string, unknown> & {
    description?: string | null;
    comment?: { comments?: { author?: RawUser; body?: string }[] };
  };
  /** Field id → human name (`expand=names`). */
  names?: Record<string, string>;
}

/** An issue as the import reads it: every text Jira renders, as HTML. */
export interface JiraIssue {
  key: string;
  url: string;
  summary: string;
  type: string;
  status: string;
  labels: string[];
  /** The description, rendered as HTML; empty when there is none. */
  descriptionHtml: string;
  /** Every other rendered text field with words in it (Acceptance Criteria, say), by its name. */
  fields: { name: string; html: string }[];
  comments: { author: string; html: string }[];
  subtasks: { key: string; summary: string }[];
}

// --- Calls -------------------------------------------------------------------------

/**
 * Who a token signs in as, or a 401 JiraError. Some installs answer an
 * unknown bearer token with an anonymous shape rather than a 401, so an
 * answer that names nobody is refused here — that check is what keeps a
 * typo out.
 */
export async function validateJiraToken(base: string, token: string): Promise<{ user: string }> {
  const refused = new JiraError("Jira did not accept this token — check it and its expiry", 401);
  let user: RawUser;
  try {
    user = await jira<RawUser>(base, "/rest/api/2/myself", token);
  } catch (e) {
    throw e instanceof JiraError && e.status === 401 ? refused : e;
  }
  if (!user.name && !user.key) throw refused;
  return { user: user.displayName || user.name || user.key! };
}

/** Fields the import does not read as text: the ones with their own place above, and the machinery. */
const SKIPPED_FIELDS = new Set([
  "summary",
  "description",
  "comment",
  "issuetype",
  "status",
  "labels",
  "subtasks",
  "issuelinks",
  "attachment",
  "worklog",
  "timetracking",
  "votes",
  "watches",
  "progress",
  "aggregateprogress",
  "created",
  "updated",
  "resolutiondate",
  "lastViewed",
  "duedate",
]);

/** Whether a rendered field holds words a reader would want, not a date or a number. */
function hasWords(html: string): boolean {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text.length > 0 && /[a-z]{3,}/i.test(text);
}

/** The issue with its texts rendered as HTML. */
export async function getJiraIssue(base: string, token: string, key: string): Promise<JiraIssue> {
  const raw = await jira<RawIssue>(
    base,
    `/rest/api/2/issue/${encodeURIComponent(key)}?expand=renderedFields,names`,
    token,
  );
  const fields = raw.fields ?? {};
  const rendered = raw.renderedFields ?? {};
  const names = raw.names ?? {};
  const extra: { name: string; html: string }[] = [];
  for (const [id, value] of Object.entries(rendered)) {
    if (SKIPPED_FIELDS.has(id) || typeof value !== "string" || !hasWords(value)) continue;
    extra.push({ name: names[id] ?? id, html: value });
  }
  const comments = rendered.comment?.comments ?? fields.comment?.comments ?? [];
  return {
    key: raw.key ?? key,
    url: jiraIssueUrl(base, raw.key ?? key),
    summary: fields.summary ?? "",
    type: fields.issuetype?.name ?? "",
    status: fields.status?.name ?? "",
    labels: fields.labels ?? [],
    descriptionHtml: rendered.description ?? "",
    fields: extra,
    comments: comments
      .filter((c) => typeof c.body === "string" && c.body.trim())
      .map((c) => ({ author: c.author?.displayName || c.author?.name || "", html: c.body! })),
    subtasks: (fields.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields?.summary ?? "" })),
  };
}
