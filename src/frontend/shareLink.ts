// "Copy link" urls (specs/ui/navigation.feature.md "share a link"), one rule
// for every pane: in a browser the page's own url; in the desktop window, whose
// app://specdriven origin means nothing outside it, the registered
// specdriven:// scheme — which names the open spec folder, so the link opens in
// that folder on whichever machine follows it. On a read-only site showing
// several projects the url names the visitor's project
// (src/frontend/readOnlyProject.ts), so it opens on that one.

import { PROJECT_PARAM } from "./readOnlyProject";
import { desktopLink } from "./route";

/** The open data repo as configured; App keeps it current. */
let openRepo: string | null = null;

export function setShareRepo(repo: string | null): void {
  openRepo = repo;
}

/** The read-only site's project the links name; null where the site shows one, or is no site. */
let project: string | null = null;

export function setShareProject(id: string | null): void {
  project = id;
}

/** The absolute url to share for an app path. */
export function shareUrl(path: string): string {
  if (location.protocol === "app:") return desktopLink(path, openRepo);
  if (!project) return location.origin + path;
  const url = new URL(path, location.origin);
  url.searchParams.set(PROJECT_PARAM, project);
  return url.href;
}
