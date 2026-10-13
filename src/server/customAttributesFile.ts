// The data repo's `custom-attributes.txt` on disk
// (specs/app/custom-attributes.feature.md "Custom attributes are defined in
// Settings"). Saves land in the working tree only, like the README's; the
// reload cron's sync stages, commits and pushes the file with everything
// else, so the team shares one set of definitions (src/server/reload.ts).

import { join } from "node:path";
import { mergeText } from "./automerge/merge";
import { CUSTOM_ATTRIBUTES_FILE } from "./customAttributes";
import { readTextFile, writeTextFile } from "./fsx";

/** The most the file may hold: definitions are a page, not a database. */
export const CUSTOM_ATTRIBUTES_MAX_BYTES = 64 * 1024;

/** The file's text; empty when the data repo has none yet. */
export async function readCustomAttributes(dataDir: string): Promise<string> {
  return (await readTextFile(join(dataDir, CUSTOM_ATTRIBUTES_FILE))) ?? "";
}

/**
 * Write the definitions as Settings holds them, creating the file when
 * missing. `expected` is what Settings last loaded or saved: a disk edit
 * made since (a teammate's definitions arriving with a pull, a hand edit) is
 * folded in three-way rather than overwritten, as readme.ts writeReadme
 * does. A file with problems is still written — its broken definitions are
 * simply ignored where it is read.
 */
export async function writeCustomAttributes(
  dataDir: string,
  content: string,
  expected?: string,
): Promise<string> {
  const path = join(dataDir, CUSTOM_ATTRIBUTES_FILE);
  if (expected !== undefined) {
    const onDisk = await readTextFile(path);
    if (onDisk !== null && onDisk !== expected) content = mergeText(expected, content, onDisk);
  }
  if (new TextEncoder().encode(content).length > CUSTOM_ATTRIBUTES_MAX_BYTES) {
    throw new Error(`${CUSTOM_ATTRIBUTES_FILE} may hold at most 64 KB`);
  }
  await writeTextFile(path, content);
  return content;
}
