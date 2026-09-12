// The Pomodoro's two device-local preferences (src/frontend/pomodoroPref.ts):
// whether the timer is part of this app at all — off until asked for — and
// whether its bar is out or folded into its icon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyPomodoroEnabled,
  applyPomodoroShown,
  readPomodoroEnabled,
  readPomodoroShown,
} from "../src/frontend/pomodoroPref";

// The preferences live in localStorage, which bun's test runtime lacks.
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
let saved: Storage | undefined;

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();
});

afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

const brokenStorage = () => {
  g.localStorage = {
    ...fakeStorage(),
    getItem: () => {
      throw new Error("private mode");
    },
  };
};

describe("whether the Pomodoro is here at all", () => {
  test("is off until switched on — a timer nobody asked for costs sidebar", () => {
    expect(readPomodoroEnabled()).toBe(false);
  });

  test("is remembered on the device, and off is stored as a decision", () => {
    applyPomodoroEnabled(true);
    expect(readPomodoroEnabled()).toBe(true);
    expect(g.localStorage!.getItem("sd-pomodoro-enabled")).toBe("on");
    applyPomodoroEnabled(false);
    expect(readPomodoroEnabled()).toBe(false);
    expect(g.localStorage!.getItem("sd-pomodoro-enabled")).toBe("off");
  });

  test("reads off when storage is unavailable", () => {
    brokenStorage();
    expect(readPomodoroEnabled()).toBe(false);
  });
});

describe("whether the bar is out", () => {
  test("starts out, so turning the feature on shows what was switched on", () => {
    expect(readPomodoroShown()).toBe(true);
  });

  test("closes and stays closed", () => {
    applyPomodoroShown(false);
    expect(readPomodoroShown()).toBe(false);
    expect(g.localStorage!.getItem("sd-pomodoro-shown")).toBe("off");
    applyPomodoroShown(true);
    expect(readPomodoroShown()).toBe(true);
  });

  test("reads out when storage is unavailable", () => {
    brokenStorage();
    expect(readPomodoroShown()).toBe(true);
  });

  test("is its own question — closing the bar leaves the feature on", () => {
    applyPomodoroEnabled(true);
    applyPomodoroShown(false);
    expect(readPomodoroEnabled()).toBe(true);
    expect(readPomodoroShown()).toBe(false);
  });
});
