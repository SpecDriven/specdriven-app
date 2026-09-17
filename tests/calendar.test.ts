// Add a task to Google Calendar (specs/app/tasks.feature.md,
// src/server/calendar.ts): the estimate's grammar and canonical form, the
// prefilled Google Calendar link, and the default start. Pure functions.

import { describe, expect, test } from "bun:test";
import {
  ESTIMATE_PRESETS,
  calendarDates,
  formatEstimate,
  formatEstimateLine,
  fromLocalInput,
  googleCalendarUrl,
  localInputValue,
  nextQuarterHour,
  parseEstimate,
  parseEstimateLine,
} from "../src/server/calendar";

describe("estimates", () => {
  test("an estimate parses minutes, hours and both, and formats back canonically", () => {
    expect(parseEstimate("30m")).toBe(30);
    expect(parseEstimate("2h")).toBe(120);
    expect(parseEstimate("1h30m")).toBe(90);
    expect(parseEstimate("1h 30m")).toBe(90);
    expect(parseEstimate("1 hour 30 minutes")).toBe(90);
    expect(parseEstimate("1.5h")).toBe(90);
    expect(parseEstimate("45 min")).toBe(45);
    expect(parseEstimate(" 90 ")).toBe(90);
    expect(formatEstimate(30)).toBe("30m");
    expect(formatEstimate(120)).toBe("2h");
    expect(formatEstimate(90)).toBe("1h 30m");
    for (const minutes of [1, 15, 59, 60, 61, 90, 480, 10080]) {
      expect(parseEstimate(formatEstimate(minutes))).toBe(minutes);
    }
    expect(ESTIMATE_PRESETS.map(formatEstimate)).toEqual(["15m", "30m", "1h", "2h", "4h", "8h"]);
  });

  test("an estimate outside one minute to a week, or in words, is not one", () => {
    expect(parseEstimate("0m")).toBeNull();
    expect(parseEstimate("0")).toBeNull();
    expect(parseEstimate("8 days")).toBeNull();
    expect(parseEstimate("169h")).toBeNull();
    expect(parseEstimate("half day")).toBeNull();
    expect(parseEstimate("soon")).toBeNull();
    expect(parseEstimate("")).toBeNull();
    expect(parseEstimate("1h 30")).toBeNull();
  });

  test("the Estimate line is read and written like the assignment's", () => {
    expect(formatEstimateLine(90)).toBe("**Estimate:** 1h 30m");
    expect(parseEstimateLine("**Estimate:** 1h 30m")).toBe(90);
    expect(parseEstimateLine("  **estimate:**  2 hours ")).toBe(120);
    expect(parseEstimateLine("**Estimate:** two days")).toBeNull();
    expect(parseEstimateLine("**Assigned:** Ada")).toBeNull();
    expect(parseEstimateLine("Estimate: 2h")).toBeNull();
  });
});

describe("the calendar link", () => {
  test("the Google Calendar link carries the title, UTC start and end, and the details", () => {
    const start = new Date(Date.UTC(2026, 8, 16, 12, 15, 0));
    const url = googleCalendarUrl({
      title: "Ship v2 & tell everyone",
      start,
      minutes: 120,
      details: "Cut the build.\n\nhttp://localhost:3000/tasks/ship-v2",
    });
    expect(url.startsWith("https://calendar.google.com/calendar/render?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("action")).toBe("TEMPLATE");
    expect(params.get("text")).toBe("Ship v2 & tell everyone");
    expect(params.get("dates")).toBe("20260916T121500Z/20260916T141500Z");
    expect(params.get("details")).toBe("Cut the build.\n\nhttp://localhost:3000/tasks/ship-v2");
    expect(params.has("ctz")).toBe(false);
    expect(calendarDates(start, 30)).toBe("20260916T121500Z/20260916T124500Z");
  });

  test("the default start is the next quarter hour", () => {
    const at = (h: number, m: number, s = 0) => new Date(2026, 8, 16, h, m, s, 123);
    expect(nextQuarterHour(at(14, 7)).getTime()).toBe(new Date(2026, 8, 16, 14, 15).getTime());
    expect(nextQuarterHour(at(14, 15)).getTime()).toBe(new Date(2026, 8, 16, 14, 15).getTime());
    expect(nextQuarterHour(at(14, 15, 30)).getTime()).toBe(new Date(2026, 8, 16, 14, 30).getTime());
    expect(nextQuarterHour(at(14, 46)).getTime()).toBe(new Date(2026, 8, 16, 15, 0).getTime());
    expect(nextQuarterHour(at(23, 59)).getTime()).toBe(new Date(2026, 8, 17, 0, 0).getTime());
  });

  test("a datetime-local value round-trips through the local zone", () => {
    const date = new Date(2026, 8, 16, 9, 5);
    expect(localInputValue(date)).toBe("2026-09-16T09:05");
    expect(fromLocalInput("2026-09-16T09:05")?.getTime()).toBe(date.getTime());
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("tomorrow")).toBeNull();
  });
});
