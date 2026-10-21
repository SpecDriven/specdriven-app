// The data repo's AGENTS.md (specs/agents/agents-md.feature.md): the file an
// AI agent working in the folder reads first, telling it how `.feature.md`
// files are structured and what grammar the parser (parser.ts) holds them
// to. The sync tick installs the app's template into a folder that has none,
// right after it writes the data format marker (reload.ts), and the tick's
// commit carries it. A folder that has one, under any spelling of the name,
// is left alone: the template is a starting point the team edits, and an
// install that overwrote it would throw those edits away every minute.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";
import template from "./AGENTS.template.md" with { type: "text" };

export const AGENTS_FILE = "AGENTS.md";

/** The template the app installs, as shipped. */
export const AGENTS_TEMPLATE: string = template;

/**
 * The name the folder's AGENTS.md goes by — `AGENTS.md`, or the folder's own
 * spelling (`agents.md`, `Agents.md`) when it has one — or null when the
 * folder has none. A second file beside an existing one would be read by
 * some agents and not others, and collide on a case-insensitive disk.
 */
export async function agentsFileName(dataDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return null;
  }
  if (entries.includes(AGENTS_FILE)) return AGENTS_FILE;
  const lower = AGENTS_FILE.toLowerCase();
  return entries.find((e) => e.toLowerCase() === lower) ?? null;
}

/** The folder's AGENTS.md, or null when it has none. */
export async function readAgentsFile(dataDir: string): Promise<string | null> {
  const name = await agentsFileName(dataDir);
  return name === null ? null : readTextFile(join(dataDir, name));
}

/**
 * Write the template into a folder that has no AGENTS.md. Returns whether
 * it wrote; an existing file, whatever it says, is never touched.
 */
export async function installAgentsFile(dataDir: string): Promise<boolean> {
  if ((await agentsFileName(dataDir)) !== null) return false;
  await writeTextFile(join(dataDir, AGENTS_FILE), AGENTS_TEMPLATE);
  return true;
}
