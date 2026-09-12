// The Pomodoro store (src/frontend/pomodoro.ts): the clock derives from the
// planned end, so the interval ends at that end however late the tick, and
// the technique's rules decide what is offered next. The timer lives in
// memory — there is no record and no server — so nothing here stubs a fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  clampMinutes,
  formatClock,
  formatDuration,
  normalizePrefs,
  phaseOf,
  pomodoro,
  pomodoroState,
  progressOf,
  readPrefs,
  remainingMs,
  setPomodoroDeps,
  startLabel,
  titlePrefix,
  totalWorkMs,
} from "../src/frontend/pomodoro";
import { DEFAULT_POMODORO, appendInterval, closeInterval } from "../src/frontend/pomodoroRules";
import type { PomodoroTimer } from "../src/frontend/pomodoroRules";
import type { SoundName } from "../src/frontend/sounds";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const g = globalThis as { localStorage?: Storage };
let savedStorage: Storage | undefined;

const T0 = Date.parse("2026-09-08T16:00:00.000Z");
const MIN = 60_000;

/** The pieces the store is wired to: a clock, sounds, a ticker, a notice. */
function harness() {
  let now = T0;
  const played: string[] = [];
  const notices: { message: string; label: string }[] = [];
  let unlocked = 0;
  let ticks = 0;
  let scheduled = 0;
  let cancelled = 0;
  setPomodoroDeps({
    now: () => now,
    sounds: {
      unlock: () => void (unlocked += 1),
      play: (name: SoundName) => void played.push(name),
      tick: () => void (ticks += 1),
    },
    schedule: () => {
      scheduled += 1;
      return () => void (cancelled += 1);
    },
    notify: (message, action) => void notices.push({ message, label: action.label }),
  });
  return {
    played,
    notices,
    advance: (ms: number) => (now += ms),
    now: () => now,
    unlocked: () => unlocked,
    ticks: () => ticks,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
  };
}

/** A timer built straight from the rules, for the pure readings. */
function timerAt(startMinute = 0): PomodoroTimer {
  return { startedAt: T0, settings: { ...DEFAULT_POMODORO }, intervals: [] };
}

beforeEach(() => {
  savedStorage = g.localStorage;
  g.localStorage = fakeStorage();
});

afterEach(() => {
  setPomodoroDeps(null);
  if (savedStorage === undefined) delete g.localStorage;
  else g.localStorage = savedStorage;
});

describe("preferences", () => {
  test("defaults when nothing or junk is stored; each field clamps on its own", () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, "{nope");
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ workMinutes: 999, shortBreakMinutes: "3", longBreakEvery: 0, sound: "siren", tick: true }));
    expect(readPrefs()).toEqual({ ...DEFAULT_PREFS, workMinutes: 180, shortBreakMinutes: 3, longBreakEvery: 1, tick: true });
    expect(clampMinutes("25.4", 1)).toBe(25);
    expect(clampMinutes("", 7)).toBe(7);
    expect(normalizePrefs(null).autoStart).toBe(false);
  });

  test("load takes the stored preferences, and savePrefs keeps them for the next timer", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ sound: "ding" }));
    harness();
    pomodoro.load();
    expect(pomodoroState().prefs.sound).toBe("ding");
    expect(pomodoroState().timer).toBeNull();
    pomodoro.savePrefs({ ...DEFAULT_PREFS, workMinutes: 30 });
    expect(pomodoroState().prefs.workMinutes).toBe(30);
    expect(readPrefs().workMinutes).toBe(30);
  });
});

describe("readings", () => {
  test("the clock rounds up, the title carries the phase, durations read as minutes", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(1_499_000)).toBe("24:59");
    expect(formatClock(1_499_500)).toBe("25:00");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-5)).toBe("00:00");
    expect(formatDuration(50 * MIN)).toBe("50m");
    expect(formatDuration(65 * MIN)).toBe("1h 05m");
    expect(startLabel("work")).toBe("Start pomodoro");
    expect(startLabel("shortBreak")).toBe("Start break");
    expect(startLabel("longBreak")).toBe("Start long break");
  });

  test("derive from the open interval's planned end", () => {
    const base = timerAt();
    expect(phaseOf(null)).toBe("idle");
    expect(phaseOf(base)).toBe("between");
    expect(titlePrefix(base, T0)).toBeNull();
    const running = appendInterval(base, "work", new Date(T0));
    expect(phaseOf(running)).toBe("running");
    expect(remainingMs(running, T0 + 1_000)).toBe(24 * MIN + 59_000);
    expect(remainingMs(running, T0 + 30 * MIN)).toBe(0);
    expect(progressOf(running, T0 + 10 * MIN)).toBeCloseTo(0.4);
    expect(titlePrefix(running, T0 + 1_000)).toBe("24:59 · Focus");
    expect(totalWorkMs(running, T0 + 10 * MIN)).toBe(10 * MIN);
    const onBreak = appendInterval(closeInterval(running, "completed", new Date(T0 + 25 * MIN)), "shortBreak", new Date(T0 + 25 * MIN));
    expect(titlePrefix(onBreak, T0 + 25 * MIN + 1_000)).toBe("04:59 · Short break");
    expect(totalWorkMs(onBreak, T0 + 27 * MIN)).toBe(25 * MIN);
  });
});

describe("the timer", () => {
  test("start unlocks audio, keeps the prefs, and opens the first pomodoro at once", () => {
    const h = harness();
    const prefs = { ...DEFAULT_PREFS, workMinutes: 1, sound: "chime" as const };
    pomodoro.start(prefs);
    expect(h.unlocked()).toBeGreaterThanOrEqual(1);
    expect(readPrefs()).toEqual(prefs);
    const timer = pomodoroState().timer!;
    expect(timer.startedAt).toBe(T0);
    expect(timer.settings).toEqual({ workMinutes: 1, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 });
    expect(timer.intervals).toEqual([{ kind: "work", startedAt: new Date(T0).toISOString() }]);
    expect(phaseOf(timer)).toBe("running");
    expect(h.scheduled()).toBe(1);
    expect(pomodoroState().error).toBeNull();
  });

  test("starting while one runs changes nothing", () => {
    harness();
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 1 });
    const first = pomodoroState().timer;
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 9 });
    expect(pomodoroState().timer).toBe(first);
  });

  test("a tick before the end only moves the clock; at the end the pomodoro completes at its planned end", () => {
    const h = harness();
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 1 });
    h.advance(30_000);
    pomodoro.tick();
    expect(pomodoroState().now).toBe(T0 + 30_000);
    expect(remainingMs(pomodoroState().timer, pomodoroState().now)).toBe(30_000);
    expect(pomodoroState().timer!.intervals[0]!.endedAt).toBeUndefined();
    // The laptop slept: the tick comes 90 s late.
    h.advance(90_000);
    pomodoro.tick();
    const timer = pomodoroState().timer!;
    expect(timer.intervals[0]).toEqual({
      kind: "work",
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + MIN).toISOString(),
      outcome: "completed",
    });
    expect(phaseOf(timer)).toBe("between");
    expect(totalWorkMs(timer, h.now())).toBe(MIN);
    expect(h.played).toEqual(["bell"]);
    expect(pomodoroState().flashUntil).toBe(h.now() + 2_000);
    expect(h.cancelled()).toBeGreaterThanOrEqual(1);
    expect(h.notices).toEqual([{ message: "Focus over", label: "Start break" }]);
  });

  test("the next interval follows the rules, and the tick sounds only during focus when asked", () => {
    const h = harness();
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 1, shortBreakMinutes: 1, tick: true });
    pomodoro.tick();
    pomodoro.tick();
    expect(h.ticks()).toBe(2);
    h.advance(MIN);
    pomodoro.tick();
    pomodoro.startInterval();
    expect(pomodoroState().timer!.intervals[1]!.kind).toBe("shortBreak");
    expect(pomodoroState().flashUntil).toBe(0);
    pomodoro.tick();
    expect(h.ticks()).toBe(2);
    h.advance(MIN);
    pomodoro.tick();
    expect(h.notices[1]).toEqual({ message: "Short break over", label: "Start pomodoro" });
  });

  test("auto-start chains the next interval", () => {
    const h = harness();
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 1, autoStart: true });
    h.advance(MIN);
    pomodoro.tick();
    expect(phaseOf(pomodoroState().timer)).toBe("running");
    expect(pomodoroState().timer!.intervals[1]!.kind).toBe("shortBreak");
  });

  test("abandon voids a pomodoro, skip cuts a break, and each refuses the other", () => {
    const h = harness();
    pomodoro.start({ ...DEFAULT_PREFS, workMinutes: 1 });
    pomodoro.skipBreak();
    expect(phaseOf(pomodoroState().timer)).toBe("running");
    h.advance(20_000);
    pomodoro.abandon();
    const t1 = pomodoroState().timer!;
    expect(t1.intervals[0]).toMatchObject({ outcome: "abandoned", endedAt: new Date(T0 + 20_000).toISOString() });
    expect(totalWorkMs(t1, h.now())).toBe(20_000);
    expect(h.played).toEqual([]);
    pomodoro.startInterval("shortBreak");
    pomodoro.abandon();
    expect(phaseOf(pomodoroState().timer)).toBe("running");
    pomodoro.skipBreak();
    expect(phaseOf(pomodoroState().timer)).toBe("between");
    expect(pomodoroState().timer!.intervals[1]!.outcome).toBe("abandoned");
  });

  test("stop switches the timer off, and the title prefix goes with it", () => {
    const h = harness();
    pomodoro.start(DEFAULT_PREFS);
    expect(titlePrefix(pomodoroState().timer, h.now())).toBe("25:00 · Focus");
    pomodoro.stop();
    expect(pomodoroState().timer).toBeNull();
    expect(h.cancelled()).toBeGreaterThanOrEqual(1);
    expect(titlePrefix(pomodoroState().timer, h.now())).toBeNull();
    expect(h.scheduled()).toBe(1);
  });

  test("nothing happens without a timer", () => {
    harness();
    pomodoro.startInterval();
    pomodoro.abandon();
    pomodoro.skipBreak();
    pomodoro.tick();
    pomodoro.stop();
    expect(pomodoroState().timer).toBeNull();
    expect(pomodoroState().error).toBeNull();
  });
});
