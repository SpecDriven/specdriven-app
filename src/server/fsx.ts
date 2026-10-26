// File helpers on Node APIs only, shared by web and desktop runtimes
// (specs/app/desktop-app.feature.md). They fill the two Bun.file/Bun.write
// habits the code was written against: writes create missing parent
// directories, and reads of missing paths are null rather than exceptions.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Bun.write-style write: missing parent directories are created first. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * Replace a file in one step: the content goes to a sibling temp file,
 * then takes the path over by rename, so a reader never sees a torn or
 * empty file while a write is under way (the settings file, which several
 * requests read and write at once).
 */
export async function replaceTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content);
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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

/** True when a directory exists at the path. */
export async function directoryExists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
