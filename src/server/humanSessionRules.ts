// The human coding session (roadmap/support-for-human-code-sessions.md): a
// Pomodoro-timed session the user runs themself, recorded locally beside the
// AI session records. This module is the pure half — types, the Pomodoro
// rules, and the record transitions — with no filesystem, so the frontend
// imports it too (the way App.tsx imports ../server/parser). The I/O lives
// in humanSession.ts.
//
// Units: `*Minutes` are the settings a person types in; `*Ms` are measured
// durations. Timestamps are ISO 8601 strings. Optional fields are omitted,
// never null.
//
// Pomodoro rules (Cirillo): a work interval is indivisible — it either runs
// out ("completed") or is voided ("abandoned"); it is never paused. Breaks
// may be skipped (also "abandoned"). After `longBreakEvery` completed work
// intervals since the last long break, the next break is the long one.

export type IntervalKind = "work" | "shortBreak" | "longBreak";
export const INTERVAL_KINDS: readonly IntervalKind[] = ["work", "shortBreak", "longBreak"];

export type IntervalOutcome = "completed" | "abandoned";
export const INTERVAL_OUTCOMES: readonly IntervalOutcome[] = ["completed", "abandoned"];

/** What the bar and the toasts call each kind of interval. */
export const INTERVAL_LABEL: Record<IntervalKind, string> = {
  work: "Focus",
  shortBreak: "Short break",
  longBreak: "Long break",
};

/** The Pomodoro settings in force for one session, snapshotted at start. */
export interface PomodoroSettings {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** Completed pomodoros between long breaks. */
  longBreakEvery: number;
}

export const DEFAULT_POMODORO: PomodoroSettings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
};

/** Bounds a settings value is clamped to — a typo must not make a 9-hour pomodoro. */
export const POMODORO_MINUTES_MAX = 180;
export const POMODORO_EVERY_MAX = 12;

/** One timed interval. Open while `endedAt` is absent; `outcome` comes with `endedAt`. */
export interface PomodoroInterval {
  kind: IntervalKind;
  startedAt: string;
  endedAt?: string;
  outcome?: IntervalOutcome;
}

/** The session's time, a projection of `intervals` recomputed on every write. */
export interface SessionTotals {
  workMs: number;
  breakMs: number;
  completedPomodoros: number;
}

/** A spec the session is about — the AI record's shape (agent.ts SessionRecord). */
export interface SpecRef {
  fileName: string;
  partial: boolean;
}

/** A roadmap page or task the session is about. */
export interface PageRef {
  folder: string;
  file: string;
}

export const HUMAN_SESSION_SCHEMA_VERSION = 1;
export const HUMAN_SESSION_KIND = "human";

/** The local, non-git record of a human session — src/server/humanSession.schema.json. */
export interface HumanSession {
  schemaVersion: typeof HUMAN_SESSION_SCHEMA_VERSION;
  kind: typeof HUMAN_SESSION_KIND;
  id: string;
  name: string;
  user?: string;
  startedAt: string;
  /** Absent while the session is open — crash-only software. */
  endedAt?: string;
  /** The last write; a stale one means the app died mid-session. */
  updatedAt: string;
  /** Absent when no data repo was configured — a Pomodoro needs none. */
  dataRepo?: string;
  codeRepo?: string;
  specs: SpecRef[];
  pages: PageRef[];
  pomodoro: PomodoroSettings;
  intervals: PomodoroInterval[];
  totals: SessionTotals;
  notes?: string;
}

/** A transition the record refuses; `status` is what the API answers with. */
export class HumanSessionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "HumanSessionError";
  }
}

/** How long an interval of this kind is meant to run, from the session's settings. */
export function plannedMs(kind: IntervalKind, pomodoro: PomodoroSettings): number {
  const minutes =
    kind === "work"
      ? pomodoro.workMinutes
      : kind === "shortBreak"
        ? pomodoro.shortBreakMinutes
        : pomodoro.longBreakMinutes;
  return minutes * 60_000;
}

/** When an interval is meant to end, in epoch ms. */
export function plannedEnd(interval: PomodoroInterval, pomodoro: PomodoroSettings): number {
  return Date.parse(interval.startedAt) + plannedMs(interval.kind, pomodoro);
}

/** The running interval, or null when the session is between intervals or ended. */
export function openInterval(record: HumanSession): PomodoroInterval | null {
  const last = record.intervals[record.intervals.length - 1];
  return last && last.endedAt === undefined ? last : null;
}

/** Completed pomodoros since the last long break (any outcome) — the cycle position. */
export function completedSinceLongBreak(intervals: readonly PomodoroInterval[]): number {
  let count = 0;
  for (const interval of intervals) {
    if (interval.kind === "longBreak") count = 0;
    else if (interval.kind === "work" && interval.outcome === "completed") count += 1;
  }
  return count;
}

/**
 * What comes after the last interval: work to begin with and after every
 * break; after a completed pomodoro the short break, or the long one when the
 * cycle is full; after an abandoned pomodoro, the pomodoro again.
 */
export function nextIntervalKind(record: HumanSession): IntervalKind {
  const last = record.intervals[record.intervals.length - 1];
  if (!last || last.kind !== "work" || last.outcome !== "completed") return "work";
  const done = completedSinceLongBreak(record.intervals);
  const every = Math.max(1, record.pomodoro.longBreakEvery);
  return done > 0 && done % every === 0 ? "longBreak" : "shortBreak";
}

/** The cycle dots: completed pomodoros in the current cycle out of the cycle's length. */
export function cycleDots(record: HumanSession): { filled: number; total: number } {
  const total = Math.max(1, record.pomodoro.longBreakEvery);
  return { filled: Math.min(completedSinceLongBreak(record.intervals), total), total };
}

/** The span of one interval, clamped at zero; the open one counts only with `now`. */
function spanMs(interval: PomodoroInterval, now?: Date): number {
  const end = interval.endedAt !== undefined ? Date.parse(interval.endedAt) : now?.getTime();
  if (end === undefined) return 0;
  return Math.max(0, end - Date.parse(interval.startedAt));
}

/**
 * The totals from the intervals. Abandoned time still counts as time spent;
 * only completed work intervals count as pomodoros.
 */
export function computeTotals(intervals: readonly PomodoroInterval[], now?: Date): SessionTotals {
  const totals: SessionTotals = { workMs: 0, breakMs: 0, completedPomodoros: 0 };
  for (const interval of intervals) {
    const span = spanMs(interval, now);
    if (interval.kind === "work") {
      totals.workMs += span;
      if (interval.outcome === "completed") totals.completedPomodoros += 1;
    } else {
      totals.breakMs += span;
    }
  }
  return totals;
}

export type HumanSessionStatus = "open" | "stale" | "ended";

/**
 * Whether the session is going, ended, or open but left behind by an app that
 * died: nothing has been written for longer than the longest interval plus a
 * grace period.
 */
export function humanSessionStatus(
  record: HumanSession,
  now: Date,
  staleAfterMs: number = longestIntervalMs(record.pomodoro) + 5 * 60_000,
): HumanSessionStatus {
  if (record.endedAt !== undefined) return "ended";
  const reference = Math.max(
    Date.parse(record.updatedAt),
    ...record.intervals.map((i) => Date.parse(i.endedAt ?? i.startedAt)),
  );
  return now.getTime() - reference > staleAfterMs ? "stale" : "open";
}

function longestIntervalMs(pomodoro: PomodoroSettings): number {
  return (
    Math.max(pomodoro.workMinutes, pomodoro.shortBreakMinutes, pomodoro.longBreakMinutes) * 60_000
  );
}

// Transitions: each returns a new record with the totals recomputed, or
// throws a HumanSessionError the API turns into its status.

/** Begin an interval; the session must be open with none running. */
export function appendInterval(record: HumanSession, kind: IntervalKind, now: Date): HumanSession {
  if (record.endedAt !== undefined) throw new HumanSessionError("The session has ended", 409);
  if (openInterval(record)) throw new HumanSessionError("An interval is already running", 409);
  const intervals = [...record.intervals, { kind, startedAt: now.toISOString() }];
  return { ...record, intervals, totals: computeTotals(intervals) };
}

/**
 * End the running interval. `endedAt` defaults to now; the client passes the
 * planned end when the timer ran out, so a late tick does not stretch the
 * pomodoro.
 */
export function closeInterval(
  record: HumanSession,
  outcome: IntervalOutcome,
  now: Date,
  endedAt?: string,
): HumanSession {
  const open = openInterval(record);
  if (!open) throw new HumanSessionError("No interval is running", 409);
  const end = endedAt ?? now.toISOString();
  const endMs = Date.parse(end);
  if (Number.isNaN(endMs)) throw new HumanSessionError("endedAt is not a date", 400);
  if (endMs < Date.parse(open.startedAt)) {
    throw new HumanSessionError("endedAt is before the interval started", 400);
  }
  if (endMs > now.getTime() + 5_000) throw new HumanSessionError("endedAt is in the future", 400);
  const intervals = [...record.intervals.slice(0, -1), { ...open, endedAt: end, outcome }];
  return { ...record, intervals, totals: computeTotals(intervals) };
}

/** End the session; a running interval is abandoned. Ending twice changes nothing. */
export function endSession(record: HumanSession, now: Date): HumanSession {
  if (record.endedAt !== undefined) return record;
  const closed = openInterval(record) ? closeInterval(record, "abandoned", now) : record;
  return { ...closed, endedAt: now.toISOString() };
}
