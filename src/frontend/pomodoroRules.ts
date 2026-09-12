// The Pomodoro rules (specs/app/pomodoro.feature.md): the pure half of the
// timer — types, the technique's rules, and the transitions — with no state,
// no clock of its own and no I/O, so the store (pomodoro.ts) and its tests can
// use it directly.
//
// The timer is about the person at the keyboard, not about a session: one
// runs at a time however many AI or human sessions are going, and it lives in
// memory for as long as the app is open.
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

/** The Pomodoro settings in force for one timer, snapshotted when it starts. */
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

/** The timer's time so far, a projection of `intervals`. */
export interface PomodoroTotals {
  workMs: number;
  breakMs: number;
  completedPomodoros: number;
}

/**
 * The running timer. It is switched on once and then runs through intervals
 * until it is stopped; `settings` is snapshotted at start, so changing the
 * preferences mid-run only affects the intervals that come after.
 */
export interface PomodoroTimer {
  /** When the timer was switched on, epoch ms. */
  startedAt: number;
  settings: PomodoroSettings;
  intervals: PomodoroInterval[];
}

/** A transition the timer refuses. */
export class PomodoroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PomodoroError";
  }
}

/** How long an interval of this kind is meant to run, from the timer's settings. */
export function plannedMs(kind: IntervalKind, settings: PomodoroSettings): number {
  const minutes =
    kind === "work"
      ? settings.workMinutes
      : kind === "shortBreak"
        ? settings.shortBreakMinutes
        : settings.longBreakMinutes;
  return minutes * 60_000;
}

/** When an interval is meant to end, in epoch ms. */
export function plannedEnd(interval: PomodoroInterval, settings: PomodoroSettings): number {
  return Date.parse(interval.startedAt) + plannedMs(interval.kind, settings);
}

/** The running interval, or null when the timer is between intervals. */
export function openInterval(timer: PomodoroTimer): PomodoroInterval | null {
  const last = timer.intervals[timer.intervals.length - 1];
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
export function nextIntervalKind(timer: PomodoroTimer): IntervalKind {
  const last = timer.intervals[timer.intervals.length - 1];
  if (!last || last.kind !== "work" || last.outcome !== "completed") return "work";
  const done = completedSinceLongBreak(timer.intervals);
  const every = Math.max(1, timer.settings.longBreakEvery);
  return done > 0 && done % every === 0 ? "longBreak" : "shortBreak";
}

/** The cycle dots: completed pomodoros in the current cycle out of the cycle's length. */
export function cycleDots(timer: PomodoroTimer): { filled: number; total: number } {
  const total = Math.max(1, timer.settings.longBreakEvery);
  return { filled: Math.min(completedSinceLongBreak(timer.intervals), total), total };
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
export function computeTotals(intervals: readonly PomodoroInterval[], now?: Date): PomodoroTotals {
  const totals: PomodoroTotals = { workMs: 0, breakMs: 0, completedPomodoros: 0 };
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

// Transitions: each returns a new timer, or throws a PomodoroError.

/** Begin an interval; none may be running. */
export function appendInterval(timer: PomodoroTimer, kind: IntervalKind, now: Date): PomodoroTimer {
  if (openInterval(timer)) throw new PomodoroError("An interval is already running");
  return { ...timer, intervals: [...timer.intervals, { kind, startedAt: now.toISOString() }] };
}

/**
 * End the running interval. `endedAt` defaults to now; the store passes the
 * planned end when the timer ran out, so a late tick does not stretch the
 * pomodoro.
 */
export function closeInterval(
  timer: PomodoroTimer,
  outcome: IntervalOutcome,
  now: Date,
  endedAt?: string,
): PomodoroTimer {
  const open = openInterval(timer);
  if (!open) throw new PomodoroError("No interval is running");
  const end = endedAt ?? now.toISOString();
  const endMs = Date.parse(end);
  if (Number.isNaN(endMs)) throw new PomodoroError("endedAt is not a date");
  if (endMs < Date.parse(open.startedAt)) {
    throw new PomodoroError("endedAt is before the interval started");
  }
  if (endMs > now.getTime() + 5_000) throw new PomodoroError("endedAt is in the future");
  return { ...timer, intervals: [...timer.intervals.slice(0, -1), { ...open, endedAt: end, outcome }] };
}
