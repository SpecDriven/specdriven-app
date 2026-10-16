// Confluence page urls (specs/external-links/confluence-wiki.feature.md):
// which wiki a url belongs to and which page it names. Pure — shared by the
// server routes and the publish dialog, which hints at a missing token before
// anything is sent.
//
// Confluence Server / Data Center spells a page url several ways:
//
//   https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page   (7.x and later)
//   https://wiki.acme.com/pages/viewpage.action?pageId=99999
//   https://wiki.acme.com/display/ABC/Parent+Page               (by title)
//
// and an install may sit under a context path (https://acme.com/wiki/...).
// The wiki's base url is everything before `/spaces/`, `/pages/` or
// `/display/`, so the context path stays part of it.

/** A parent page as a url names it: by id, or by space and title. */
export interface ParentPageRef {
  /** The wiki's base url: origin plus any context path, no trailing slash. */
  base: string;
  pageId?: string;
  spaceKey?: string;
  title?: string;
}

const MARKERS = ["/spaces/", "/pages/", "/display/"] as const;

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A path segment as Confluence writes it: `+` for a space, percent-escapes. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, " "));
  } catch {
    return segment.replace(/\+/g, " ");
  }
}

/** The page a Confluence url names, or null when it names none this app can find. */
export function parseParentPageUrl(raw: string): ParentPageRef | null {
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
  if (found.m === "/spaces/") {
    // /spaces/KEY/pages/ID[/Title]
    const [key, pages, id] = rest;
    if (key && pages === "pages" && id && /^\d+$/.test(id)) return { base, spaceKey: decodeSegment(key), pageId: id };
    return null;
  }
  if (found.m === "/pages/") {
    // /pages/viewpage.action?pageId=ID, or the short /pages/ID
    if (rest[0] === "viewpage.action") {
      const id = url.searchParams.get("pageId");
      return id && /^\d+$/.test(id) ? { base, pageId: id } : null;
    }
    return rest[0] && /^\d+$/.test(rest[0]) ? { base, pageId: rest[0] } : null;
  }
  // /display/KEY/Title — a space's home (/display/KEY) is no page.
  const [key, title] = rest;
  if (!key || !title) return null;
  const name = decodeSegment(title).trim();
  return name ? { base, spaceKey: decodeSegment(key), title: name } : null;
}

/**
 * A wiki's base url as typed in Settings — `https://wiki.acme.com`,
 * `https://acme.com/wiki/`, or any page url of it — or null when it is no
 * http(s) url. Query and fragment are dropped, the trailing slash too.
 */
export function normalizeConfluenceBase(raw: string): string | null {
  const page = parseParentPageUrl(raw);
  if (page) return page.base;
  const url = httpUrl(raw);
  if (!url) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Whether two urls are the same wiki: same origin, same context path. */
export function sameBase(a: string, b: string): boolean {
  const x = normalizeConfluenceBase(a);
  const y = normalizeConfluenceBase(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

/** Whether `url` lies on the wiki at `base` (a page url, say). */
export function onBase(url: string, base: string): boolean {
  const u = httpUrl(url);
  const b = httpUrl(base);
  if (!u || !b || u.origin.toLowerCase() !== b.origin.toLowerCase()) return false;
  const prefix = b.pathname.replace(/\/+$/, "").toLowerCase();
  const path = u.pathname.toLowerCase();
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}
