// Static-file plumbing for the desktop app's internal protocol
// (specs/app/desktop-app.feature.md): map url paths to files in the built
// renderer directory. Pure path logic, kept out of main.ts so it runs under bun
// test.

import { extname, join } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Filesystem path inside rootDir for a url path, or null when the url can't
 * name a bundled file: bad encoding, empty or dot segments, path
 * separators smuggled into a segment. `/` maps to the shell (index.html);
 * anything the caller can't read falls back to the shell too, which is what
 * SPA deep links (specs/ui/navigation.feature.md) rely on.
 */
export function staticFilePath(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, "");
  if (!rel) return join(rootDir, "index.html");
  const segments = rel.split("/");
  const bad = (s: string) => !s || s === "." || s === ".." || /[\\:\0]/.test(s);
  if (segments.some(bad)) return null;
  return join(rootDir, ...segments);
}

/**
 * The shell as it is served, at `/` and at every deep link. The renderer
 * build writes its asset urls relative to index.html — `./index-<hash>.js`
 * — which resolve correctly at `/` and nowhere else: at
 * `/features/app/desktop-app` the window asked for
 * `/features/app/index-<hash>.js`, no file, so the shell came back as the
 * script (a module script with a text/html MIME type, refused) and the
 * window stayed blank. Root-relative urls load from any path, so a launch
 * by `specdriven://` link (specs/ui/navigation.feature.md "links from
 * outside the app") renders like a launch at `/`. Only the leading `./` is
 * touched; absolute and remote urls pass through.
 */
export function shellHtml(html: string): string {
  return html.replace(/\b(src|href)=(["'])\.\//g, "$1=$2/");
}
