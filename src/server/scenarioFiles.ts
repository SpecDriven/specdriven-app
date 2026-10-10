// Files stored with a scenario (specs/editor/store-associated-files
// .feature.md): the xml, csv, json or binary test data a scenario needs to
// upload into the system under test. Stored like pasted images
// (src/server/images.ts) — plain files under `.files/` in the data repo, the
// dot keeping the folder out of the sidebar tree while git tracks and syncs
// it — with content-addressed names, so the same bytes attached twice are
// one file. Which scenario lists which file, and under what name, is the
// feature's Automerge document's business (schema.ts SpecEntry.files).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { commitAndPush } from "./git";
import { fileExists } from "./fsx";
import { slugify } from "./parser";
import { isStoredFileName } from "./scenarioFileList";

export const FILES_DIR = ".files";

/**
 * Test data, not media: generous next to the image limit, and well under
 * the 100 MB GitHub refuses a pushed file at.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Store an uploaded file in the data repo, committed and pushed like an
 * image. Returns the stored name. The original name only contributes its
 * slugified stem and extension; the content hash makes the name unique and
 * a repeat upload of the same bytes a no-op.
 */
export async function storeScenarioFile(
  dataDir: string,
  originalName: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error("File is empty");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`File is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  }
  const dot = originalName.lastIndexOf(".");
  const rawExt = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : "";
  const stem = slugify(dot > 0 ? originalName.slice(0, dot) : originalName) || "file";
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${stem.slice(0, 60).replace(/-+$/, "") || "file"}-${hash}${ext ? `.${ext}` : ""}`;
  const relPath = `${FILES_DIR}/${name}`;
  const path = `${dataDir}/${relPath}`;
  // Same name = same content (the hash covers the bytes): nothing to write.
  if (!(await fileExists(path))) {
    await mkdir(`${dataDir}/${FILES_DIR}`, { recursive: true });
    await writeFile(path, bytes);
    await commitAndPush(dataDir, relPath, `Add file: ${name}`);
  }
  return name;
}

/**
 * Bytes of a stored file, or null when the name is not one
 * storeScenarioFile generates (traversal, hidden files) or nothing is
 * stored under it.
 */
export async function readScenarioFile(
  dataDir: string,
  stored: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isStoredFileName(stored)) return null;
  try {
    return (await readFile(`${dataDir}/${FILES_DIR}/${stored}`)) as Uint8Array<ArrayBuffer>;
  } catch {
    return null;
  }
}

/** Whether a stored file of that name is in the repo. */
export async function scenarioFileExists(dataDir: string, stored: string): Promise<boolean> {
  return isStoredFileName(stored) && (await fileExists(`${dataDir}/${FILES_DIR}/${stored}`));
}
