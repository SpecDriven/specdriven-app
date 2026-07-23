// File helpers on Node APIs only, shared by web and desktop runtimes
// (specs/desktop-app.spec.md). They fill the two Bun.file/Bun.write habits
// the code was written against: writes create missing parent directories,
// and reads of missing paths are null rather than exceptions.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Bun.write-style write: missing parent directories are created first. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * File contents as UTF-8, or null when there is nothing readable at the
 * path (missing, a directory, or under a non-directory segment).
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
    throw e;
  }
}

/** True when a plain file exists at the path (directories don't count). */
export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}
