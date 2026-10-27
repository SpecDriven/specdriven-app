// Pure helpers for image markup (specs/image-editor-markup.feature.md), kept
// apart from the library like diagram.ts so tests can import them without a
// DOM and the editor's main bundle never pulls Excalidraw in.
//
// A marked-up image is a PNG the size of the image it was drawn on, the
// shapes burnt in so every view of the text shows them. So the markup stays
// editable, the PNG also carries a `tEXt` chunk naming the clean original and
// listing the shapes: reopened, the pane puts the original back on the canvas
// with the shapes over it, rather than drawing over the burnt-in copy. The
// photo itself is not carried twice — the original stays in `.images/`, as
// every stored image does.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isDiagram } from "./diagram";

/** The `tEXt` keyword the markup travels under — not Excalidraw's own, so its loader never reads one as a scene. */
export const MARKUP_KEYWORD = "specdriven-markup";

/** The server's upload limit (src/server/images.ts MAX_IMAGE_BYTES), checked before the pane closes. */
export const MAX_MARKUP_BYTES = 10 * 1024 * 1024;

/** A stored image's url: `/api/images/<name>`, a name storeImage generates (src/server/images.ts SAFE_NAME). */
const STORED = /^\/api\/images\/([a-z0-9][a-z0-9-]*)\.(png|jpe?g|gif|webp|avif|svg)$/;

function stored(src: string): RegExpMatchArray | null {
  return src.split(/[?#]/)[0]!.match(STORED);
}

/**
 * Whether an image in the source can be marked up: one stored in the data
 * repo, so the canvas can read its pixels (a cross-origin image would taint
 * it) and the result has somewhere to go. A diagram is not one — it has its
 * own editor, and its shapes are already editable there.
 */
export function canMarkUp(alt: string, src: string): boolean {
  return stored(src) !== null && !isDiagram(alt, src);
}

/**
 * The upload name for a marked-up copy of `src`: its stem without the
 * content hash storeImage added, nor a `-markup` an earlier copy did, plus
 * `-markup.png` — stored as `<stem>-markup-<hash>.png`, so marking up again
 * never piles the suffixes up.
 */
export function markupFileName(src: string): string {
  const stem = (stored(src)?.[1] ?? "")
    .replace(/-[0-9a-f]{8}$/, "")
    .replace(/-markup$/, "");
  return `${stem || "image"}-markup.png`;
}

/** What a marked-up PNG remembers of how it was made. */
export interface MarkupRecord {
  version: 1;
  /** The clean original's url — never an earlier markup, so copies never stack. */
  source: string;
  /** The shapes, with the original's top-left corner at 0,0. */
  elements: readonly ExcalidrawElement[];
}

/**
 * The record as `tEXt` can carry it: JSON, every character outside ASCII
 * escaped as `\uXXXX` — still JSON, and inside Latin-1, which is all the
 * chunk holds.
 */
export function encodeMarkup(record: MarkupRecord): string {
  return JSON.stringify(record).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The record a chunk holds, or null for anything that is not one. */
export function decodeMarkup(text: string | null): MarkupRecord | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { version, source, elements } = value as Record<string, unknown>;
  if (version !== 1 || typeof source !== "string" || stored(source) === null) return null;
  if (!Array.isArray(elements)) return null;
  const shapes = elements.every(
    (el) =>
      typeof el === "object" &&
      el !== null &&
      typeof (el as { id?: unknown }).id === "string" &&
      typeof (el as { type?: unknown }).type === "string",
  );
  return shapes ? { version, source, elements: elements as ExcalidrawElement[] } : null;
}

/** The markup a PNG carries, or null for one with none (or bytes that are no PNG). */
export function readMarkup(png: Uint8Array): MarkupRecord | null {
  return decodeMarkup(readPngText(png, MARKUP_KEYWORD));
}

/** The PNG carrying `record`, in place of any markup it carried before. */
export function withMarkup(png: Uint8Array, record: MarkupRecord): Uint8Array<ArrayBuffer> {
  return withPngText(png, MARKUP_KEYWORD, encodeMarkup(record));
}

/** Elements moved by dx, dy; a line's or arrow's points are relative to its x, y and move with it. */
export function shiftElements<T extends { x: number; y: number }>(
  elements: readonly T[],
  dx: number,
  dy: number,
): T[] {
  return elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }));
}

// ---- PNG text chunks ----

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The PNG chunk CRC: CRC-32 over the chunk's type and data. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  /** Where the chunk starts (its length field) and ends (after its CRC). */
  start: number;
  end: number;
  data: Uint8Array;
}

/** The chunks of a PNG in file order, or null for bytes that are not one. */
function chunks(png: Uint8Array): Chunk[] | null {
  if (png.length < SIGNATURE.length || SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let at = SIGNATURE.length;
  while (at + 12 <= png.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > png.length) return null;
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    out.push({ type, start: at, end, data: png.subarray(at + 8, at + 8 + length) });
    at = end;
    if (type === "IEND") return out;
  }
  return null;
}

/** Latin-1 text as bytes; a character beyond it is the caller's mistake. */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) throw new Error("PNG text must be Latin-1");
    bytes[i] = c;
  }
  return bytes;
}

/** Whether a chunk is the `tEXt` one under `keyword`: the keyword, then a NUL, then the text. */
function isText(chunk: Chunk, keyword: string): boolean {
  if (chunk.type !== "tEXt") return false;
  const nul = chunk.data.indexOf(0);
  return nul >= 0 && String.fromCharCode(...chunk.data.subarray(0, nul)) === keyword;
}

/** The `tEXt` chunk's text under `keyword`, or null when the PNG has none (or is not a PNG). */
export function readPngText(png: Uint8Array, keyword: string): string | null {
  const chunk = chunks(png)?.find((c) => isText(c, keyword));
  if (!chunk) return null;
  let text = "";
  for (const b of chunk.data.subarray(keyword.length + 1)) text += String.fromCharCode(b);
  return text;
}

/**
 * The PNG with `text` under `keyword` in a `tEXt` chunk just before `IEND`,
 * in place of any chunk the keyword already had.
 */
export function withPngText(png: Uint8Array, keyword: string, text: string): Uint8Array<ArrayBuffer> {
  const all = chunks(png);
  if (!all) throw new Error("not a PNG");
  const iend = all[all.length - 1]!;
  const kept = all.filter((c) => c !== iend && !isText(c, keyword));
  const data = new Uint8Array([...latin1(keyword), 0, ...latin1(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(latin1("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const parts = [
    png.subarray(0, SIGNATURE.length),
    ...kept.map((c) => png.subarray(c.start, c.end)),
    chunk,
    png.subarray(iend.start, iend.end),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
