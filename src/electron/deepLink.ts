// Links that arrive from outside the app (specs/navigation.spec.md "links
// from outside the app"): the OS hands the desktop shell a `specdriven://`
// url, which carries the same paths the window already routes on. Pure url
// logic, kept out of main.ts so it runs under bun test.

import { DESKTOP_SCHEME } from "../frontend/route";

/**
 * App path for a `specdriven://` url, or null when it isn't one.
 *
 * `specdriven://features/quotes` parses `features` as the url *host*, so the
 * app path is host + pathname; the three-slash form `specdriven:///features/
 * quotes` has an empty host and carries the whole path. Query and fragment
 * are dropped — parseRoute only reads the path.
 */
export function parseDesktopLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${DESKTOP_SCHEME}:`) return null;
  return `/${url.host}${url.pathname}`.replace(/\/{2,}/g, "/");
}

/**
 * The deep link among process arguments — how Windows and Linux deliver one
 * (macOS uses the `open-url` event). Arguments that aren't urls are skipped.
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const path = parseDesktopLink(arg);
    if (path) return path;
  }
  return null;
}
