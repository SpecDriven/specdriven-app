// The data repo's format marker (specs/app/data-format.feature.md): which
// layout the data in a folder is written in, so an older app that cannot read
// it stops instead of corrupting it. The sync tick runs migrations, drift
// import and `git add -A` + push every minute; an app that half-understands
// newer data would rewrite it and push the damage to the whole team.
//
// The marker is `.specdriven/data-format.json`, written once the format
// goes past 1 (a folder with none is in format 1):
//
//   { "format": 1, "minAppVersion": "0.1.151" }
//
// `format` is a number bumped by hand — not the app version — so teammates on
// different releases keep working together until a real format break.
// `minAppVersion` is what the blocking screen tells the user to install: the
// version of the app that raised the format.
//
// WHEN TO BUMP DATA_FORMAT: whenever a release ≥ the last one to raise it
// would misread or rewrite the data wrongly — any *_SCHEMA_VERSION bump in
// automerge/schema.ts, a new layout migration in migrate.ts, a new required
// grammar in parser.ts, an Automerge major upgrade. tests/dataFormat.test.ts
// pins the schema versions to the format so a schema bump cannot slip by.

import { join } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";
import { getLogger } from "./telemetry";
import { version as appVersion } from "../../package.json";

const log = getLogger("data-format");

/** The data format this app reads and writes. */
export const DATA_FORMAT = 1;

/**
 * Set on every API answer while the open folder is blocked, to the app
 * version it asks for (or empty): the client watches for it in one place.
 */
export const DATA_TOO_NEW_HEADER = "X-SpecDriven-Data-Too-New";

/** The marker's path, relative to the data repo. */
export const DATA_FORMAT_FILE = ".specdriven/data-format.json";

export interface DataFormatMarker {
  format: number;
  minAppVersion: string | null;
}

/** Why this app must not touch a data folder. */
export interface Incompatibility {
  /** The app version the data asks for, when it says. */
  minAppVersion: string | null;
  /** This app's version. */
  appVersion: string;
  /** One line for the log and the API. */
  reason: string;
  /** What found it: the marker, or a document newer than this app. */
  source: "marker" | "document";
}

/** Thrown where data newer than this app would otherwise be used. */
export class DataTooNewError extends Error {
  constructor(readonly incompatibility: Incompatibility) {
    super(incompatibility.reason);
    this.name = "DataTooNewError";
  }
}

/**
 * The marker, or null when the folder has none. A marker git left conflict
 * markers in still says which formats it was raised to: the highest wins.
 */
export async function readDataFormat(dir: string): Promise<DataFormatMarker | null> {
  const text = await readTextFile(join(dir, DATA_FORMAT_FILE));
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.format === "number" && Number.isInteger(raw.format)) {
      return {
        format: raw.format,
        minAppVersion: typeof raw.minAppVersion === "string" ? raw.minAppVersion : null,
      };
    }
  } catch {
    // Not JSON — fall through to the lenient read.
  }
  const formats = [...text.matchAll(/"format"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (formats.length === 0) {
    log.warn(`ignoring an unreadable ${DATA_FORMAT_FILE}`);
    return null;
  }
  const versions = [...text.matchAll(/"minAppVersion"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return { format: Math.max(...formats), minAppVersion: versions.at(-1) ?? null };
}

// Incompatible data folders, by directory. The sync tick and the store set
// entries; the API guard and /api/state read them.
const flagged = new Map<string, Incompatibility>();

/** Why `dir` must not be written to, or null when it may. */
export function incompatibility(dir: string): Incompatibility | null {
  return flagged.get(dir) ?? null;
}

/** Whether any folder is flagged — the API guard's cheap fast path. */
export function anyIncompatible(): boolean {
  return flagged.size > 0;
}

export function markIncompatible(dir: string, found: Incompatibility): void {
  if (!flagged.has(dir)) log.warn(`${dir}: ${found.reason}`);
  flagged.set(dir, found);
}

/** Forget every flag — tests only. */
export function resetDataFormatFlags(): void {
  flagged.clear();
}

/**
 * Read the marker and flag the folder when it is newer than this app, or
 * clear a flag the marker set before (the folder was rolled back). A flag a
 * document set stays: the marker saying nothing does not make that document
 * readable.
 */
export async function checkDataFormat(dir: string): Promise<Incompatibility | null> {
  const marker = await readDataFormat(dir);
  if (marker && marker.format > DATA_FORMAT) {
    const found: Incompatibility = {
      minAppVersion: marker.minAppVersion,
      appVersion,
      reason:
        `this folder is in data format ${marker.format}, newer than this app's ${DATA_FORMAT}: ` +
        `install SpecDriven ${marker.minAppVersion ?? "the latest version"} or newer`,
      source: "marker",
    };
    markIncompatible(dir, found);
    return found;
  }
  if (flagged.get(dir)?.source === "marker") flagged.delete(dir);
  return flagged.get(dir) ?? null;
}

/**
 * Flag the folder for a document whose schema is newer than this app reads,
 * and return the error to throw.
 */
export function documentTooNew(
  dir: string,
  what: string,
  schemaVersion: number,
  known: number,
): DataTooNewError {
  const found: Incompatibility = {
    minAppVersion: flagged.get(dir)?.minAppVersion ?? null,
    appVersion,
    reason: `${what} is in schema version ${schemaVersion}, newer than this app's ${known}: install the latest SpecDriven`,
    source: "document",
  };
  markIncompatible(dir, found);
  return new DataTooNewError(found);
}

/**
 * Write the marker when the folder's is older than `format` (this app's), so
 * an older app that knows about markers stops at this format. A folder with
 * none is in format 1 already, so nothing is written until the format goes
 * past it: no repo gets a commit that says what a missing file says.
 * Returns whether it wrote; the tick's commit carries the file.
 */
export async function stampDataFormat(dir: string, format: number = DATA_FORMAT): Promise<boolean> {
  const marker = await readDataFormat(dir);
  if ((marker?.format ?? 1) >= format) return false;
  const next = { format, minAppVersion: appVersion };
  await writeTextFile(join(dir, DATA_FORMAT_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
