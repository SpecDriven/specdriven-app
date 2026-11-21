// What a desktop window is called (specs/app/multiple-windows.feature.md
// "Windows"): the name of the folder it shows, then the page open in it —
// "specs-insurance — Checkout". Every window's page titles itself
// "SpecDriven — <page>" (src/frontend/App.tsx), which is right for a browser
// tab and for a link preview, and tells the windows of one app apart not at
// all: the Dock menu, the Window menu and the task switcher list them by
// title. The shell therefore names each window itself. A pure rule, kept
// out of main.ts so it runs under bun test.

import { repoDisplayName } from "../frontend/route";
import type { WorkspaceFolder } from "../server/workspace";

const APP_NAME = "SpecDriven";
/** A page's title: an optional pomodoro clock, the app's name, an optional page. */
const PAGE_TITLE = /^(?:(.*?) · )?SpecDriven(?: — (.*))?$/s;
/** The longest a window's title gets; a longer one is cut and ends in "…". */
export const MAX_WINDOW_TITLE = 36;

/** A title no longer than MAX_WINDOW_TITLE characters, cut with an ellipsis. */
function capped(title: string): string {
  const chars = Array.from(title);
  if (chars.length <= MAX_WINDOW_TITLE) return title;
  return `${chars.slice(0, MAX_WINDOW_TITLE - 1).join("").trimEnd()}…`;
}

/**
 * The name a window goes by: its code repository's, else its specifications
 * folder's; null for a window that shows none — one opened for a folder
 * included, until it has opened it, since that may yet be declined.
 */
export function windowFolderName(folder: WorkspaceFolder): string | null {
  const path = folder.openCodeRepo ?? folder.dataRepo;
  return path ? repoDisplayName(path) : null;
}

/**
 * A window's title from its page's: the folder's name in the place of the
 * app's, the page after it — unless the page is the folder itself, as a code
 * repository's home is — and a running pomodoro's clock still in front. Only
 * the page's name is kept: the open scenario after its " · " is dropped. A
 * window with no folder keeps the page's title, and so does a title that is
 * not one of the app's. Whatever it comes to is cut to MAX_WINDOW_TITLE
 * characters, so the Dock and Window menus stay narrow.
 */
export function windowTitle(pageTitle: string, folderName: string | null): string {
  return capped(fullWindowTitle(pageTitle, folderName));
}

function fullWindowTitle(pageTitle: string, folderName: string | null): string {
  if (!folderName) return pageTitle || APP_NAME;
  const match = PAGE_TITLE.exec(pageTitle);
  if (!match) return pageTitle ? `${folderName} — ${pageTitle}` : folderName;
  const [, clock, fullPage] = match;
  const page = fullPage?.split(" · ")[0];
  const named = page && page !== folderName ? `${folderName} — ${page}` : folderName;
  return clock ? `${clock} · ${named}` : named;
}
