// The Pomodoro rules (specs/app/pomodoro.feature.md): what comes next, the
// cycle dots, the totals, and the timer's transitions.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POMODORO,
  PomodoroError,
  appendInterval,
  closeInterval,
  completedSinceLongBreak,
  computeTotals,
  cycleDots,
  nextIntervalKind,
  openInterval,
  plannedEnd,
  plannedMs,
} from "../src/frontend/pomodoroRules";
import type { PomodoroInterval, PomodoroTimer } from "../src/frontend/pomodoroRules";

const T0 = Date.parse("2026-09-08T16:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function timer(intervals: PomodoroInterval[], overrides: Partial<PomodoroTimer> = {}): PomodoroTimer {
  return { startedAt: T0, settings: { ...DEFAULT_POMODORO }, intervals, ...overrides };
}

const work = (start: number, outcome?: "completed" | "abandoned"): PomodoroInterval => ({
  kind: "work",
  startedAt: at(start),
  ...(outcome ? { endedAt: at(start + 25), outcome } : {}),
});
const brk = (
  kind: "shortBreak" | "longBreak",
  start: number,
  outcome: "completed" | "abandoned" = "completed",
): PomodoroInterval => ({ kind, startedAt: at(start), endedAt: at(start + 5), outcome });

describe("plannedMs / plannedEnd", () => {
  test("come from the timer's settings", () => {
    expect(plannedMs("work", DEFAULT_POMODORO)).toBe(25 * 60_000);
    expect(plannedMs("shortBreak", DEFAULT_POMODORO)).toBe(5 * 60_000);
    expect(plannedMs("longBreak", DEFAULT_POMODORO)).toBe(15 * 60_000);
    expect(plannedEnd(work(10), DEFAULT_POMODORO)).toBe(T0 + 35 * 60_000);
  });
});

describe("nextIntervalKind", () => {
  test("work to begin with, and again after a voided pomodoro", () => {
    expect(nextIntervalKind(timer([]))).toBe("work");
    expect(nextIntervalKind(timer([work(0, "abandoned")]))).toBe("work");
  });

  test("a short break after a pomodoro, the long one when the cycle is full", () => {
    expect(nextIntervalKind(timer([work(0, "completed")]))).toBe("shortBreak");
    const three = [work(0, "completed"), brk("shortBreak", 25), work(30, "completed"), brk("shortBreak", 55), work(60, "completed")];
    expect(nextIntervalKind(timer(three))).toBe("shortBreak");
    const four = [...three, brk("shortBreak", 85), work(90, "completed")];
    expect(nextIntervalKind(timer(four))).toBe("longBreak");
  });

  test("work after any break, and the cycle restarts after a long break of any outcome", () => {
    expect(nextIntervalKind(timer([work(0, "completed"), brk("shortBreak", 25)]))).toBe("work");
    expect(nextIntervalKind(timer([work(0, "completed"), brk("shortBreak", 25, "abandoned")]))).toBe("work");
    const cycle = [work(0, "completed"), work(25, "completed"), work(50, "completed"), work(75, "completed")];
    expect(completedSinceLongBreak(cycle)).toBe(4);
    expect(completedSinceLongBreak([...cycle, brk("longBreak", 100, "abandoned")])).toBe(0);
    expect(nextIntervalKind(timer([...cycle, brk("longBreak", 100, "abandoned"), work(105, "completed")]))).toBe("shortBreak");
  });

  test("honours the timer's own cycle length", () => {
    const two = timer([work(0, "completed"), brk("shortBreak", 25), work(30, "completed")], {
      settings: { ...DEFAULT_POMODORO, longBreakEvery: 2 },
    });
    expect(nextIntervalKind(two)).toBe("longBreak");
  });
});

describe("cycleDots", () => {
  test("fills one dot per completed pomodoro, capped at the cycle length", () => {
    expect(cycleDots(timer([]))).toEqual({ filled: 0, total: 4 });
    expect(cycleDots(timer([work(0, "completed"), work(25, "abandoned"), work(50, "completed")]))).toEqual({ filled: 2, total: 4 });
    const five = [0, 25, 50, 75, 100].map((m) => work(m, "completed"));
    expect(cycleDots(timer(five))).toEqual({ filled: 4, total: 4 });
  });
});

describe("computeTotals", () => {
  test("splits work from breaks, counts abandoned time, and only completed pomodoros", () => {
    const totals = computeTotals([work(0, "completed"), brk("shortBreak", 25, "abandoned"), work(30, "abandoned")]);
    expect(totals).toEqual({ workMs: 50 * 60_000, breakMs: 5 * 60_000, completedPomodoros: 1 });
  });

  test("an open interval counts only when told the time", () => {
    const intervals = [work(0)];
    expect(computeTotals(intervals)).toEqual({ workMs: 0, breakMs: 0, completedPomodoros: 0 });
    expect(computeTotals(intervals, new Date(T0 + 10 * 60_000)).workMs).toBe(10 * 60_000);
  });

  test("a span that runs backwards clamps to zero", () => {
    expect(computeTotals([{ kind: "work", startedAt: at(10), endedAt: at(5), outcome: "abandoned" }]).workMs).toBe(0);
  });
});

describe("openInterval", () => {
  test("only the last interval can be open", () => {
    expect(openInterval(timer([]))).toBeNull();
    expect(openInterval(timer([work(0, "completed")]))).toBeNull();
    expect(openInterval(timer([work(0, "completed"), work(30)]))?.startedAt).toBe(at(30));
  });
});

describe("transitions", () => {
  const now = new Date(T0 + 25 * 60_000);

  test("appendInterval opens one, and refuses a second while it runs", () => {
    const opened = appendInterval(timer([]), "work", new Date(T0));
    expect(opened.intervals).toEqual([{ kind: "work", startedAt: at(0) }]);
    expect(() => appendInterval(opened, "work", now)).toThrow(PomodoroError);
  });

  test("closeInterval ends the open one at now or at the planned end", () => {
    const opened = appendInterval(timer([]), "work", new Date(T0));
    const late = new Date(T0 + 26 * 60_000);
    const closed = closeInterval(opened, "completed", late, at(25));
    expect(closed.intervals[0]).toEqual({ kind: "work", startedAt: at(0), endedAt: at(25), outcome: "completed" });
    expect(computeTotals(closed.intervals)).toEqual({ workMs: 25 * 60_000, breakMs: 0, completedPomodoros: 1 });
    expect(closeInterval(opened, "abandoned", now).intervals[0]!.endedAt).toBe(now.toISOString());
  });

  test("closeInterval refuses when nothing runs, or an end before the start or in the future", () => {
    expect(() => closeInterval(timer([]), "completed", now)).toThrow("No interval");
    const opened = appendInterval(timer([]), "work", new Date(T0 + 60_000));
    expect(() => closeInterval(opened, "completed", now, at(0))).toThrow("before");
    expect(() => closeInterval(opened, "completed", now, at(40))).toThrow("future");
    expect(() => closeInterval(opened, "completed", now, "nope")).toThrow("not a date");
  });
});
