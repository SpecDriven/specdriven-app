// File helpers on Node APIs only, shared by web and desktop runtimes
// (specs/app/desktop-app.feature.md). They fill the two Bun.file/Bun.write
// habits the code was written against: writes create missing parent
// directories, and reads of missing paths are null rather than exceptions.
//
// These are the Promise forms of the Effect programs in
// src/server/persistence/Files.ts, run on Node's file system
// (persistence/runtime.ts). A failure rejects with the errno exception.

import * as Files from "./persistence/Files";
import { run } from "./persistence/runtime";

/** Bun.write-style write: missing parent directories are created first. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return run(Files.writeText(path, content));
}

/**
 * Replace a file in one step: the content goes to a sibling temp file,
 * then takes the path over by rename, so a reader never sees a torn or
 * empty file while a write is under way (the settings file, which several
 * requests read and write at once).
 */
export async function replaceTextFile(path: string, content: string): Promise<void> {
  return run(Files.replaceText(path, content));
}

/**
 * File contents as UTF-8, or null when there is nothing readable at the
 * path (missing, a directory, or under a non-directory segment).
 */
export async function readTextFile(path: string): Promise<string | null> {
  return run(Files.readText(path));
}

/** True when a plain file exists at the path (directories don't count). */
export async function fileExists(path: string): Promise<boolean> {
  return run(Files.fileExists(path));
}

/** True when a directory exists at the path. */
export async function directoryExists(path: string): Promise<boolean> {
  return run(Files.directoryExists(path));
}
