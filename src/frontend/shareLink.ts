// "Copy link" urls (specs/ui/navigation.feature.md "share a link"), one rule
// for every pane: in a browser the page's own url; in the desktop window, whose
// app://specdriven origin means nothing outside it, the registered
// specdriven:// scheme — which names the open spec folder, so the link opens in
// that folder on whichever machine follows it.

import { desktopLink } from "./route";

/** The open data repo as configured; App keeps it current. */
let openRepo: string | null = null;

export function setShareRepo(repo: string | null): void {
  openRepo = repo;
}

/** The absolute url to share for an app path. */
export function shareUrl(path: string): string {
  return location.protocol === "app:" ? desktopLink(path, openRepo) : location.origin + path;
}
