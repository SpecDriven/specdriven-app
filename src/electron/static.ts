// Static-file plumbing for the desktop app's internal protocol
// (specs/desktop-app.spec.md): map url paths to files in the built renderer
// directory. Pure path logic, kept out of main.ts so it runs under bun test.

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
 * SPA deep links (specs/navigation.spec.md) rely on.
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
