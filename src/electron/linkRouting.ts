// Where a link goes in the desktop app. A url the window tries to leave for
// either stays in the window, follows a `specdriven://` link in place, or
// opens in the default browser (specs/app/desktop-app.feature.md "External
// links"); a `specdriven://` link — from the OS, a second launch or a spec
// body — is shown in the window that has its folder open, in a window
// opened for a folder none shows, or else in the window used last
// (specs/ui/navigation.feature.md "Links from outside the app",
// specs/app/multiple-windows.feature.md "Opening a window").
// Pure logic, kept out of main.ts so it runs under bun test; main.ts wires
// it to the BrowserWindows.

import { linkEntry, matchAppPage, splitRepoPath } from "../frontend/route";
import { deepLinkFromArgv, parseDesktopLink } from "./deepLink";

export type LinkTarget =
  /** One of the app's own pages: the window navigates there itself. */
  | { kind: "inside" }
  /** A `specdriven://` link: shown in place, no second window. */
  | { kind: "deep"; path: string }
  /** A web page: the default browser, never the app window. */
  | { kind: "browser"; url: string }
  /** Anything else (file:, javascript:, mailto:, …) goes nowhere. */
  | { kind: "drop" };

function outside(url: string): LinkTarget {
  const path = parseDesktopLink(url);
  if (path) return { kind: "deep", path };
  if (/^https?:\/\//.test(url)) return { kind: "browser", url };
  return { kind: "drop" };
}

/**
 * A navigation of the window itself (will-navigate). `appOrigins` are the
 * origins the window loads the app from — app://specdriven, plus the dev
 * server in development.
 */
export function navigationTarget(url: string, appOrigins: readonly string[]): LinkTarget {
  if (appOrigins.some((origin) => url.startsWith(`${origin}/`))) return { kind: "inside" };
  return outside(url);
}

/**
 * A request for a new window (target=_blank, window.open). A page never
 * opens a window of the app by itself — that is the File menu's and the
 * folder dialog's to do — so even one of its own urls is not followed.
 */
export function windowOpenTarget(url: string): LinkTarget {
  return outside(url);
}

/**
 * The script that moves a loaded window to `path`: the same history jump a
 * sidebar click makes, so Back returns to what was on screen and nothing
 * reloads. JSON.stringify keeps a hostile url from breaking out of the
 * string literal; the path is flagged as a link, so it may name its spec
 * folder (linkEntry).
 */
export function historyJump(path: string): string {
  return (
    `history.pushState(null, "", ${JSON.stringify(linkEntry(path))});` +
    `dispatchEvent(new PopStateEvent("popstate"));`
  );
}

/** What the router needs of the app window. */
export interface LinkWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  /** Whether the page is still loading, so a script would run too early. */
  isLoading(): boolean;
  /** Run `fn` once the page has loaded. */
  afterLoad(fn: () => void): void;
  run(script: string): void;
}

/** Where a link from outside belongs, among the app's windows. */
export type LinkPlace =
  /** The window that shows the folder the link names. */
  | { kind: "window"; id: string }
  /** No window shows that folder, and it is one opened before: a window of its own. */
  | { kind: "folder"; repo: string }
  /** The link names no folder this machine knows: the window used last. */
  | { kind: "front" };

/**
 * The words a path starts with when it names a page rather than a folder,
 * as far as the shell can tell: a feature, or one of the app's own pages. A
 * plugin's pages are its window's to know (App.tsx reads the link again).
 */
function namesPage(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  return (segs[0] === "features" && segs.length > 1) || matchAppPage(path) !== null;
}

/**
 * Which window a link's path belongs in. A link names its specifications
 * folder first (route.ts desktopLink): `open` are the windows showing one,
 * `recent` the folders opened before.
 */
export function linkPlace(
  path: string,
  open: readonly { id: string; repo: string }[],
  recent: readonly string[],
): LinkPlace {
  const { repo } = splitRepoPath(path, [...open.map((w) => w.repo), ...recent], namesPage);
  if (!repo) return { kind: "front" };
  const shown = open.find((w) => w.repo === repo);
  return shown ? { kind: "window", id: shown.id } : { kind: "folder", repo };
}

export interface LinkRouterDeps {
  /**
   * The open window a link is shown in — the one showing its folder, else
   * the one used last — or null when it gets a window of its own: none is
   * open (macOS, all closed), or it names a folder none shows. A null
   * `path` asks for the window used last.
   */
  window(path: string | null): LinkWindow | null;
  /** Open the window for `path`; it takes its entry url from takeEntry(). */
  openWindow(path: string): void;
}

export function createLinkRouter(deps: LinkRouterDeps) {
  /** A link that arrived before there was a window to show it in. */
  let pending: string | null = null;

  function bringToFront(win: LinkWindow): void {
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /** Show an app path that came from outside. */
  function open(path: string): void {
    const win = deps.window(path);
    if (!win) {
      pending = path;
      deps.openWindow(path);
      return;
    }
    bringToFront(win);
    const jump = () => win.run(historyJump(path));
    if (win.isLoading()) win.afterLoad(jump);
    else jump();
  }

  return {
    open,

    /** Where a url the window tries to reach goes; deep links are shown. */
    follow(target: LinkTarget, openInBrowser: (url: string) => void): void {
      if (target.kind === "deep") open(target.path);
      else if (target.kind === "browser") openInBrowser(target.url);
    },

    /**
     * A second launch of the app (Windows and Linux deliver a deep link as
     * its argument): the link, if any, is shown where it belongs; without
     * one the window used last comes to the front. No second app starts.
     */
    secondLaunch(argv: readonly string[]): void {
      const path = deepLinkFromArgv(argv);
      if (path) {
        open(path);
        return;
      }
      const win = deps.window(null);
      if (win) bringToFront(win);
    },

    /** The link this process was launched with, held for the first window. */
    holdLaunchLink(argv: readonly string[]): void {
      pending ??= deepLinkFromArgv(argv);
    },

    /** The link held for a window still to open, as it arrived; null for none. */
    held(): string | null {
      return pending;
    },

    /** The entry url for a window about to open; consumes a held link. */
    takeEntry(): string {
      const entry = pending ? linkEntry(pending) : "/";
      pending = null;
      return entry;
    },
  };
}
