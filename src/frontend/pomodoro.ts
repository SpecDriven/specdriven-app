// The Pomodoro session on the client (roadmap/support-for-human-code-sessions.md):
// a small store, like agentChat.ts, over the human session record the server
// keeps (src/server/humanSession.ts). The clock is never a counter: what
// remains is the running interval's planned end minus the time now, so a
// reload or a laptop asleep for ten minutes lands on the right number, and
// an interval that ran out while the app was closed is closed at its
// planned end, not at wake-up.
//
// Device-local preferences (durations, sound, tick) live in localStorage, a
// habit of the person at this keyboard, and are snapshotted into each
// session's record.

import { useSyncExternalStore } from "react";
import {
  DEFAULT_POMODORO,
  INTERVAL_LABEL,
  POMODORO_EVERY_MAX,
  POMODORO_MINUTES_MAX,
  computeTotals,
  nextIntervalKind,
  openInterval,
  plannedEnd,
  plannedMs,
} from "../server/humanSessionRules";
import type { HumanSession, IntervalKind, PomodoroSettings } from "../server/humanSessionRules";
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
    // Private mode or no storage: the next dialog opens on the defaults.
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

/** The settings part of the preferences — what the session record keeps. */
export function settingsOf(prefs: PomodoroPrefs): PomodoroSettings {
  const { workMinutes, shortBreakMinutes, longBreakMinutes, longBreakEvery } = prefs;
  return { workMinutes, shortBreakMinutes, longBreakMinutes, longBreakEvery };
}

// --- The store -------------------------------------------------------------

export interface PomodoroStore {
  /** The open session, or null when none runs. */
  session: HumanSession | null;
  /** The last tick, epoch ms — every clock reading derives from it. */
  now: number;
  prefs: PomodoroPrefs;
  /** The bar flashes until this time, after an interval ends. */
  flashUntil: number;
  busy: boolean;
  error: string | null;
}

let state: PomodoroStore = {
  session: null,
  now: 0,
  prefs: { ...DEFAULT_PREFS },
  flashUntil: 0,
  busy: false,
  error: null,
};
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
// network, the sounds and the ticker; null restores the defaults.
interface Deps {
  now: () => number;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  sounds: SoundPlayer;
  /** Run fn once a second until the returned function is called. */
  schedule: (fn: () => void) => () => void;
  /** Tell the user an interval is over, with the button that starts the next. */
  notify: (message: string, action: { label: string; run: () => void }) => void;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  fetch: (path, init) => fetch(path, init),
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
  state = { session: null, now: 0, prefs: { ...DEFAULT_PREFS }, flashUntil: 0, busy: false, error: null };
}

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await deps.fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
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

/** idle: no session; running: an interval is on; between: waiting for the next. */
export function phaseOf(session: HumanSession | null): Phase {
  if (!session) return "idle";
  return openInterval(session) ? "running" : "between";
}

/** Time left in the running interval, never below zero; zero when none runs. */
export function remainingMs(session: HumanSession | null, now: number): number {
  const open = session ? openInterval(session) : null;
  if (!session || !open) return 0;
  return Math.max(0, plannedEnd(open, session.pomodoro) - now);
}

/** How far the running interval has come, 0..1. */
export function progressOf(session: HumanSession | null, now: number): number {
  const open = session ? openInterval(session) : null;
  if (!session || !open) return 0;
  const total = plannedMs(open.kind, session.pomodoro);
  return total > 0 ? Math.min(1, Math.max(0, 1 - remainingMs(session, now) / total)) : 1;
}

/** mm:ss, rounded up so a fresh pomodoro reads 25:00 and the last second 00:01. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** "50m" or "1h 05m" — the session's focus so far, for the bar. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "24:59 · Focus" while an interval runs, for the window title; else null. */
export function titlePrefix(session: HumanSession | null, now: number): string | null {
  const open = session ? openInterval(session) : null;
  if (!open) return null;
  return `${formatClock(remainingMs(session, now))} · ${INTERVAL_LABEL[open.kind]}`;
}

/** Focus time so far, the running pomodoro included. */
export function totalWorkMs(session: HumanSession | null, now: number): number {
  return session ? computeTotals(session.intervals, new Date(now)).workMs : 0;
}

/** The button that begins the next interval. */
export function startLabel(kind: IntervalKind): string {
  return kind === "work" ? "Start pomodoro" : kind === "shortBreak" ? "Start break" : "Start long break";
}

// --- Actions ---------------------------------------------------------------

/** Close the running interval as completed at its planned end, and say so. */
async function complete(session: HumanSession, endMs: number, announce: boolean): Promise<void> {
  const endedAt = new Date(endMs).toISOString();
  let next: HumanSession;
  try {
    next = await call<HumanSession>(`/api/session/human/${session.id}/interval`, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "completed", endedAt }),
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    // Closed already — another window, or a tick that crossed ours.
    next = await call<HumanSession>(`/api/session/human/${session.id}`);
  }
  unschedule();
  set({ session: next, flashUntil: deps.now() + 2_000 });
  if (!announce) return;
  deps.sounds.play(state.prefs.sound);
  const kind = nextIntervalKind(next);
  deps.notify(`${INTERVAL_LABEL[session.intervals[session.intervals.length - 1]!.kind]} over`, {
    label: startLabel(kind),
    run: () => void pomodoro.startInterval(kind),
  });
  if (state.prefs.autoStart) await pomodoro.startInterval(kind);
}

/** End the running interval as abandoned — a voided pomodoro or a skipped break. */
async function abandonOpen(want: "work" | "break"): Promise<void> {
  const session = state.session;
  const open = session ? openInterval(session) : null;
  if (!session || !open) return;
  if ((open.kind === "work") !== (want === "work")) return;
  set({ busy: true, error: null });
  try {
    const next = await call<HumanSession>(`/api/session/human/${session.id}/interval`, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "abandoned" }),
    });
    unschedule();
    set({ session: next, flashUntil: 0 });
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    set({ busy: false });
  }
}

export const pomodoro = {
  /** Begin a session and its first pomodoro. Call from the click: it unlocks audio. */
  async start(name: string, prefs: PomodoroPrefs): Promise<void> {
    deps.sounds.unlock();
    writePrefs(prefs);
    set({ prefs, busy: true, error: null });
    try {
      const session = await call<HumanSession>("/api/session/human", {
        method: "POST",
        body: JSON.stringify({ name, pomodoro: settingsOf(prefs) }),
      });
      set({ session, now: deps.now() });
      await pomodoro.startInterval("work");
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  /** Begin the next interval — by default the one the rules say comes next. */
  async startInterval(kind?: IntervalKind): Promise<void> {
    const session = state.session;
    if (!session) return;
    deps.sounds.unlock();
    set({ busy: true, error: null });
    try {
      const next = await call<HumanSession>(`/api/session/human/${session.id}/interval`, {
        method: "POST",
        body: JSON.stringify({ kind: kind ?? nextIntervalKind(session) }),
      });
      set({ session: next, now: deps.now(), flashUntil: 0 });
      schedule();
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  /** Void the running pomodoro (an interruption): it does not count. */
  abandon(): Promise<void> {
    return abandonOpen("work");
  },

  /** Cut the running break short. */
  skipBreak(): Promise<void> {
    return abandonOpen("break");
  },

  /** End the session; a running interval is abandoned. */
  async endSession(): Promise<void> {
    const session = state.session;
    if (!session) return;
    set({ busy: true, error: null });
    try {
      await call(`/api/session/human/${session.id}/end`, { method: "POST" });
      unschedule();
      set({ session: null, flashUntil: 0 });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  /** The once-a-second reading: the clock, the tick, and the end when it comes. */
  tick(now: number = deps.now()): void {
    set({ now });
    const session = state.session;
    const open = session ? openInterval(session) : null;
    if (!session || !open) return;
    if (now >= plannedEnd(open, session.pomodoro)) {
      // Detach the tick so a second one does not close the same interval twice.
      unschedule();
      void complete(session, plannedEnd(open, session.pomodoro), true).catch((e: Error) =>
        set({ error: e.message }),
      );
      return;
    }
    if (state.prefs.tick && open.kind === "work") deps.sounds.tick();
  },

  /** On boot: pick up the open session, closing an interval that ran out meanwhile. */
  async restore(): Promise<void> {
    set({ prefs: readPrefs(), now: deps.now() });
    let session: HumanSession | null;
    try {
      ({ session } = await call<{ session: HumanSession | null }>("/api/session/human/active"));
    } catch {
      return;
    }
    if (!session) return;
    set({ session });
    const open = openInterval(session);
    if (!open) return;
    const end = plannedEnd(open, session.pomodoro);
    if (deps.now() >= end) {
      // No chime: whoever comes back to the app finds the bar offering the next step.
      await complete(session, end, false).catch((e: Error) => set({ error: e.message }));
    } else {
      schedule();
    }
  },
};
