// Images pasted into the coding agent pane's message box
// (specs/agents/agent-pane.feature.md "Paste an image into the message"):
// what a paste carries, and turning each image into what the server takes —
// a PNG, JPEG, GIF or WebP no bigger than MAX_IMAGE_BYTES, base64. An image
// past that, or of another type (a TIFF, a BMP), is redrawn on a canvas,
// scaled down until it fits.

import type { ImageMediaType, ImageUpload } from "../server/agentTypes";
import { MAX_IMAGE_BYTES, normalizeImageMediaType } from "../server/agentTypes";

/** An image waiting in the message box. */
export interface PendingImage extends ImageUpload {
  /** Local key for the list. */
  key: string;
  /** A data: url the thumbnail shows. */
  previewUrl: string;
}

/** The pieces of a clipboard (or drop) this module reads; DataTransfer fits. */
export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
  getData(type: string): string;
}

/**
 * The image files a paste carries, or none when it also carries plain text:
 * a copy from a spreadsheet, a word processor or Finder puts a picture of
 * the cells (or the file's icon) next to the text, and the text is what was
 * meant. A screenshot or a browser's "Copy Image" has no text.
 */
export function pastedImageFiles(data: ClipboardLike | null | undefined): File[] {
  if (!data) return [];
  if (data.getData("text/plain").trim() !== "") return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length > 0) return files;
  // Some clipboards fill only `files`.
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** The longest edge a redrawn image keeps: what the agents read at full
    detail (Claude scales past 1568, OpenAI's high detail fits 2048). */
export const MAX_EDGE = 2048;

/** Width and height scaled down (never up) so the longer edge is at most `edge`. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= edge || long === 0) return { width, height };
  const k = edge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Whether a file goes as it is: a type every agent reads, small enough. */
export function sendsAsIs(type: string, size: number): boolean {
  return normalizeImageMediaType(type) !== null && size <= MAX_IMAGE_BYTES;
}

/** The bytes a base64 string stands for. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/** "data:image/png;base64,AAAA" → its type and data. */
export function splitDataUrl(url: string): { type: string; data: string } {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  if (!m) throw new Error("Could not read the image");
  return { type: m[1]!, data: m[2]! };
}

/** Draw `bitmap` at `width`×`height` and encode it as `type`. */
function encode(bitmap: ImageBitmap, width: number, height: number, type: ImageMediaType, quality?: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not redraw the image");
  if (type === "image/jpeg") {
    // JPEG has no transparency: a transparent screenshot would go black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return Promise.resolve(canvas.toDataURL(type, quality));
}

/** Redraw an image the server would refuse: PNG when that fits, else JPEG,
    halving the size until it does. */
async function redraw(file: Blob): Promise<{ mediaType: ImageMediaType; data: string; url: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image could not be read — paste a PNG, JPEG, GIF or WebP image");
  }
  try {
    let { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    for (let tries = 0; tries < 6; tries++) {
      for (const [type, quality] of [
        ["image/png", undefined],
        ["image/jpeg", 0.85],
      ] as const) {
        const url = await encode(bitmap, width, height, type, quality);
        const { data } = splitDataUrl(url);
        if (base64Bytes(data) <= MAX_IMAGE_BYTES) return { mediaType: type, data, url };
      }
      width = Math.max(1, Math.round(width / 2));
      height = Math.max(1, Math.round(height / 2));
    }
  } finally {
    bitmap.close();
  }
  throw new Error("That image is too large to send");
}

let counter = 0;

/** A pasted file, ready for the message box. */
export async function prepareImage(file: File): Promise<PendingImage> {
  const name = file.name && file.name !== "image.png" ? file.name : undefined;
  let mediaType: ImageMediaType;
  let data: string;
  let previewUrl: string;
  if (sendsAsIs(file.type, file.size)) {
    previewUrl = await readDataUrl(file);
    data = splitDataUrl(previewUrl).data;
    mediaType = normalizeImageMediaType(file.type)!;
  } else {
    const drawn = await redraw(file);
    ({ mediaType, data } = drawn);
    previewUrl = drawn.url;
  }
  counter += 1;
  return { key: `img-${counter}`, mediaType, data, previewUrl, ...(name ? { name } : {}) };
}

/** What goes over the wire: no preview, no key. */
export function toUpload(image: PendingImage): ImageUpload {
  return { mediaType: image.mediaType, data: image.data, ...(image.name ? { name: image.name } : {}) };
}
