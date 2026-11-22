// The data repo's format marker (specs/app/data-format.feature.md): which
// layout the data in a folder is written in, so an older app that cannot read
// it stops instead of corrupting it. The sync tick runs migrations, drift
// import and `git add -A` + push every minute; an app that half-understands
// newer data would rewrite it and push the damage to the whole team.
//
// The marker is `.specdriven/data-format.yaml`, written once the format
// goes past 1 (a folder with none is in format 1):
//
//   format: 4
//   minAppVersion: "0.1.296"
//
// Releases before format 4 read `.specdriven/data-format.json` instead, and
// cannot see the YAML file. So the JSON file stays beside it as a tripwire,
// written with the same content whenever the marker is: those releases stop
// at it rather than take the folder for format 1 and write to it. A folder
// still holding only the JSON file — from before format 4 — is read from it
// until the next tick converts it.
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
import { parse } from "yaml";
import { readTextFile, writeTextFile } from "./fsx";
import { getLogger } from "./telemetry";
import { version as appVersion } from "../../package.json";

const log = getLogger("data-format");

/** The data format this app reads and writes. */
export const DATA_FORMAT = 4;

/**
 * Set on every API answer while the open folder is blocked, to the app
 * version it asks for (or empty): the client watches for it in one place.
 */
export const DATA_TOO_NEW_HEADER = "X-SpecDriven-Data-Too-New";

/** The marker's path, relative to the data repo. */
export const DATA_FORMAT_FILE = ".specdriven/data-format.yaml";

/**
 * The marker releases before format 4 read, relative to the data repo: the
 * marker itself before then, and since then a tripwire that stops them.
 */
export const LEGACY_DATA_FORMAT_FILE = ".specdriven/data-format.json";

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
 * The marker one file holds, or null when there is none. A marker git left
 * conflict markers in still says which formats it was raised to: the highest
 * wins. JSON is YAML too, so the same read takes either file.
 */
async function readMarkerAt(dir: string, file: string): Promise<DataFormatMarker | null> {
  const text = await readTextFile(join(dir, file));
  if (text === null) return null;
  try {
    const raw = parse(text) as Record<string, unknown> | null;
    if (raw && typeof raw.format === "number" && Number.isInteger(raw.format)) {
      return {
        format: raw.format,
        minAppVersion: typeof raw.minAppVersion === "string" ? raw.minAppVersion : null,
      };
    }
  } catch {
    // Does not parse — fall through to the lenient read.
  }
  const formats = [...text.matchAll(/^\s*"?format"?\s*:\s*(\d+)/gm)].map((m) => Number(m[1]));
  if (formats.length === 0) {
    log.warn(`ignoring an unreadable ${file}`);
    return null;
  }
  const versions = [...text.matchAll(/^\s*"?minAppVersion"?\s*:\s*"?([^"\s,]+)"?/gm)].map((m) => m[1]!);
  return { format: Math.max(...formats), minAppVersion: versions.at(-1) ?? null };
}

/**
 * The folder's marker, or null when it has none: the YAML marker, or the
 * JSON one from before format 4 — whichever names the higher format, so a
 * folder no app has converted yet, or one whose JSON tripwire a teammate
 * raised, is read for what it is.
 */
export async function readDataFormat(dir: string): Promise<DataFormatMarker | null> {
  const [yaml, json] = await Promise.all([readMarkerAt(dir, DATA_FORMAT_FILE), readMarkerAt(dir, LEGACY_DATA_FORMAT_FILE)]);
  if (!yaml || !json) return yaml ?? json;
  return json.format > yaml.format ? json : yaml;
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
 * past it: no repo gets a commit that says what a missing file says. The
 * YAML marker is written with the JSON tripwire beside it, for the releases
 * that read only that one; a folder from before format 4 has its JSON marker
 * converted this way. Returns whether it wrote; the tick's commit carries
 * the files.
 */
export async function stampDataFormat(dir: string, format: number = DATA_FORMAT): Promise<boolean> {
  const marker = await readDataFormat(dir);
  if ((marker?.format ?? 1) >= format) return false;
  await writeTextFile(join(dir, DATA_FORMAT_FILE), `format: ${format}\nminAppVersion: "${appVersion}"\n`);
  const tripwire = { format, minAppVersion: appVersion };
  await writeTextFile(join(dir, LEGACY_DATA_FORMAT_FILE), `${JSON.stringify(tripwire, null, 2)}\n`);
  return true;
}
