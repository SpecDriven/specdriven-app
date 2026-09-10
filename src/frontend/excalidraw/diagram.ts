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
