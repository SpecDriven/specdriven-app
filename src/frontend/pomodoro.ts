// The Pomodoro timer on the client (specs/app/pomodoro.feature.md): a small
// store, like agentChat.ts, over the timer the person at this keyboard is
// running. It is a feature of the app, not of a session — one timer runs
// however many AI or human sessions are going, and starting it needs no name
// and no dialog.
//
// The clock is never a counter: what remains is the running interval's
// planned end minus the time now, so a laptop asleep for ten minutes lands on
// the right number. The timer lives in memory for as long as the app is open;
// a reload starts from nothing.
//
// Device-local preferences (durations, sound, tick) live in localStorage, a
// habit of the person at this keyboard, and are snapshotted into the timer
// when it starts — changing them mid-run only affects later intervals.

import { useSyncExternalStore } from "react";
import {
  DEFAULT_POMODORO,
  INTERVAL_LABEL,
  POMODORO_EVERY_MAX,
  POMODORO_MINUTES_MAX,
  appendInterval,
  closeInterval,
  computeTotals,
  nextIntervalKind,
  openInterval,
  plannedEnd,
  plannedMs,
} from "./pomodoroRules";
import type { IntervalKind, PomodoroSettings, PomodoroTimer } from "./pomodoroRules";
import { normalizeSoundName, sounds as realSounds } from "./sounds";
import type { SoundName, SoundPlayer } from "./sounds";
import { toast } from "./Toasts";

export { INTERVAL_LABEL };

// --- Preferences (device-local) --------------------------------------------

export interface PomodoroPrefs extends PomodoroSettings {
  sound: SoundName;
  /** A soft tick every second during focus. */
  tick: boolean;
  /** Begin the next interval without being asked — no UI for it yet. */
  autoStart: boolean;
}

export const DEFAULT_PREFS: PomodoroPrefs = {
  ...DEFAULT_POMODORO,
  sound: "bell",
  tick: false,
  autoStart: false,
};

export const PREFS_KEY = "sd-pomodoro-prefs";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or no storage: the next start uses the defaults.
  }
}

/** A whole number of minutes in [1, max]; the fallback for anything else. */
export function clampMinutes(value: unknown, fallback: number, max = POMODORO_MINUTES_MAX): number {
  const n = typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/** Preferences off a parsed object: each field falls back on its own. */
export function normalizePrefs(value: unknown): PomodoroPrefs {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    workMinutes: clampMinutes(raw.workMinutes, DEFAULT_PREFS.workMinutes),
    shortBreakMinutes: clampMinutes(raw.shortBreakMinutes, DEFAULT_PREFS.shortBreakMinutes),
    longBreakMinutes: clampMinutes(raw.longBreakMinutes, DEFAULT_PREFS.longBreakMinutes),
    longBreakEvery: clampMinutes(raw.longBreakEvery, DEFAULT_PREFS.longBreakEvery, POMODORO_EVERY_MAX),
    sound: normalizeSoundName(raw.sound) ?? DEFAULT_PREFS.sound,
    tick: raw.tick === true,
    autoStart: raw.autoStart === true,
  };
}

export function readPrefs(): PomodoroPrefs {
  const text = readLocal(PREFS_KEY);
  if (!text) return { ...DEFAULT_PREFS };
  try {
    return normalizePrefs(JSON.parse(text));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs: PomodoroPrefs): void {
  writeLocal(PREFS_KEY, JSON.stringify(prefs));
}

/** The settings part of the preferences — what the running timer keeps. */
export function settingsOf(prefs: PomodoroPrefs): PomodoroSettings {
  const { workMinutes, shortBreakMinutes, longBreakMinutes, longBreakEvery } = prefs;
  return { workMinutes, shortBreakMinutes, longBreakMinutes, longBreakEvery };
}

// --- The store -------------------------------------------------------------

export interface PomodoroStore {
  /** The running timer, or null when none is on. */
  timer: PomodoroTimer | null;
  /** The last tick, epoch ms — every clock reading derives from it. */
  now: number;
  prefs: PomodoroPrefs;
  /** The bar flashes until this time, after an interval ends. */
  flashUntil: number;
  error: string | null;
}

function initialState(): PomodoroStore {
  return { timer: null, now: 0, prefs: { ...DEFAULT_PREFS }, flashUntil: 0, error: null };
}

let state: PomodoroStore = initialState();
const listeners = new Set<() => void>();

function set(patch: Partial<PomodoroStore>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function usePomodoro(): PomodoroStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** For tests and the odd imperative read. */
export function pomodoroState(): PomodoroStore {
  return state;
}

// Injection seams (the setDesktopRunner pattern): tests swap the clock, the
// sounds and the ticker; null restores the defaults.
interface Deps {
  now: () => number;
  sounds: SoundPlayer;
  /** Run fn once a second until the returned function is called. */
  schedule: (fn: () => void) => () => void;
  /** Tell the user an interval is over, with the button that starts the next. */
  notify: (message: string, action: { label: string; run: () => void }) => void;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  sounds: realSounds,
  schedule: (fn) => {
    const timer = setInterval(fn, 1000);
    return () => clearInterval(timer);
  },
  notify: (message, action) => void toast.info(message, { action }),
};
let deps: Deps = defaultDeps;

export function setPomodoroDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
  unschedule();
  state = initialState();
}

let cancelTicks: (() => void) | null = null;

function schedule(): void {
  if (!cancelTicks) cancelTicks = deps.schedule(() => pomodoro.tick());
}

function unschedule(): void {
  cancelTicks?.();
  cancelTicks = null;
}

// --- Derived readings (pure) -----------------------------------------------

export type Phase = "idle" | "running" | "between";

/** idle: no timer; running: an interval is on; between: waiting for the next. */
export function phaseOf(timer: PomodoroTimer | null): Phase {
  if (!timer) return "idle";
  return openInterval(timer) ? "running" : "between";
}

/** Time left in the running interval, never below zero; zero when none runs. */
export function remainingMs(timer: PomodoroTimer | null, now: number): number {
  const open = timer ? openInterval(timer) : null;
  if (!timer || !open) return 0;
  return Math.max(0, plannedEnd(open, timer.settings) - now);
}

/** How far the running interval has come, 0..1. */
export function progressOf(timer: PomodoroTimer | null, now: number): number {
  const open = timer ? openInterval(timer) : null;
  if (!timer || !open) return 0;
  const total = plannedMs(open.kind, timer.settings);
  return total > 0 ? Math.min(1, Math.max(0, 1 - remainingMs(timer, now) / total)) : 1;
}

/** mm:ss, rounded up so a fresh pomodoro reads 25:00 and the last second 00:01. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** "50m" or "1h 05m" — the focus so far, for the bar. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "24:59 · Focus" while an interval runs, for the window title; else null. */
export function titlePrefix(timer: PomodoroTimer | null, now: number): string | null {
  const open = timer ? openInterval(timer) : null;
  if (!open) return null;
  return `${formatClock(remainingMs(timer, now))} · ${INTERVAL_LABEL[open.kind]}`;
}

/** Focus time so far, the running pomodoro included. */
export function totalWorkMs(timer: PomodoroTimer | null, now: number): number {
  return timer ? computeTotals(timer.intervals, new Date(now)).workMs : 0;
}

/** The button that begins the next interval. */
export function startLabel(kind: IntervalKind): string {
  return kind === "work" ? "Start pomodoro" : kind === "shortBreak" ? "Start break" : "Start long break";
}

// --- Actions ---------------------------------------------------------------

/** Close the running interval as completed at its planned end, and say so. */
function complete(timer: PomodoroTimer, endMs: number): void {
  const ended = closeInterval(timer, "completed", new Date(deps.now()), new Date(endMs).toISOString());
  unschedule();
  set({ timer: ended, flashUntil: deps.now() + 2_000 });
  deps.sounds.play(state.prefs.sound);
  const kind = nextIntervalKind(ended);
  const last = timer.intervals[timer.intervals.length - 1]!;
  deps.notify(`${INTERVAL_LABEL[last.kind]} over`, {
    label: startLabel(kind),
    run: () => pomodoro.startInterval(kind),
  });
  if (state.prefs.autoStart) pomodoro.startInterval(kind);
}

/** End the running interval — a voided pomodoro or a skipped break. */
function abandonOpen(want: "work" | "break"): void {
  const timer = state.timer;
  const open = timer ? openInterval(timer) : null;
  if (!timer || !open) return;
  if ((open.kind === "work") !== (want === "work")) return;
  try {
    set({ timer: closeInterval(timer, "abandoned", new Date(deps.now())), flashUntil: 0, error: null });
    unschedule();
  } catch (e) {
    set({ error: (e as Error).message });
  }
}

export const pomodoro = {
  /**
   * Switch the timer on and begin its first pomodoro. No name, no dialog —
   * call it straight from the click, which is also what unlocks audio.
   * Starting while one already runs changes nothing.
   */
  start(prefs: PomodoroPrefs = readPrefs()): void {
    deps.sounds.unlock();
    if (state.timer) return;
    writePrefs(prefs);
    const now = deps.now();
    set({
      prefs,
      timer: { startedAt: now, settings: settingsOf(prefs), intervals: [] },
      now,
      flashUntil: 0,
      error: null,
    });
    pomodoro.startInterval("work");
  },

  /** Begin the next interval — by default the one the rules say comes next. */
  startInterval(kind?: IntervalKind): void {
    const timer = state.timer;
    if (!timer) return;
    deps.sounds.unlock();
    try {
      const next = appendInterval(timer, kind ?? nextIntervalKind(timer), new Date(deps.now()));
      set({ timer: next, now: deps.now(), flashUntil: 0, error: null });
      schedule();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  /** Void the running pomodoro (an interruption): it does not count. */
  abandon(): void {
    abandonOpen("work");
  },

  /** Cut the running break short. */
  skipBreak(): void {
    abandonOpen("break");
  },

  /** Switch the timer off; a running interval simply goes with it. */
  stop(): void {
    unschedule();
    set({ timer: null, flashUntil: 0, error: null });
  },

  /** Keep the preferences for the next timer; a running one is untouched. */
  savePrefs(prefs: PomodoroPrefs): void {
    writePrefs(prefs);
    set({ prefs });
  },

  /** The once-a-second reading: the clock, the tick, and the end when it comes. */
  tick(now: number = deps.now()): void {
    set({ now });
    const timer = state.timer;
    const open = timer ? openInterval(timer) : null;
    if (!timer || !open) return;
    if (now >= plannedEnd(open, timer.settings)) {
      // Detach the tick so a second one does not close the same interval twice.
      unschedule();
      try {
        complete(timer, plannedEnd(open, timer.settings));
      } catch (e) {
        set({ error: (e as Error).message });
      }
      return;
    }
    if (state.prefs.tick && open.kind === "work") deps.sounds.tick();
  },

  /** On boot: take the stored preferences. There is no timer to pick up. */
  load(): void {
    set({ prefs: readPrefs(), now: deps.now() });
  },
};
