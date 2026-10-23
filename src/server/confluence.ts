// Confluence Server / Data Center REST client
// (specs/external-links/confluence-wiki.feature.md), REST API 7.19:
// https://docs.atlassian.com/ConfluenceServer/rest/7.19.2/
//
// Every call carries a personal access token as a bearer token. A feature is
// published as one page under a parent page: created the first time, updated
// (a new version) after that — found by the page the feature already links,
// else by its title, which Confluence keeps unique within a space.

import type { ParentPageRef } from "./confluenceUrl";
import { getLogger } from "./telemetry";

const log = getLogger("confluence");

/**
 * What went wrong on the wire, for the dialog's detail box and the log: the
 * request (never its token), and Confluence's answer when there was one.
 */
export interface ConfluenceFailureDetails {
  method: string;
  url: string;
  /** The HTTP status Confluence answered; absent when it could not be reached. */
  status?: number;
  statusText?: string;
  contentType?: string;
  /** Where a redirect pointed. */
  location?: string;
  /** Confluence's response body, as text and cut to a readable length. */
  body?: string;
  /** Why the request never got an answer (a network error). */
  cause?: string;
  /** When the call failed, ISO 8601. */
  time: string;
}

/** A failed Confluence call, with the HTTP status so the route can pass it on. */
export class ConfluenceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: ConfluenceFailureDetails,
  ) {
    super(message);
  }
}

/** Response bodies are kept to this many characters in details and the log. */
export const BODY_EXCERPT_CHARS = 4000;

/**
 * A response body as text a person can read: an HTML error page loses its
 * markup, whitespace collapses, and the rest is cut to BODY_EXCERPT_CHARS.
 */
export function bodyExcerpt(text: string, contentType = ""): string {
  let out = text;
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) {
    out = text
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  } else {
    out = text.trim();
  }
  return out.length > BODY_EXCERPT_CHARS ? `${out.slice(0, BODY_EXCERPT_CHARS)}… (${out.length - BODY_EXCERPT_CHARS} more characters)` : out;
}

/**
 * Record a failed call in the app's log (the Observability page) with
 * everything the dialog's detail box shows: server errors and unreachable
 * wikis as errors, refusals Confluence explains (401, 404, 409…) as warnings.
 */
function logFailure(error: ConfluenceError): ConfluenceError {
  const d = error.details;
  const attributes = d
    ? {
        "http.request.method": d.method,
        "url.full": d.url,
        ...(d.status !== undefined ? { "http.response.status_code": d.status } : {}),
        ...(d.contentType ? { "http.response.content_type": d.contentType } : {}),
        ...(d.location ? { "http.response.location": d.location } : {}),
        ...(d.body ? { "http.response.body": d.body } : {}),
        ...(d.cause ? { "error.cause": d.cause } : {}),
      }
    : undefined;
  const serious = d?.status === undefined || d.status >= 500;
  log[serious ? "error" : "warn"](error.message, attributes);
  return error;
}

interface Init {
  method?: string;
  json?: unknown;
  /** A multipart body (an attachment upload); fetch writes its content type. */
  form?: FormData;
}

/** One request to a wiki's REST API, with the token and headers it wants. */
export async function confluenceRequest(base: string, path: string, token: string, init: Init = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "SpecDriven",
    Authorization: `Bearer ${token}`,
  };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  // Confluence refuses a multipart upload without this (XSRF protection).
  if (init.form !== undefined) headers["X-Atlassian-Token"] = "nocheck";
  const method = init.method ?? "GET";
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
      redirect: "manual",
    });
  } catch (e) {
    const cause = (e as Error).message;
    throw logFailure(
      new ConfluenceError(`Could not reach Confluence at ${base}: ${cause}`, 502, {
        method,
        url,
        cause,
        time: new Date().toISOString(),
      }),
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // A redirect from the REST API is a sign-in page or SSO, never data.
    throw logFailure(
      new ConfluenceError(
        "Confluence redirected the request — check the wiki url, and that the token is a personal access token",
        401,
        { ...(await answered(method, url, res)), location: res.headers.get("location") ?? undefined },
      ),
    );
  }
  if (!res.ok) throw logFailure(await describeFailure(res, await answered(method, url, res)));
  return res;
}

/** The details of a response Confluence answered, its body read as text. */
async function answered(method: string, url: string, res: Response): Promise<ConfluenceFailureDetails> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  return {
    method,
    url,
    status: res.status,
    ...(res.statusText ? { statusText: res.statusText } : {}),
    ...(contentType ? { contentType } : {}),
    ...(text ? { body: bodyExcerpt(text, contentType) } : {}),
    time: new Date().toISOString(),
  };
}

async function confluence<T>(base: string, path: string, token: string, init: Init = {}): Promise<T> {
  const res = await confluenceRequest(base, path, token, init);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = res.headers.get("content-type") ?? "";
    throw logFailure(
      new ConfluenceError("Confluence answered with something that is not JSON — check the wiki url", 502, {
        method: init.method ?? "GET",
        url: `${base}${path}`,
        status: res.status,
        ...(contentType ? { contentType } : {}),
        ...(text ? { body: bodyExcerpt(text, contentType) } : {}),
        time: new Date().toISOString(),
      }),
    );
  }
}

/** A Confluence failure as one sentence the dialog can show, with the status and details kept. */
function describeFailure(res: Response, details: ConfluenceFailureDetails): ConfluenceError {
  const err = (message: string, status: number) => new ConfluenceError(message, status, details);
  let detail: string | undefined;
  try {
    detail = (JSON.parse(details.body ?? "") as { message?: string } | null)?.message;
  } catch {
    // Not JSON (an HTML error page, say): the detail box shows the body.
  }
  if (res.status === 401) {
    return err("Confluence rejected the token; save a new one in Settings → Confluence.", 401);
  }
  if (res.status === 403) {
    return err(
      `Confluence refused the request — the token cannot write to this space${detail ? `: ${detail}` : ""}`,
      403,
    );
  }
  if (res.status === 404) {
    return err("Confluence reports no such page, or the token cannot see it.", 404);
  }
  if (res.status === 413) {
    return err("The page is too large for Confluence to accept.", 413);
  }
  if (res.status === 409) {
    // A stale version number: the page changed between the version check
    // and the update.
    return err("Confluence reports the page changed while it was being published — publish again.", 409);
  }
  return err(`Confluence answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, 502);
}

/**
 * The page was changed in Confluence since the app last published it
 * (specs/external-links/confluence-wiki.feature.md "Changes made in
 * Confluence are not overwritten unnoticed"): its version is past the one
 * recorded, so publishing would replace what was changed. The route hands
 * the details to the dialog, which asks before going ahead.
 */
export class ConfluenceConflict extends ConfluenceError {
  constructor(
    public readonly conflict: {
      pageId: string;
      url: string;
      /** The page's version in Confluence now. */
      version: number;
      /** The version the app last published. */
      lastVersion: number;
      /** Who made the current version, and when, as Confluence reports them. */
      by?: string;
      when?: string;
    },
  ) {
    const who = conflict.by ? ` by ${conflict.by}` : "";
    super(
      `The page was changed in Confluence since it was last published from here (version ${conflict.version}${who}); publishing would replace those changes.`,
      409,
    );
  }
}

// --- Shapes ------------------------------------------------------------------------

interface RawUser {
  type?: string;
  username?: string;
  userKey?: string;
  displayName?: string;
}

interface RawPage {
  id: string;
  title: string;
  space?: { key?: string };
  /** The current version: its number, who made it and when (`expand=version`). */
  version?: { number?: number; when?: string; by?: RawUser; message?: string };
  ancestors?: { id: string }[];
  _links?: { base?: string; webui?: string };
}

/** A page as the publish flow needs it. */
export interface PageInfo {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  /** Who made the current version, and when (ISO 8601), when Confluence says. */
  by?: string;
  when?: string;
  /** Ancestor page ids, the root first; the last is the parent. */
  ancestors: string[];
  url: string;
}

/** The message each version the app publishes carries in the page's history. */
export const VERSION_MESSAGE = "Published from SpecDriven";

function pageUrl(base: string, raw: RawPage): string {
  const webui = raw._links?.webui;
  if (!webui) return `${base}/pages/viewpage.action?pageId=${raw.id}`;
  if (/^https?:\/\//.test(webui)) return webui;
  return `${(raw._links?.base ?? base).replace(/\/+$/, "")}${webui}`;
}

function pageInfo(base: string, raw: RawPage, spaceKey?: string): PageInfo {
  const by = raw.version?.by;
  const who = by?.displayName || by?.username || by?.userKey;
  return {
    id: String(raw.id),
    title: raw.title,
    spaceKey: raw.space?.key ?? spaceKey ?? "",
    version: raw.version?.number ?? 1,
    ...(who ? { by: who } : {}),
    ...(raw.version?.when ? { when: raw.version.when } : {}),
    ancestors: (raw.ancestors ?? []).map((a) => String(a.id)),
    url: pageUrl(base, raw),
  };
}

// --- Calls -------------------------------------------------------------------------

/**
 * Who a token signs in as, or a 401 ConfluenceError. Some installs answer
 * an unknown bearer token with the anonymous user rather than a 401, so the
 * anonymous answer is refused here — that check is what keeps a typo out.
 */
export async function validateToken(base: string, token: string): Promise<{ user: string }> {
  const refused = new ConfluenceError("Confluence did not accept this token — check it and its expiry", 401);
  let user: RawUser;
  try {
    user = await confluence<RawUser>(base, "/rest/api/user/current", token);
  } catch (e) {
    throw e instanceof ConfluenceError && e.status === 401 ? refused : e;
  }
  if (user.type === "anonymous" || user.username === "anonymous" || (!user.username && !user.userKey)) {
    throw refused;
  }
  return { user: user.displayName || user.username || user.userKey! };
}

/** A page by id, or null when Confluence has none (a deleted page). */
export async function getPage(base: string, token: string, id: string): Promise<PageInfo | null> {
  try {
    const raw = await confluence<RawPage>(
      base,
      `/rest/api/content/${encodeURIComponent(id)}?expand=space,version,ancestors`,
      token,
    );
    return pageInfo(base, raw);
  } catch (e) {
    if (e instanceof ConfluenceError && e.status === 404) return null;
    throw e;
  }
}

/** The current page titled `title` in a space, or null. */
export async function findPageByTitle(
  base: string,
  token: string,
  spaceKey: string,
  title: string,
): Promise<PageInfo | null> {
  const query = `spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&type=page&status=current&expand=space,version,ancestors`;
  const found = await confluence<{ results?: RawPage[] }>(base, `/rest/api/content?${query}`, token);
  const raw = found.results?.[0];
  return raw ? pageInfo(base, raw, spaceKey) : null;
}

/** The parent page a url names, with its space. */
export async function resolveParent(
  base: string,
  token: string,
  ref: ParentPageRef,
): Promise<{ id: string; spaceKey: string }> {
  if (ref.pageId) {
    const page = await getPage(base, token, ref.pageId);
    if (!page) throw new ConfluenceError(`Confluence has no page ${ref.pageId}, or the token cannot see it.`, 404);
    return { id: page.id, spaceKey: page.spaceKey || ref.spaceKey || "" };
  }
  if (ref.spaceKey && ref.title) {
    const page = await findPageByTitle(base, token, ref.spaceKey, ref.title);
    if (!page) {
      throw new ConfluenceError(`Confluence has no page titled “${ref.title}” in space ${ref.spaceKey}.`, 404);
    }
    return { id: page.id, spaceKey: page.spaceKey };
  }
  throw new ConfluenceError("The parent page url names no page", 400);
}

interface PageFields {
  title: string;
  spaceKey: string;
  parentId: string;
  /** Confluence storage format (XHTML). */
  body: string;
}

function contentBody(p: PageFields) {
  return {
    type: "page",
    title: p.title,
    space: { key: p.spaceKey },
    ancestors: [{ id: p.parentId }],
    body: { storage: { value: p.body, representation: "storage" } },
  };
}

export async function createPage(base: string, token: string, p: PageFields): Promise<PageInfo> {
  const raw = await confluence<RawPage>(base, "/rest/api/content", token, { method: "POST", json: contentBody(p) });
  return pageInfo(base, raw, p.spaceKey);
}

/**
 * A new version of a page, carrying the app's message in the page's history.
 * Naming the parent as the ancestor moves the page under it when it sat
 * elsewhere.
 */
export async function updatePage(
  base: string,
  token: string,
  p: PageFields & { id: string; version: number },
): Promise<PageInfo> {
  const raw = await confluence<RawPage>(base, `/rest/api/content/${encodeURIComponent(p.id)}`, token, {
    method: "PUT",
    json: { id: p.id, ...contentBody(p), version: { number: p.version + 1, message: VERSION_MESSAGE } },
  });
  return pageInfo(base, raw, p.spaceKey);
}

/** What a publish leaves: the page, whether it was created, and its version now. */
export interface PublishedPage {
  id: string;
  url: string;
  created: boolean;
  version: number;
}

/**
 * Publish a feature's page under a parent: update the page the feature
 * already links (`existingPageId`) when it still exists, else the page of the
 * same title under that parent, else create one. A page of the same title
 * elsewhere in the space is refused rather than taken over — Confluence keeps
 * titles unique per space, so creating one would fail anyway.
 *
 * The linked page is checked against `lastVersion`, the version the app
 * last published: a page past it was changed in Confluence since, and is
 * left alone — a ConfluenceConflict, naming who changed it — unless `force`
 * says the user chose to replace those changes. No record (a page from
 * before versions were kept, or one found by its title) means no check.
 */
export async function publishFeaturePage(p: {
  base: string;
  token: string;
  parent: { id: string; spaceKey: string };
  title: string;
  body: string;
  existingPageId?: string;
  lastVersion?: number;
  force?: boolean;
}): Promise<PublishedPage> {
  const fields: PageFields = { title: p.title, spaceKey: p.parent.spaceKey, parentId: p.parent.id, body: p.body };
  const published = (page: PageInfo, created: boolean): PublishedPage => ({
    id: page.id,
    url: page.url,
    created,
    version: page.version,
  });
  if (p.existingPageId) {
    const linked = await getPage(p.base, p.token, p.existingPageId);
    if (linked) {
      if (p.lastVersion !== undefined && linked.version > p.lastVersion && !p.force) {
        throw new ConfluenceConflict({
          pageId: linked.id,
          url: linked.url,
          version: linked.version,
          lastVersion: p.lastVersion,
          ...(linked.by ? { by: linked.by } : {}),
          ...(linked.when ? { when: linked.when } : {}),
        });
      }
      const page = await updatePage(p.base, p.token, {
        ...fields,
        spaceKey: linked.spaceKey || fields.spaceKey,
        id: linked.id,
        version: linked.version,
      });
      return published(page, false);
    }
  }
  const same = await findPageByTitle(p.base, p.token, p.parent.spaceKey, p.title);
  if (same) {
    if (!same.ancestors.includes(p.parent.id)) {
      throw new ConfluenceError(
        `A page titled “${p.title}” already exists elsewhere in space ${p.parent.spaceKey}: ${same.url}`,
        409,
      );
    }
    const page = await updatePage(p.base, p.token, { ...fields, id: same.id, version: same.version });
    return published(page, false);
  }
  const page = await createPage(p.base, p.token, fields);
  return published(page, true);
}

/** A file to attach to a page: the name the page's body refers to it by. */
export interface AttachmentFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** The names of a page's current attachments. */
async function attachmentNamesOf(base: string, token: string, pageId: string): Promise<Set<string>> {
  const names = new Set<string>();
  const path = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
  for (let start = 0; ; ) {
    const page = await confluence<{ results?: { title?: string }[]; size?: number; _links?: { next?: string } }>(
      base,
      `${path}?limit=200&start=${start}`,
      token,
    );
    for (const a of page.results ?? []) if (a.title) names.add(a.title);
    if (!page._links?.next || !page.results?.length) break;
    start += page.results.length;
  }
  return names;
}

/**
 * Attach the files a page's body refers to (confluenceStorage's
 * attachmentNames). A stored image's name carries a hash of its bytes, so an
 * attachment already there under the name is the same file and is left
 * alone; only the missing ones are uploaded. Returns how many were.
 */
export async function attachFiles(base: string, token: string, pageId: string, files: AttachmentFile[]): Promise<number> {
  if (files.length === 0) return 0;
  const present = await attachmentNamesOf(base, token, pageId);
  const missing = files.filter((f) => !present.has(f.name));
  if (missing.length === 0) return 0;
  // Confluence takes a minorEdit flag per file, or none at all — one for a
  // whole upload of several is refused.
  const form = new FormData();
  for (const f of missing) {
    form.append("file", new Blob([f.bytes as BlobPart], { type: f.mime }), f.name);
    form.append("minorEdit", "true");
  }
  await confluenceRequest(base, `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`, token, {
    method: "POST",
    form,
  });
  return missing.length;
}
