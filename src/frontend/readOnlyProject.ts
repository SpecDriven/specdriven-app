// The project a visitor of the read-only site looks at
// (src/server/readOnlyMode.ts): a site may show several spec repositories,
// and every request of the page is answered for the one the
// `specdriven-project` cookie names — the first project's when it names
// none. A link with `?project=<id>` picks it, so "Copy link" hands out
// urls that open the same project (src/frontend/shareLink.ts).
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
 * project, and the parameter leaves the address bar — the page's own urls
 * name no project, the cookie does.
 */
export function adoptProjectFromUrl(): void {
  const url = new URL(location.href);
  const asked = url.searchParams.get(PROJECT_PARAM);
  if (asked === null) return;
  if (PROJECT_ID_RE.test(asked)) writeCookie(asked);
  url.searchParams.delete(PROJECT_PARAM);
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
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

/** Show another project: its home, read afresh. */
export function chooseProject(id: string): void {
  if (!PROJECT_ID_RE.test(id)) return;
  tabProject = id;
  writeCookie(id);
  location.assign("/");
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
