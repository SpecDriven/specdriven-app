// The data repo's directory scanner, in its own module so the feature CRUD
// layer, search, and the Automerge drift pass can all share it without
// importing each other.

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

export function isFeatureFile(fileName: string): boolean {
  return fileName.endsWith(".feature.md");
}

/**
 * Folders are plain directories in the data repo (specs/folders.spec.md).
 * Hidden entries (`.git` and friends) are not part of the tree.
 */
export async function walk(
  dataDir: string,
  rel = "",
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
