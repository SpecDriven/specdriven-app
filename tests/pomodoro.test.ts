// The Pomodoro store (src/frontend/pomodoro.ts) against a fake server that
// applies the same rules the real one does: the clock derives from the
// planned end, the interval ends at that end however late the tick, and a
// session picked up after a reload or a sleep lands where it should.
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
import { appendInterval, closeInterval, endSession, newHumanSession } from "../src/server/humanSession";
import type { HumanSession, IntervalKind } from "../src/server/humanSession";
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

/** The pieces the store is wired to: a clock, a server, sounds, a ticker. */
function harness(initial: HumanSession | null = null) {
  let now = T0;
  let record: HumanSession | null = initial;
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const played: string[] = [];
  const notices: { message: string; label: string }[] = [];
  let unlocked = 0;
  let ticks = 0;
  let scheduled = 0;
  let cancelled = 0;
  const respond = (body: unknown, status = 200) => Response.json(body, { status });
  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const at = new Date(now);
    const id = record?.id ?? "";
    try {
      if (method === "GET" && path === "/api/session/human/active") {
        return respond({ session: record && record.endedAt === undefined ? record : null });
      }
      if (method === "POST" && path === "/api/session/human") {
        record = newHumanSession({ name: body.name, pomodoro: body.pomodoro, now: at });
        return respond(record, 201);
      }
      if (!record || !path.startsWith(`/api/session/human/${id}`)) return respond({ error: "session not found" }, 404);
      if (method === "GET") return respond(record);
      if (method === "POST" && path.endsWith("/interval")) return respond((record = appendInterval(record, body.kind, at)));
      if (method === "PATCH") return respond((record = closeInterval(record, body.outcome, at, body.endedAt)));
      if (method === "POST" && path.endsWith("/end")) return respond((record = endSession(record, at)));
      return respond({ error: "no route" }, 404);
    } catch (e) {
      return respond({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
    }
  };
  setPomodoroDeps({
    now: () => now,
    fetch,
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
    requests,
    played,
    notices,
    advance: (ms: number) => (now += ms),
    now: () => now,
    record: () => record,
    unlocked: () => unlocked,
    ticks: () => ticks,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
  };
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
    const base = newHumanSession({ name: "s", now: new Date(T0) });
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

describe("a session", () => {
  test("start unlocks audio, keeps the prefs, opens the session and its first pomodoro", async () => {
    const h = harness();
    const prefs = { ...DEFAULT_PREFS, workMinutes: 1, sound: "chime" as const };
    await pomodoro.start("focus", prefs);
    expect(h.unlocked()).toBeGreaterThanOrEqual(1);
    expect(readPrefs()).toEqual(prefs);
    expect(h.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/session/human",
      `POST /api/session/human/${h.record()!.id}/interval`,
    ]);
    expect(h.requests[0]!.body).toEqual({ name: "focus", pomodoro: { workMinutes: 1, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 } });
    expect(h.requests[1]!.body).toEqual({ kind: "work" });
    expect(phaseOf(pomodoroState().session)).toBe("running");
    expect(h.scheduled()).toBe(1);
    expect(pomodoroState().busy).toBe(false);
  });

  test("a tick before the end only moves the clock; at the end the pomodoro completes at its planned end", async () => {
    const h = harness();
    await pomodoro.start("focus", { ...DEFAULT_PREFS, workMinutes: 1 });
    const before = h.requests.length;
    h.advance(30_000);
    pomodoro.tick();
    expect(pomodoroState().now).toBe(T0 + 30_000);
    expect(h.requests).toHaveLength(before);
    expect(remainingMs(pomodoroState().session, pomodoroState().now)).toBe(30_000);
    // The laptop slept: the tick comes 90 s late.
    h.advance(90_000);
    pomodoro.tick();
    await Bun.sleep(0);
    const patch = h.requests[before]!;
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toEqual({ outcome: "completed", endedAt: new Date(T0 + MIN).toISOString() });
    const session = pomodoroState().session!;
    expect(session.intervals[0]!.outcome).toBe("completed");
    expect(session.totals).toEqual({ workMs: MIN, breakMs: 0, completedPomodoros: 1 });
    expect(phaseOf(session)).toBe("between");
    expect(h.played).toEqual(["bell"]);
    expect(pomodoroState().flashUntil).toBe(h.now() + 2_000);
    expect(h.cancelled()).toBeGreaterThanOrEqual(1);
    expect(h.notices).toEqual([{ message: "Focus over", label: "Start break" }]);
  });

  test("the next interval follows the rules, and the tick sounds only during focus when asked", async () => {
    const h = harness();
    await pomodoro.start("focus", { ...DEFAULT_PREFS, workMinutes: 1, shortBreakMinutes: 1, tick: true });
    pomodoro.tick();
    pomodoro.tick();
    expect(h.ticks()).toBe(2);
    h.advance(MIN);
    pomodoro.tick();
    await Bun.sleep(0);
    await pomodoro.startInterval();
    expect(h.requests[h.requests.length - 1]!.body).toEqual({ kind: "shortBreak" });
    expect(pomodoroState().flashUntil).toBe(0);
    pomodoro.tick();
    expect(h.ticks()).toBe(2);
    h.advance(MIN);
    pomodoro.tick();
    await Bun.sleep(0);
    expect(h.notices[1]).toEqual({ message: "Short break over", label: "Start pomodoro" });
  });

  test("auto-start chains the next interval", async () => {
    const h = harness();
    await pomodoro.start("focus", { ...DEFAULT_PREFS, workMinutes: 1, autoStart: true });
    h.advance(MIN);
    pomodoro.tick();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(phaseOf(pomodoroState().session)).toBe("running");
    expect(pomodoroState().session!.intervals[1]!.kind).toBe("shortBreak");
  });

  test("abandon voids a pomodoro, skip cuts a break, and each refuses the other", async () => {
    const h = harness();
    await pomodoro.start("focus", { ...DEFAULT_PREFS, workMinutes: 1 });
    const before = h.requests.length;
    await pomodoro.skipBreak();
    expect(h.requests).toHaveLength(before);
    h.advance(20_000);
    await pomodoro.abandon();
    const s1 = pomodoroState().session!;
    expect(s1.intervals[0]).toMatchObject({ outcome: "abandoned", endedAt: new Date(T0 + 20_000).toISOString() });
    expect(s1.totals).toEqual({ workMs: 20_000, breakMs: 0, completedPomodoros: 0 });
    expect(h.played).toEqual([]);
    await pomodoro.startInterval("shortBreak");
    await pomodoro.abandon();
    expect(phaseOf(pomodoroState().session)).toBe("running");
    await pomodoro.skipBreak();
    expect(phaseOf(pomodoroState().session)).toBe("between");
    expect(pomodoroState().session!.intervals[1]!.outcome).toBe("abandoned");
  });

  test("end closes the session and the clock, and the title prefix goes", async () => {
    const h = harness();
    await pomodoro.start("focus", DEFAULT_PREFS);
    expect(titlePrefix(pomodoroState().session, h.now())).toBe("25:00 · Focus");
    await pomodoro.endSession();
    expect(pomodoroState().session).toBeNull();
    expect(h.record()!.endedAt).toBeDefined();
    expect(h.record()!.intervals[0]!.outcome).toBe("abandoned");
    expect(h.cancelled()).toBeGreaterThanOrEqual(1);
    expect(titlePrefix(pomodoroState().session, h.now())).toBeNull();
    expect(h.scheduled()).toBe(1);
  });

  test("a failed start surfaces its error and leaves nothing running", async () => {
    harness();
    setPomodoroDeps({ fetch: async () => Response.json({ error: "A Pomodoro session is already running — end it first" }, { status: 409 }) });
    await expect(pomodoro.start("x", DEFAULT_PREFS)).rejects.toThrow("already running");
    expect(pomodoroState().error).toContain("already running");
    expect(pomodoroState().session).toBeNull();
  });
});

describe("restore", () => {
  test("with nothing open the store stays idle and takes the stored prefs", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ sound: "ding" }));
    const h = harness();
    await pomodoro.restore();
    expect(pomodoroState().session).toBeNull();
    expect(pomodoroState().prefs.sound).toBe("ding");
    expect(h.scheduled()).toBe(0);
  });

  test("a live interval resumes with the right time left", async () => {
    const opened = appendInterval(newHumanSession({ name: "s", now: new Date(T0) }), "work", new Date(T0));
    const h = harness(opened);
    h.advance(10 * MIN);
    await pomodoro.restore();
    expect(phaseOf(pomodoroState().session)).toBe("running");
    expect(remainingMs(pomodoroState().session, pomodoroState().now)).toBe(15 * MIN);
    expect(h.scheduled()).toBe(1);
  });

  test("an interval that ran out while the app was closed is completed at its planned end, quietly", async () => {
    const opened = appendInterval(newHumanSession({ name: "s", now: new Date(T0) }), "work", new Date(T0));
    const h = harness(opened);
    h.advance(40 * MIN);
    await pomodoro.restore();
    const session = pomodoroState().session!;
    expect(phaseOf(session)).toBe("between");
    expect(session.intervals[0]).toMatchObject({ outcome: "completed", endedAt: new Date(T0 + 25 * MIN).toISOString() });
    expect(h.played).toEqual([]);
    expect(h.scheduled()).toBe(0);
  });

  test("an ended session is not picked up", async () => {
    const ended = endSession(newHumanSession({ name: "s", now: new Date(T0) }), new Date(T0 + MIN));
    harness(ended);
    await pomodoro.restore();
    expect(pomodoroState().session).toBeNull();
  });
});

describe("two windows", () => {
  test("a completion the server already applied is picked up, not reported", async () => {
    const h = harness();
    await pomodoro.start("focus", { ...DEFAULT_PREFS, workMinutes: 1 });
    // The other window closed it first.
    const id = h.record()!.id;
    const otherFetch = async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ error: "No interval is running" }, { status: 409 });
      if (path === `/api/session/human/${id}`) {
        return Response.json(closeInterval(h.record()!, "completed", new Date(T0 + MIN), new Date(T0 + MIN).toISOString()));
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    };
    const session = pomodoroState().session!;
    setPomodoroDeps({
      now: () => T0 + MIN,
      fetch: otherFetch,
      sounds: { unlock() {}, play: (n: SoundName) => void h.played.push(n), tick() {} },
      schedule: () => () => undefined,
      notify: () => undefined,
    });
    // setPomodoroDeps resets the store; put the running session back.
    (pomodoroState() as { session: HumanSession | null }).session = session;
    pomodoro.tick(T0 + MIN);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(pomodoroState().error).toBeNull();
    expect(pomodoroState().session!.intervals[0]!.outcome).toBe("completed");
    expect(h.played).toEqual(["bell"]);
  });
});
