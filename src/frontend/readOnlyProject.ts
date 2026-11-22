// The project a visitor of the read-only site looks at
// (src/server/readOnlyMode.ts): a site may show several spec repositories,
// and every request of the page is answered for the one the
// `specdriven-project` cookie names — the first project's when it names
// none. A link with `?project=<id>` picks it, so "Copy link" hands out
// urls that open the same project (src/frontend/shareLink.ts), and the
// address bar names it too, through every navigation of the page, so the
// url a visitor copies from it opens the project they were looking at.
//
// The cookie is the browser's, not the tab's: a tab that comes back to the
// front puts its own project back, so two tabs on two projects do not read
// each other's.
//
// Pure: no server module is imported here (the cookie's name and the id
// rule are repeated from readOnlyMode.ts).

export const PROJECT_COOKIE = "specdriven-project";
export const PROJECT_PARAM = "project";
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

export interface ReadOnlyProjectInfo {
  id: string;
  repo: string;
}

function writeCookie(id: string): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PROJECT_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${secure}`;
}

/** The project the cookie names, if any. */
export function cookieProject(): string | null {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === PROJECT_COOKIE) {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return PROJECT_ID_RE.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * At page load, before the first request: a `?project=` link picks its
 * project. The parameter stays in the address bar until /api/state names
 * the project shown (showProjectInUrl), which drops it where the site shows
 * one project, or names no project it knows.
 */
export function adoptProjectFromUrl(): void {
  const asked = new URL(location.href).searchParams.get(PROJECT_PARAM);
  if (asked !== null && PROJECT_ID_RE.test(asked)) writeCookie(asked);
}

/** The project the address bar names; null where it names none. */
let urlProject: string | null = null;
/** The history whose pushState/replaceState keep it (one per page; the tests swap windows). */
let keptIn: History | null = null;

/** A same-origin url the page navigates to, naming the tab's project or none. */
function naming(url: string | URL): string | URL {
  const next = new URL(String(url), location.href);
  if (next.origin !== location.origin) return url;
  if (urlProject) next.searchParams.set(PROJECT_PARAM, urlProject);
  else if (next.searchParams.has(PROJECT_PARAM)) next.searchParams.delete(PROJECT_PARAM);
  else return url;
  return next.pathname + next.search + next.hash;
}

/**
 * Name the project this tab shows in its address bar — null where the site
 * shows one project, or is no site. The page's own urls (src/frontend/
 * App.tsx, plugin views) are bare paths: every pushState and replaceState
 * of this history from here on adds the parameter to the url it is given.
 */
export function showProjectInUrl(id: string | null): void {
  urlProject = id && PROJECT_ID_RE.test(id) ? id : null;
  if (urlProject && keptIn !== history) {
    const h = history;
    const push = h.pushState.bind(h);
    const replace = h.replaceState.bind(h);
    h.pushState = (data, unused, url) => push(data, unused, url == null ? url : naming(url));
    h.replaceState = (data, unused, url) => replace(data, unused, url == null ? url : naming(url));
    keptIn = h;
  }
  const here = location.pathname + location.search + location.hash;
  const named = naming(here);
  if (named !== here) history.replaceState(history.state, "", named);
}

let tabProject: string | null = null;
/** The window the listeners are on (one per page; the tests swap windows). */
let listeningOn: Window | null = null;

function reassert(): void {
  if (tabProject && cookieProject() !== tabProject) writeCookie(tabProject);
}

/** The project this tab shows, as /api/state named it; kept in the cookie while the tab is in front. */
export function setTabProject(id: string | null): void {
  tabProject = id && PROJECT_ID_RE.test(id) ? id : null;
  if (!tabProject || listeningOn === window) return;
  listeningOn = window;
  window.addEventListener("focus", reassert);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reassert();
  });
}

/** Show another project: its home, read afresh, the address bar naming it. */
export function chooseProject(id: string): void {
  if (!PROJECT_ID_RE.test(id)) return;
  tabProject = id;
  writeCookie(id);
  location.assign(`/?${PROJECT_PARAM}=${encodeURIComponent(id)}`);
}

/** The projects an /api/state answer lists; empty off the read-only site. */
export function parseReadOnlyProjects(value: unknown): ReadOnlyProjectInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p) =>
    p && typeof p.id === "string" && typeof p.repo === "string" && PROJECT_ID_RE.test(p.id)
      ? [{ id: p.id, repo: p.repo }]
      : [],
  );
}
