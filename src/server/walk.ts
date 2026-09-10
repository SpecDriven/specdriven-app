// The data repo's directory scanner, in its own module so the feature CRUD
// layer, search, and the Automerge drift pass can all share it without
// importing each other.

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

/**
 * The spec tree's root in the data repo (specs/ui/folders.feature.md): every
 * `.feature.md` lives under here, which makes `specs/` a peer of the other
 * top-level folders — `roadmap/`, `tasks/`, `models/` — rather than the
 * "everything that isn't one of those" the feature tree used to be.
 */
export const SPECS_FOLDER = "specs";

/** True for the specs folder itself and anything beneath it. */
export function isSpecsFolderPath(path: string): boolean {
  return path === SPECS_FOLDER || path.startsWith(`${SPECS_FOLDER}/`);
}

export function isFeatureFile(fileName: string): boolean {
  return fileName.endsWith(".feature.md");
}

/**
 * Folders are plain directories in the data repo (specs/ui/folders.feature.md).
 * Hidden entries (`.git` and friends) are not part of the tree.
 *
 * The walk starts at `specs/` and the paths it returns keep that prefix, so
 * the whole server speaks one repo-relative form. Nothing outside `specs/` is
 * scanned: a `.feature.md` left elsewhere by an older client is migrated into
 * the tree (src/server/migrate.ts), not listed where it lies.
 */
export async function walk(
  dataDir: string,
  rel: string = SPECS_FOLDER,
): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true });
  } catch {
    return { files, folders };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      folders.push(path);
      const sub = await walk(dataDir, path);
      files.push(...sub.files);
      folders.push(...sub.folders);
    } else if (isFeatureFile(entry.name)) {
      files.push(path);
    }
  }
  return { files, folders };
}
