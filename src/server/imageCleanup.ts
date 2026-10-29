// Unused images (specs/app/unused-images.feature.md): the stored images
// under `.images/` (src/server/images.ts) with the data-repo files that
// reference each, so the Images page can show the ones nothing references
// any more — a screenshot whose line was deleted, replaced or re-pointed by
// a markup save — and delete the ones the user picks, a `git rm` committed
// and pushed like any other change. The server re-scans before deleting, so
// a page that went stale cannot remove an image a body took up meanwhile.

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { readFeatureForEditor } from "./features";
import { readTextFile } from "./fsx";
import { removeAndPush } from "./git";
import { IMAGES_DIR, IMAGES_ROUTE, isStoredImageName, referencedImageNames } from "./images";
import { walk } from "./walk";

export interface StoredImage {
  name: string;
  /** The url the app serves it on — what a body references and a thumbnail loads. */
  path: string;
  bytes: number;
  /** The data-repo files that reference it, repo-relative and sorted; empty for an unused one. */
  referencedBy: string[];
}

/** Files whose text can carry a `/api/images/<name>` url: features, pages, notes, event models. */
const TEXT_FILE = /\.(md|txt|json|ya?ml|csv|html?)$/i;

/** Every text file in the repo, repo-relative — hidden entries (`.git`, `.images`, the store) and node_modules left out, as walk.ts does. */
async function textFiles(dataDir: string, rel = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(rel ? `${dataDir}/${rel}` : dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await textFiles(dataDir, path)));
    else if (TEXT_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

/**
 * Which files reference each stored image: every text file on disk, plus
 * each feature as the editor sees it (src/server/features.ts
 * readFeatureForEditor), so a draft scenario that lives only in the
 * Automerge document keeps its images too.
 */
export async function imageReferences(dataDir: string): Promise<Map<string, string[]>> {
  const refs = new Map<string, Set<string>>();
  const note = (file: string, text: string | null) => {
    if (text === null) return;
    for (const name of referencedImageNames(text)) {
      let files = refs.get(name);
      if (!files) refs.set(name, (files = new Set()));
      files.add(file);
    }
  };
  for (const file of await textFiles(dataDir)) note(file, await readTextFile(`${dataDir}/${file}`));
  for (const file of (await walk(dataDir)).files) note(file, await readFeatureForEditor(dataDir, file));
  return new Map([...refs].map(([name, files]) => [name, [...files].sort()]));
}

/** Every stored image, name order, with its size and the files that reference it. */
export async function listImages(dataDir: string): Promise<StoredImage[]> {
  let names: string[];
  try {
    names = (await readdir(`${dataDir}/${IMAGES_DIR}`)).filter(isStoredImageName).sort();
  } catch {
    return [];
  }
  const refs = await imageReferences(dataDir);
  return Promise.all(
    names.map(async (name) => ({
      name,
      path: `${IMAGES_ROUTE}${encodeURIComponent(name)}`,
      bytes: (await stat(`${dataDir}/${IMAGES_DIR}/${name}`)).size,
      referencedBy: refs.get(name) ?? [],
    })),
  );
}

/** Thrown by deleteImages when a name asked for is still referenced: the route answers 409 with the map. */
export class StillReferenced extends Error {
  constructor(readonly referenced: Record<string, string[]>) {
    const names = Object.keys(referenced);
    super(
      names.length === 1
        ? `${names[0]} is still referenced by ${referenced[names[0]!]!.join(", ")}`
        : `${names.length} images are still referenced: ${names.join(", ")}`,
    );
    this.name = "StillReferenced";
  }
}

/**
 * Delete stored images nothing references: a `git rm` of each, committed
 * and pushed together. Refuses names storeImage never generates, names with
 * no file, and — after scanning afresh — any that a file references now.
 */
export async function deleteImages(
  dataDir: string,
  names: string[],
): Promise<{ deleted: string[]; message: string }> {
  const unique = [...new Set(names)];
  if (unique.length === 0) throw new Error("No images named");
  for (const name of unique) {
    if (!isStoredImageName(name)) throw new Error(`Not a stored image name: ${name}`);
  }
  const stored = new Set(await readdir(`${dataDir}/${IMAGES_DIR}`).catch(() => [] as string[]));
  const missing = unique.filter((name) => !stored.has(name));
  if (missing.length > 0) throw new Error(`No such image: ${missing.join(", ")}`);
  const refs = await imageReferences(dataDir);
  const referenced: Record<string, string[]> = {};
  for (const name of unique) {
    const files = refs.get(name);
    if (files) referenced[name] = files;
  }
  if (Object.keys(referenced).length > 0) throw new StillReferenced(referenced);
  const sync = await removeAndPush(
    dataDir,
    unique.map((name) => `${IMAGES_DIR}/${name}`),
    `Delete unused image${unique.length === 1 ? "" : "s"}: ${unique.join(", ")}`,
  );
  return { deleted: unique, message: sync.message };
}
