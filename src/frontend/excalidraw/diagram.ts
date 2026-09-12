// Pure helpers for the Excalidraw pane (specs/editor/excalidraw-support
// .feature.md), kept apart from the library itself so tests can import them
// without a DOM and the editor's main bundle never pulls Excalidraw in.

/** The server's slugify (src/server/parser.ts), so the name typed here and the stored stem agree. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The upload name for a diagram: `<name>.excalidraw.svg`. The image pipeline
 * (src/frontend/MarkdownEditor.tsx addImages, src/server/images.ts) keeps the
 * stem minus the last extension as the alt text — `<name>.excalidraw` — and
 * slugifies it for the stored file — `<name>-excalidraw-<hash>.svg` — which is
 * exactly the shape an excalidraw.com export pasted in by hand already has.
 */
export function diagramFileName(name: string): string {
  return `${slug(name) || "diagram"}.excalidraw.svg`;
}

/** The exported SVG markup as the file the image upload takes. */
export function svgFile(markup: string, name: string): File {
  return new File([markup], diagramFileName(name), { type: "image/svg+xml" });
}

// ---- Editing an embedded diagram ("Edit Excalidraw diagram") ----

/** `<stem>.excalidraw`, the alt an inserted or pasted export carries. */
const ALT = /^(.*)\.excalidraw$/;
/** `<stem>-excalidraw-<hash>.svg`, the file name storeImage gives one. */
const FILE = /(?:^|\/)([^/]*)-excalidraw-[0-9a-f]{8}\.svg$/;

/**
 * Whether an image in the source is an Excalidraw diagram — one the pane can
 * reopen, because its SVG carries the scene. Either mark is enough: the alt
 * (`<name>.excalidraw`), which survives a hand-written link, or the stored
 * file name (`<name>-excalidraw-<hash>.svg`), which survives a retyped alt.
 * Whether the scene really is embedded is only known once the SVG is read;
 * the pane says so then (src/frontend/excalidraw/ExcalidrawPane.tsx).
 */
export function isDiagram(alt: string, src: string): boolean {
  return ALT.test(alt) || FILE.test(src.split(/[?#]/)[0]!);
}

/**
 * The name to reopen a diagram under, so saving it keeps the link's shape:
 * the alt's stem where there is one, else the stored file's, else "diagram".
 */
export function diagramName(alt: string, src: string): string {
  const byAlt = alt.match(ALT)?.[1];
  if (byAlt) return byAlt;
  const byFile = src.split(/[?#]/)[0]!.match(FILE)?.[1];
  return byFile || "diagram";
}
