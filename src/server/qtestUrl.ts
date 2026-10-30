// qTest Manager urls (specs/external-links/qtest-test-cases.feature.md
// "Create qTest test cases from a feature"): which qTest site a url belongs
// to, which project, and which module or test case it names. Pure — shared
// by the server routes and the publish dialog, which hints at a missing
// token before anything is sent.
//
// qTest spells an object's url as the project's portal page plus a fragment:
//
//   https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901   (a module)
//   https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=1&id=6517980   (a test case)
//
// with the fragment's keys in any order (qTest's own address bar puts `id`
// first). `object=` counts per tab — on Test Execution `object=2` is a test
// cycle — so a url on another tab names neither.
//
// and an on-premise install may sit under a context path. The site's base
// url is everything before `/p/<project>/`, so the context path stays part
// of it.

/** A module as its url names it: the site, the project, and the module's id. */
export interface ModuleRef {
  /** The qTest site's base url: origin plus any context path, no trailing slash. */
  base: string;
  projectId: string;
  moduleId: string;
}

/** The Test Design tree's object kinds, as the `object=` fragment names them. */
const TEST_CASE_OBJECT = "1";
const MODULE_OBJECT = "0";

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The project a portal url names, and the site before it. */
function portal(url: URL): { base: string; projectId: string } | null {
  const m = url.pathname.match(/^(.*?)\/p\/(\d+)\/portal\/project\/?$/);
  if (!m) return null;
  return { base: `${url.origin}${m[1]!}`.replace(/\/+$/, ""), projectId: m[2]! };
}

/** The `tab`, `object` and `id` of a portal url's fragment. */
function fragment(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.replace(/^#/, ""));
}

/** The numeric id of the Test Design object of this kind the fragment names, or null. */
function testDesignId(f: URLSearchParams, object: string): string | null {
  const tab = f.get("tab");
  if (tab !== null && tab !== "testdesign") return null;
  const id = f.get("id");
  return f.get("object") === object && id && /^\d+$/.test(id) ? id : null;
}

/** The module a qTest url names, or null when it names none. */
export function parseModuleUrl(raw: string): ModuleRef | null {
  const url = httpUrl(raw);
  if (!url) return null;
  const p = portal(url);
  if (!p) return null;
  const id = testDesignId(fragment(url), MODULE_OBJECT);
  return id ? { ...p, moduleId: id } : null;
}

/** The numeric id of the test case a qTest url names, or null. */
export function testCaseIdFromUrl(raw: string): string | null {
  const url = httpUrl(raw);
  if (!url || !portal(url)) return null;
  return testDesignId(fragment(url), TEST_CASE_OBJECT);
}

/** The numeric id of the module a qTest url names, or null. */
export function moduleIdFromUrl(raw: string): string | null {
  return parseModuleUrl(raw)?.moduleId ?? null;
}

/** A module's url as qTest shows it. */
export function moduleWebUrl(base: string, projectId: string, moduleId: string): string {
  return `${base}/p/${projectId}/portal/project#tab=testdesign&object=${MODULE_OBJECT}&id=${moduleId}`;
}

/** A test case's url as qTest shows it. */
export function testCaseWebUrl(base: string, projectId: string, testCaseId: string): string {
  return `${base}/p/${projectId}/portal/project#tab=testdesign&object=${TEST_CASE_OBJECT}&id=${testCaseId}`;
}

/**
 * A qTest site's base url as typed in Settings — `https://acme.qtestnet.com`,
 * `https://qa.acme.com/qtest/`, or any portal url of it — or null when it is
 * no http(s) url. Query and fragment are dropped, the trailing slash too.
 */
export function normalizeQtestBase(raw: string): string | null {
  const url = httpUrl(raw);
  if (!url) return null;
  const p = portal(url);
  if (p) return p.base;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Whether two urls are the same qTest site: same origin, same context path. */
export function sameQtestBase(a: string, b: string): boolean {
  const x = normalizeQtestBase(a);
  const y = normalizeQtestBase(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

/** Whether `url` lies on the site at `base` (a module or test case url, say). */
export function onQtestBase(url: string, base: string): boolean {
  const u = httpUrl(url);
  const b = httpUrl(base);
  if (!u || !b || u.origin.toLowerCase() !== b.origin.toLowerCase()) return false;
  const prefix = b.pathname.replace(/\/+$/, "").toLowerCase();
  const path = u.pathname.toLowerCase();
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}
