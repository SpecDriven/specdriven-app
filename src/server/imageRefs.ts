// How a body names a stored image (specs/editor/images.feature.md), in its
// two forms. Kept free of node imports so the parser and the frontend can
// use it (images.ts, which stores and reads the files, cannot be).
//
// The app form, `/api/images/<name>`, is the route this app serves the file
// on: what the editor inserts, the document holds and the preview loads.
//
// The file form, `/.images/<name>`, is where the file sits in the data repo,
// from its root: what a `.feature.md` or a page says on disk. GitHub reads a
// path that starts with `/` in a repo's markdown from the repository root,
// so the file shows its images there, where `/api/images/…` is a dead link
// into GitHub's own site.
//
// parser.ts turns one into the other at the edge of the markdown text:
// serializing writes the file form, parsing reads either as the app form. The
// document never sees the difference, so a published scenario's body is the
// same body in both.

/** Formats the preview can render; anything else is refused on upload. */
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME).join("|");

/** A name storeImage generates, `<slug>-<hash>.<ext>`, as a pattern source. */
const STORED_NAME = `[a-z0-9][a-z0-9-]*\\.(?:${IMAGE_EXTENSIONS})`;

/** Only names storeImage itself generates. */
export const STORED_IMAGE_NAME = new RegExp(`^${STORED_NAME}$`);

/** The route the app serves stored images on; a body references one as `![alt](/api/images/<name>)`. */
export const IMAGES_ROUTE = "/api/images/";

/** The same image as a markdown file names it: its path from the data repo's root. */
export const IMAGES_REPO_PATH = "/.images/";

// A reference is the prefix and a stored name, standing on its own: after a
// character a url could carry it is the tail of a longer one
// (`http://host/api/images/x.png`, `…/blob/main/.images/x.png`), which is
// somebody else's address and stays as written. A placeholder in prose
// (`/api/images/<name>`) is no stored name and stays too.
const BEFORE = "(^|[^A-Za-z0-9_.:/~%@-])";
const AFTER = "(?![A-Za-z0-9_-])";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function swap(from: string, to: string): (text: string) => string {
  const pattern = new RegExp(`${BEFORE}${escape(from)}(${STORED_NAME})${AFTER}`, "g");
  return (text) => (text.includes(from) ? text.replace(pattern, `$1${to}$2`) : text);
}

/** Markdown as a file holds it: every stored image named by its place in the repo. */
export const toFileImageRefs = swap(IMAGES_ROUTE, IMAGES_REPO_PATH);

/** Markdown as the app holds it: every stored image named by the route that serves it. */
export const toAppImageRefs = swap(IMAGES_REPO_PATH, IMAGES_ROUTE);
