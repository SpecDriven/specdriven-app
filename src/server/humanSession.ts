// The human session record on disk (humanSessionRules.ts has the rules):
// <settings dir>/sessions/<id>/session.json, the same folder as the AI
// session records (agent.ts SessionRecord), told apart by `kind: "human"` —
// an AI record has `agent` and no `kind`. Beside the settings file, never in
// the data repo, which is pushed to git.
//
// The parser is tolerant the way parseWindowState is: unknown keys are
// ignored, a bad settings field falls back to its default, and `totals` is
// recomputed rather than trusted. What the writer produces, on the other
// hand, matches humanSession.schema.json exactly (tests hold the two together).

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_TITLE_MAX } from "./agent";
import { readTextFile, writeTextFile } from "./fsx";
import {
  DEFAULT_POMODORO,
  HUMAN_SESSION_KIND,
  HUMAN_SESSION_SCHEMA_VERSION,
  INTERVAL_KINDS,
  INTERVAL_OUTCOMES,
  POMODORO_EVERY_MAX,
  POMODORO_MINUTES_MAX,
  computeTotals,
} from "./humanSessionRules";
import type {
  HumanSession,
  IntervalKind,
  IntervalOutcome,
  PageRef,
  PomodoroInterval,
  PomodoroSettings,
  SpecRef,
} from "./humanSessionRules";
import { pageFolderNamed } from "./pages";

export * from "./humanSessionRules";

export const HUMAN_SESSION_FILE = "session.json";

/** The record's keys in the order they are written — the schema lists the same. */
export const HUMAN_SESSION_KEYS = [
  "schemaVersion",
  "kind",
  "id",
  "name",
  "user",
  "startedAt",
  "endedAt",
  "updatedAt",
  "dataRepo",
  "codeRepo",
  "specs",
  "pages",
  "pomodoro",
  "intervals",
  "totals",
  "notes",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole number in [1, max], or null. */
function positiveInt(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= max ? value : null;
}

/** Settings with every bad field replaced by its default — never the whole record lost. */
export function normalizePomodoro(value: unknown): PomodoroSettings {
  const raw = isRecord(value) ? value : {};
  return {
    workMinutes: positiveInt(raw.workMinutes, POMODORO_MINUTES_MAX) ?? DEFAULT_POMODORO.workMinutes,
    shortBreakMinutes:
      positiveInt(raw.shortBreakMinutes, POMODORO_MINUTES_MAX) ?? DEFAULT_POMODORO.shortBreakMinutes,
    longBreakMinutes:
      positiveInt(raw.longBreakMinutes, POMODORO_MINUTES_MAX) ?? DEFAULT_POMODORO.longBreakMinutes,
    longBreakEvery: positiveInt(raw.longBreakEvery, POMODORO_EVERY_MAX) ?? DEFAULT_POMODORO.longBreakEvery,
  };
}

export function normalizeIntervalKind(value: unknown): IntervalKind | null {
  return INTERVAL_KINDS.includes(value as IntervalKind) ? (value as IntervalKind) : null;
}

export function normalizeIntervalOutcome(value: unknown): IntervalOutcome | null {
  return INTERVAL_OUTCOMES.includes(value as IntervalOutcome) ? (value as IntervalOutcome) : null;
}

/**
 * One interval, or null when it has no kind or start. The outcome goes with
 * the end: a stray outcome on an open interval is dropped, and a closed
 * interval without one counts as abandoned.
 */
export function normalizeInterval(value: unknown): PomodoroInterval | null {
  if (!isRecord(value)) return null;
  const kind = normalizeIntervalKind(value.kind);
  if (!kind || !isDate(value.startedAt)) return null;
  const interval: PomodoroInterval = { kind, startedAt: value.startedAt };
  if (isDate(value.endedAt)) {
    interval.endedAt = value.endedAt;
    interval.outcome = normalizeIntervalOutcome(value.outcome) ?? "abandoned";
  }
  return interval;
}

function normalizeSpecs(value: unknown): SpecRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && nonEmpty(entry.fileName)
      ? [{ fileName: entry.fileName, partial: entry.partial === true }]
      : [],
  );
}

function normalizePages(value: unknown): PageRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.folder === "string" &&
    pageFolderNamed(entry.folder) &&
    nonEmpty(entry.file)
      ? [{ folder: entry.folder, file: entry.file }]
      : [],
  );
}

/** Parsed JSON -> HumanSession; null for anything that is not one of ours. */
export function parseHumanSession(raw: unknown): HumanSession | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== HUMAN_SESSION_KIND) return null;
  if (raw.schemaVersion !== HUMAN_SESSION_SCHEMA_VERSION) return null;
  if (typeof raw.id !== "string" || !UUID_RE.test(raw.id)) return null;
  if (!nonEmpty(raw.name) || raw.name.length > SESSION_TITLE_MAX) return null;
  if (!isDate(raw.startedAt)) return null;
  const intervals = Array.isArray(raw.intervals)
    ? raw.intervals.flatMap((entry) => normalizeInterval(entry) ?? [])
    : [];
  return orderedRecord({
    schemaVersion: HUMAN_SESSION_SCHEMA_VERSION,
    kind: HUMAN_SESSION_KIND,
    id: raw.id,
    name: raw.name,
    ...(nonEmpty(raw.user) ? { user: raw.user } : {}),
    startedAt: raw.startedAt,
    ...(isDate(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    updatedAt: isDate(raw.updatedAt) ? raw.updatedAt : raw.startedAt,
    ...(nonEmpty(raw.dataRepo) ? { dataRepo: raw.dataRepo } : {}),
    ...(nonEmpty(raw.codeRepo) ? { codeRepo: raw.codeRepo } : {}),
    specs: normalizeSpecs(raw.specs),
    pages: normalizePages(raw.pages),
    pomodoro: normalizePomodoro(raw.pomodoro),
    intervals,
    totals: computeTotals(intervals),
    ...(nonEmpty(raw.notes) ? { notes: raw.notes } : {}),
  });
}

export interface NewHumanSessionInit {
  name: string;
  user?: string;
  dataRepo?: string;
  codeRepo?: string;
  specs?: SpecRef[];
  pages?: PageRef[];
  pomodoro?: Partial<PomodoroSettings>;
  /** Default: a fresh uuid. */
  id?: string;
  /** Default: now. */
  now?: Date;
}

/** A fresh, open session with no intervals yet. */
export function newHumanSession(init: NewHumanSessionInit): HumanSession {
  const now = (init.now ?? new Date()).toISOString();
  return orderedRecord({
    schemaVersion: HUMAN_SESSION_SCHEMA_VERSION,
    kind: HUMAN_SESSION_KIND,
    id: init.id ?? randomUUID(),
    name: init.name,
    ...(init.user ? { user: init.user } : {}),
    startedAt: now,
    updatedAt: now,
    ...(init.dataRepo ? { dataRepo: init.dataRepo } : {}),
    ...(init.codeRepo ? { codeRepo: init.codeRepo } : {}),
    specs: init.specs ?? [],
    pages: init.pages ?? [],
    pomodoro: normalizePomodoro({ ...DEFAULT_POMODORO, ...init.pomodoro }),
    intervals: [],
    totals: computeTotals([]),
  });
}

/** The record with its keys in HUMAN_SESSION_KEYS order and no undefined values. */
function orderedRecord(record: HumanSession): HumanSession {
  const ordered: Record<string, unknown> = {};
  for (const key of HUMAN_SESSION_KEYS) {
    const value = (record as unknown as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return ordered as unknown as HumanSession;
}

/** The file's text: keys in order, totals recomputed, pretty-printed. */
export function serializeHumanSession(record: HumanSession): string {
  const ordered = orderedRecord({ ...record, totals: computeTotals(record.intervals) });
  return JSON.stringify(ordered, null, 2) + "\n";
}

export function humanSessionPath(sessionsDir: string, id: string): string {
  return join(sessionsDir, id, HUMAN_SESSION_FILE);
}

/** Write the record with `updatedAt` set to now; returns what went to disk. */
export async function writeHumanSession(
  sessionsDir: string,
  record: HumanSession,
  now: Date = new Date(),
): Promise<HumanSession> {
  const written = orderedRecord({
    ...record,
    updatedAt: now.toISOString(),
    totals: computeTotals(record.intervals),
  });
  await writeTextFile(humanSessionPath(sessionsDir, record.id), serializeHumanSession(written));
  return written;
}

/**
 * The record under <sessionsDir>/<id>, or null when there is none, it is not
 * a human session, it is unreadable, or its id is not the folder's (a copied
 * folder must not surface twice).
 */
export async function readHumanSession(sessionsDir: string, id: string): Promise<HumanSession | null> {
  const text = await readTextFile(humanSessionPath(sessionsDir, id));
  if (text === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const record = parseHumanSession(data);
  return record && record.id === id ? record : null;
}

/** Every human session in the folder, newest first; AI records and junk are skipped. */
export async function listHumanSessions(sessionsDir: string): Promise<HumanSession[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const records = await Promise.all(entries.map((id) => readHumanSession(sessionsDir, id)));
  return records
    .filter((r): r is HumanSession => r !== null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** The newest session still open, or null. */
export async function activeHumanSession(sessionsDir: string): Promise<HumanSession | null> {
  const sessions = await listHumanSessions(sessionsDir);
  return sessions.find((s) => s.endedAt === undefined) ?? null;
}
