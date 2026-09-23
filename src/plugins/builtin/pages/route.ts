// The special folders' urls (specs/app/roadmap.feature.md, specs/app/tasks
// .feature.md, specs/app/engineering-notebook.feature.md), owned by the pages
// plugin rather than by src/frontend/route.ts:
//
//   /roadmap, /tasks, /notebook                     that tab, on its first page
//   /roadmap/<page>                                 roadmap page
//   /tasks/<task>                                   task
//   /notebook/<entry>                               notebook entry
//
// <page> is the file's path under the folder, without `.md`; a hand-typed
// link may carry the suffix already. Each folder is its own plugin, so each
// parses only its own prefix.

/**
 * A folder's one view: a page, by its repo-relative file name — or, with none
 * named, the tab itself, which opens on the first page it lists
 * (specs/app/tasks.feature.md "A bare folder url opens that tab"). A search
 * hit that opened the page carries its matched words, marked in the editor
 * (specs/search.feature.md); the url never does.
 */
export interface PageRoute {
  fileName: string | null;
  terms?: string[];
}

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The folder a page's file name lives in — `roadmap`, `tasks` or `notebook`. */
export function pageFolderOf(fileName: string): string {
  return fileName.split("/")[0] ?? "";
}

/** The view a url names, or null when the url is not the folder's. */
export function parsePageRoute(folder: string, pathname: string): PageRoute | null {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== folder) return null;
  if (!segs[1]) return { fileName: null };
  const path = segs.slice(1).join("/").replace(/\.md$/, "");
  return { fileName: `${folder}/${path}.md` };
}

/** `roadmap/q3/pricing.md` -> `/roadmap/q3/pricing`; `tasks/ship.md` likewise. */
export function pageLink(fileName: string): string {
  const folder = pageFolderOf(fileName);
  const stem = fileName.slice(folder.length + 1).replace(/\.md$/, "");
  return `/${folder}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** The url of a view — the inverse of parsePageRoute. */
export function pagesPath(folder: string, view: PageRoute): string {
  return view.fileName ? pageLink(view.fileName) : `/${folder}`;
}
