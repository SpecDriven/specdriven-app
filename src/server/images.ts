// Images embedded in scenario bodies (specs/images.feature.md). Stored as
// plain files under `.images/` in the data repo — the dot keeps the folder
// out of the sidebar tree (features.ts walk skips hidden entries) while git
// tracks and syncs it like any other content. Names are content-addressed
// (slug + content hash), so pasting the same screenshot twice reuses one
// file and a name can be served with immutable cache headers.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { commitAndPush } from "./git";
import { fileExists } from "./fsx";
import { slugify } from "./parser";

export const IMAGES_DIR = ".images";

/** Formats the preview can render; anything else is refused on upload. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

const EXTENSIONS = Object.keys(IMAGE_MIME).join("|");

/** Only names storeImage itself generates: `<slug>-<hash>.<ext>`. */
const SAFE_NAME = new RegExp(`^[a-z0-9][a-z0-9-]*\\.(${EXTENSIONS})$`);

/** Pasted screenshots are small; this guards against accidental huge files. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function imageMime(name: string): string {
  return IMAGE_MIME[name.split(".").pop() ?? ""] ?? "application/octet-stream";
}

function safeImageName(name: string): string | null {
  return SAFE_NAME.test(name) ? name : null;
}

/** Whether a name is one storeImage generates — what `.images/` may hold and a url may name. */
export function isStoredImageName(name: string): boolean {
  return SAFE_NAME.test(name);
}

/** The route the app serves stored images on; a body references one as `![alt](/api/images/<name>)`. */
export const IMAGES_ROUTE = "/api/images/";

/**
 * The stored image a url in a body names — `/api/images/<name>`, the name
 * one storeImage generates — or null for any other url.
 */
export function storedImageName(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(IMAGES_ROUTE)) return null;
  let name: string;
  try {
    name = decodeURIComponent(trimmed.slice(IMAGES_ROUTE.length));
  } catch {
    return null;
  }
  return safeImageName(name);
}

/** A stored-image url wherever it sits in text: its name runs to the first character a url cannot carry. */
const IMAGE_URL = /\/api\/images\/([^\s)"'<>`\]]+)/g;

/**
 * The stored images a text references (specs/app/unused-images.feature.md):
 * every `/api/images/<name>` in it — in a markdown image, an `<img>` tag or
 * plain prose alike — whose name is one storeImage generates. A textual
 * scan on purpose: a reference the renderer would not show still counts,
 * which is the safe side for a tool that deletes what is unreferenced.
 */
export function referencedImageNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(IMAGE_URL)) {
    const name = storedImageName(`${IMAGES_ROUTE}${m[1]!}`);
    if (name) names.add(name);
  }
  return names;
}

/** The part of a stored name that says which bytes it holds. */
function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * The name these bytes earn under a stored image's name: the name itself
 * while they are the ones it was given for, else its stem with their own
 * hash. A file edited in place — an agent touching up a screenshot, a save
 * over it — keeps its name in the repo, so anything that takes the name as
 * proof of the content (a Confluence attachment of that name, say) asks
 * here which name the current bytes go by.
 */
export function currentImageName(name: string, bytes: Uint8Array): string {
  const m = name.match(/^(.*?)(?:-[0-9a-f]{8})?\.([a-z0-9]+)$/);
  if (!m) return name;
  return `${m[1]}-${contentHash(bytes)}.${m[2]}`;
}

/**
 * Store an uploaded or pasted image in the data repo, committed and pushed
 * like a feature edit. Returns the stored file name. The original file name
 * only contributes its slugified stem and extension; the content hash makes
 * the name unique and repeat uploads of the same bytes a no-op.
 */
export async function storeImage(
  dataDir: string,
  originalName: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error("Image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
  }
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";
  if (!IMAGE_MIME[ext]) {
    throw new Error(`Unsupported image type: ${originalName} — use ${EXTENSIONS.replaceAll("|", ", ")}`);
  }
  const stem = slugify(originalName.replace(/\.[^.]*$/, "")) || "image";
  const name = `${stem}-${contentHash(bytes)}.${ext}`;
  const relPath = `${IMAGES_DIR}/${name}`;
  const path = `${dataDir}/${relPath}`;
  // Same name = same content (the hash covers the bytes): nothing to write.
  if (!(await fileExists(path))) {
    await mkdir(`${dataDir}/${IMAGES_DIR}`, { recursive: true });
    await writeFile(path, bytes);
    await commitAndPush(dataDir, relPath, `Add image: ${name}`);
  }
  return name;
}

/**
 * Bytes of a stored image, or null when the name is not one storeImage
 * generates (traversal, hidden files) or nothing is stored under it.
 */
export async function readImage(
  dataDir: string,
  name: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!safeImageName(name)) return null;
  try {
    // A Buffer is ArrayBuffer-backed; the assertion just narrows the generic
    // so the bytes are directly usable as a Response body.
    return (await readFile(`${dataDir}/${IMAGES_DIR}/${name}`)) as Uint8Array<ArrayBuffer>;
  } catch {
    return null;
  }
}
