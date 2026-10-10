// The list of files stored with a scenario (specs/editor/store-associated-
// files.feature.md): what a stored name and a listed name may be, and how a
// size reads. Pure — shared by the server routes and the editor's field;
// the bytes themselves are src/server/scenarioFiles.ts's.

import type { ScenarioFile } from "./parser";
import { cleanLine } from "./text";

/** Longest name a file is listed under. */
const MAX_NAME = 200;

/** Only names storeScenarioFile itself generates: `<slug>-<hash>[.<ext>]`. */
const SAFE_STORED = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{16}(\.[a-z0-9]{1,10})?$/;

export function isStoredFileName(name: string): boolean {
  return SAFE_STORED.test(name);
}

/**
 * The name a file is listed under, from what the browser or a rename sent:
 * the base name only (no folders), on one line, trimmed — or null when
 * nothing usable is left.
 */
export function fileDisplayName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const name = cleanLine(base).slice(0, MAX_NAME).trim();
  return name === "" || name === "." || name === ".." ? null : name;
}

/**
 * The route's `files`, validated into shape — each a usable name over a
 * stored file name and a size — or null when malformed. Names are unique
 * within a scenario; the first of two alike wins.
 */
export function validScenarioFiles(input: unknown): ScenarioFile[] | null {
  if (!Array.isArray(input)) return null;
  const out: ScenarioFile[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const { name, file, size } = (entry ?? {}) as { name?: unknown; file?: unknown; size?: unknown };
    if (typeof name !== "string" || typeof file !== "string" || !isStoredFileName(file)) return null;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return null;
    const display = fileDisplayName(name);
    if (display === null) return null;
    if (seen.has(display)) continue;
    seen.add(display);
    out.push({ name: display, file, size });
  }
  return out;
}

/** A size the way the file list shows it: "512 B", "3.4 KB", "12 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}
