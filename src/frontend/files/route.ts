// The Files tab's urls (specs/app/code-repo-mode.feature.md "A file opens
// in a plain text editor"), mounted only while a code repository is open:
//
//   /                  the home view (the repository's README.md when it has one)
//   /files             the same
//   /files/<path>      one file, its path relative to the repository

/** The tab's views: home, or one file. */
export interface FilesView {
  /** The file's path relative to the repository, `/` separated; null for home. */
  path: string | null;
}

export const FILES_HOME: FilesView = { path: null };

/** Decode a path segment; a malformed escape is kept as it is. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The view a url names, or null when the url is not the tab's. The bare
 * `/` is the tab's home, so the app opens on the repository rather than on
 * a README the specifications folder would have had.
 */
export function parseFilesRoute(pathname: string): FilesView | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return FILES_HOME;
  if (segs[0] !== "files") return null;
  if (segs.length === 1) return FILES_HOME;
  return { path: segs.slice(1).map(decodeSegment).join("/") };
}

/** The url of a view — the inverse of parseFilesRoute. */
export function filesPath(view: FilesView): string {
  return view.path === null ? "/" : `/files/${view.path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A key that changes with the view. */
export function filesKey(view: FilesView): string {
  return view.path ?? "";
}

/** A path's last segment: a file's or a folder's name. */
export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The folders a path sits in, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function parentFolders(path: string): string[] {
  const segs = path.split("/");
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
}
