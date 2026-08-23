// The data repo's README.md (specs/app-startup.feature.md "App Starts with
// existing specs folder selected"): the file the app opens on at start, in an
// editor that saves it at the scenario editor's autosave interval. Saves land
// in the working tree only; the reload cron's sync commits and pushes them
// with everything else (src/server/reload.ts).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";

export const README_FILE = "README.md";

export interface ReadmeView {
  /** The file's text; empty when there is no README yet. */
  content: string;
  /** False when the data repo has no README — the editor then creates one. */
  exists: boolean;
}

/**
 * The README's file name inside the data repo: `README.md`, or the repo's
 * own spelling of it (`readme.md`, `Readme.md`) when that is what it has —
 * a save must not put a second file beside it on a case-sensitive disk.
 */
export async function readmeFileName(dataDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return README_FILE;
  }
  if (entries.includes(README_FILE)) return README_FILE;
  const lower = README_FILE.toLowerCase();
  return entries.find((e) => e.toLowerCase() === lower) ?? README_FILE;
}

export async function readReadme(dataDir: string): Promise<ReadmeView> {
  const content = await readTextFile(join(dataDir, await readmeFileName(dataDir)));
  return content === null ? { content: "", exists: false } : { content, exists: true };
}

/** Write the README as the editor holds it, creating it when missing. */
export async function writeReadme(dataDir: string, content: string): Promise<ReadmeView> {
  await writeTextFile(join(dataDir, await readmeFileName(dataDir)), content);
  return { content, exists: true };
}
