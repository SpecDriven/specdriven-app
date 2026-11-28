// A specification folder's own drafting prompt
// (specs/app/extract-specs-from-code.feature.md "An edited prompt drafts the
// specs and is saved in the specification folder"): the writing
// instructions a user changed in the wizard, kept in
//
//   .specdriven/extract-prompt.md
//
// in the folder, where the app's sync commits and pushes it like the rest of
// `.specdriven` — so everyone who drafts specs into the folder is shown, and
// drafts with, the same text. A folder with no such file drafts with the
// built-in instructions; setting the text back to them removes the file, so
// the folder follows the built-in text as it improves.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";
import { isDefaultInstructions, MAX_INSTRUCTIONS_CHARS, tidyInstructions } from "./intentDraftPrompt";

/** The file, relative to the specification folder. */
export const EXTRACT_PROMPT_FILE = ".specdriven/extract-prompt.md";

/**
 * The folder's own writing instructions, or null when it has none: no
 * file, an empty one, or one that says what the built-in text says. A file
 * written by hand past the limit is cut at it.
 */
export async function readSavedInstructions(dataDir: string): Promise<string | null> {
  const text = await readTextFile(join(dataDir, EXTRACT_PROMPT_FILE)).catch(() => null);
  if (text === null) return null;
  const tidy = tidyInstructions(text).slice(0, MAX_INSTRUCTIONS_CHARS).trim();
  return isDefaultInstructions(tidy) ? null : tidy;
}

/** Keep the folder's writing instructions; the built-in text, or nothing, removes the file instead. */
export async function writeSavedInstructions(dataDir: string, text: string): Promise<void> {
  const path = join(dataDir, EXTRACT_PROMPT_FILE);
  if (isDefaultInstructions(text)) await rm(path, { force: true });
  else await writeTextFile(path, `${tidyInstructions(text)}\n`);
}

/**
 * The instructions saved in a folder the wizard names before anything is
 * made: a folder on this computer, by its absolute path. A GitHub url — not
 * cloned yet — a relative path, or a folder that is not there has none to
 * show.
 */
export async function savedInstructionsAt(input: unknown): Promise<string | null> {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) return null;
  const expanded = typed === "~" || typed.startsWith("~/") ? homedir() + typed.slice(1) : typed;
  if (!isAbsolute(expanded)) return null;
  return readSavedInstructions(resolve(expanded));
}
