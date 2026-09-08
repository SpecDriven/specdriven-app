// The Pomodoro rules over a human session record
// (roadmap/support-for-human-code-sessions.md): what comes next, the cycle
// dots, the totals, and the record transitions.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POMODORO,
  HumanSessionError,
  appendInterval,
  closeInterval,
  completedSinceLongBreak,
  computeTotals,
  cycleDots,
  endSession,
  humanSessionStatus,
  nextIntervalKind,
  openInterval,
  plannedEnd,
  plannedMs,
} from "../src/server/humanSessionRules";
import type { HumanSession, PomodoroInterval } from "../src/server/humanSessionRules";

const T0 = Date.parse("2026-09-08T16:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function session(intervals: PomodoroInterval[], overrides: Partial<HumanSession> = {}): HumanSession {
  return {
    schemaVersion: 1,
    kind: "human",
    id: "0f2d7d3e-3a2b-4c1d-9e8f-0a1b2c3d4e5f",
    name: "s",
    startedAt: at(0),
    updatedAt: at(0),
    specs: [],
    pages: [],
    pomodoro: { ...DEFAULT_POMODORO },
    intervals,
    totals: computeTotals(intervals),
    ...overrides,
  };
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
  test("come from the session's settings", () => {
    expect(plannedMs("work", DEFAULT_POMODORO)).toBe(25 * 60_000);
    expect(plannedMs("shortBreak", DEFAULT_POMODORO)).toBe(5 * 60_000);
    expect(plannedMs("longBreak", DEFAULT_POMODORO)).toBe(15 * 60_000);
    expect(plannedEnd(work(10), DEFAULT_POMODORO)).toBe(T0 + 35 * 60_000);
  });
});

describe("nextIntervalKind", () => {
  test("work to begin with, and again after a voided pomodoro", () => {
    expect(nextIntervalKind(session([]))).toBe("work");
    expect(nextIntervalKind(session([work(0, "abandoned")]))).toBe("work");
  });

  test("a short break after a pomodoro, the long one when the cycle is full", () => {
    expect(nextIntervalKind(session([work(0, "completed")]))).toBe("shortBreak");
    const three = [work(0, "completed"), brk("shortBreak", 25), work(30, "completed"), brk("shortBreak", 55), work(60, "completed")];
    expect(nextIntervalKind(session(three))).toBe("shortBreak");
    const four = [...three, brk("shortBreak", 85), work(90, "completed")];
    expect(nextIntervalKind(session(four))).toBe("longBreak");
  });

  test("work after any break, and the cycle restarts after a long break of any outcome", () => {
    expect(nextIntervalKind(session([work(0, "completed"), brk("shortBreak", 25)]))).toBe("work");
    expect(nextIntervalKind(session([work(0, "completed"), brk("shortBreak", 25, "abandoned")]))).toBe("work");
    const cycle = [work(0, "completed"), work(25, "completed"), work(50, "completed"), work(75, "completed")];
    expect(completedSinceLongBreak(cycle)).toBe(4);
    expect(completedSinceLongBreak([...cycle, brk("longBreak", 100, "abandoned")])).toBe(0);
    expect(nextIntervalKind(session([...cycle, brk("longBreak", 100, "abandoned"), work(105, "completed")]))).toBe("shortBreak");
  });

  test("honours the session's own cycle length", () => {
    const two = session([work(0, "completed"), brk("shortBreak", 25), work(30, "completed")], {
      pomodoro: { ...DEFAULT_POMODORO, longBreakEvery: 2 },
    });
    expect(nextIntervalKind(two)).toBe("longBreak");
  });
});

describe("cycleDots", () => {
  test("fills one dot per completed pomodoro, capped at the cycle length", () => {
    expect(cycleDots(session([]))).toEqual({ filled: 0, total: 4 });
    expect(cycleDots(session([work(0, "completed"), work(25, "abandoned"), work(50, "completed")]))).toEqual({ filled: 2, total: 4 });
    const five = [0, 25, 50, 75, 100].map((m) => work(m, "completed"));
    expect(cycleDots(session(five))).toEqual({ filled: 4, total: 4 });
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

describe("openInterval / humanSessionStatus", () => {
  test("only the last interval can be open", () => {
    expect(openInterval(session([]))).toBeNull();
    expect(openInterval(session([work(0, "completed")]))).toBeNull();
    expect(openInterval(session([work(0, "completed"), work(30)]))?.startedAt).toBe(at(30));
  });

  test("open, then stale once nothing was written for longer than an interval, ended when ended", () => {
    const s = session([work(0)]);
    expect(humanSessionStatus(s, new Date(T0 + 20 * 60_000))).toBe("open");
    expect(humanSessionStatus(s, new Date(T0 + 29 * 60_000))).toBe("open");
    expect(humanSessionStatus(s, new Date(T0 + 31 * 60_000))).toBe("stale");
    expect(humanSessionStatus(session([], { endedAt: at(1) }), new Date(T0))).toBe("ended");
  });
});

describe("transitions", () => {
  const now = new Date(T0 + 25 * 60_000);

  test("appendInterval opens one, and refuses a second or an ended session", () => {
    const opened = appendInterval(session([]), "work", new Date(T0));
    expect(opened.intervals).toEqual([{ kind: "work", startedAt: at(0) }]);
    expect(() => appendInterval(opened, "work", now)).toThrow(HumanSessionError);
    expect(() => appendInterval(session([], { endedAt: at(1) }), "work", now)).toThrow("has ended");
  });

  test("closeInterval ends the open one at now or at the planned end, and recomputes totals", () => {
    const opened = appendInterval(session([]), "work", new Date(T0));
    const late = new Date(T0 + 26 * 60_000);
    const closed = closeInterval(opened, "completed", late, at(25));
    expect(closed.intervals[0]).toEqual({ kind: "work", startedAt: at(0), endedAt: at(25), outcome: "completed" });
    expect(closed.totals).toEqual({ workMs: 25 * 60_000, breakMs: 0, completedPomodoros: 1 });
    expect(closeInterval(opened, "abandoned", now).intervals[0]!.endedAt).toBe(now.toISOString());
  });

  test("closeInterval refuses when nothing runs, or an end before the start or in the future", () => {
    expect(() => closeInterval(session([]), "completed", now)).toThrow("No interval");
    const opened = appendInterval(session([]), "work", new Date(T0 + 60_000));
    expect(() => closeInterval(opened, "completed", now, at(0))).toThrow("before");
    expect(() => closeInterval(opened, "completed", now, at(40))).toThrow("future");
    expect(() => closeInterval(opened, "completed", now, "nope")).toThrow("not a date");
    try {
      closeInterval(opened, "completed", now, "nope");
    } catch (e) {
      expect((e as HumanSessionError).status).toBe(400);
    }
  });

  test("endSession abandons a running interval, and ending twice changes nothing", () => {
    const opened = appendInterval(session([]), "shortBreak", new Date(T0));
    const ended = endSession(opened, now);
    expect(ended.endedAt).toBe(now.toISOString());
    expect(ended.intervals[0]!.outcome).toBe("abandoned");
    expect(ended.totals.breakMs).toBe(25 * 60_000);
    expect(endSession(ended, new Date(T0 + 60 * 60_000))).toBe(ended);
  });
});
