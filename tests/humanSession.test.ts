// The human session record on disk (roadmap/support-for-human-code-sessions.md):
// what the writer produces matches humanSession.schema.json exactly, the parser
// takes back anything close enough, and the folder is shared with AI session
// records without either side seeing the other.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../src/server/humanSession.schema.json";
import {
  HUMAN_SESSION_KEYS,
  activeHumanSession,
  computeTotals,
  listHumanSessions,
  newHumanSession,
  normalizeInterval,
  normalizePomodoro,
  parseHumanSession,
  readHumanSession,
  serializeHumanSession,
  writeHumanSession,
} from "../src/server/humanSession";
import type { HumanSession } from "../src/server/humanSession";

const ID = "0f2d7d3e-3a2b-4c1d-9e8f-0a1b2c3d4e5f";
const T0 = new Date("2026-09-08T16:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const valid = (value: unknown) => (validate(value) ? [] : validate.errors!.map((e) => `${e.instancePath} ${e.message}`));

/** A full record: every optional field present, one closed and one open interval. */
function fullRecord(): HumanSession {
  const base = newHumanSession({
    name: "implement quotes",
    user: "david",
    dataRepo: "/repos/specs",
    codeRepo: "/repos/code",
    specs: [{ fileName: "billing/quotes.feature.md", partial: true }],
    pages: [{ folder: "roadmap", file: "support-for-human-code-sessions.md" }],
    id: ID,
    now: T0,
  });
  const intervals = [
    { kind: "work" as const, startedAt: at(0), endedAt: at(25), outcome: "completed" as const },
    { kind: "shortBreak" as const, startedAt: at(25) },
  ];
  return { ...base, intervals, totals: computeTotals(intervals), notes: "went well" };
}

describe("newHumanSession", () => {
  test("is open, empty, and on the defaults", () => {
    const record = newHumanSession({ name: "s", id: ID, now: T0 });
    expect(record).toEqual({
      schemaVersion: 1,
      kind: "human",
      id: ID,
      name: "s",
      startedAt: at(0),
      updatedAt: at(0),
      specs: [],
      pages: [],
      pomodoro: { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 },
      intervals: [],
      totals: { workMs: 0, breakMs: 0, completedPomodoros: 0 },
    });
    expect(Object.keys(record)).not.toContain("user");
    expect(valid(record)).toEqual([]);
  });

  test("takes partial settings over the defaults and mints an id", () => {
    const record = newHumanSession({ name: "s", pomodoro: { workMinutes: 50 } });
    expect(record.pomodoro).toEqual({ workMinutes: 50, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("serializeHumanSession", () => {
  test("writes the keys in schema order, omits absent optionals, and recomputes totals", () => {
    const open = fullRecord();
    const record = { ...open, intervals: open.intervals.slice(0, 1), endedAt: at(30) };
    const text = serializeHumanSession({ ...record, totals: { workMs: 1, breakMs: 1, completedPomodoros: 9 } });
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([...HUMAN_SESSION_KEYS]);
    expect(parsed.totals).toEqual({ workMs: 25 * 60_000, breakMs: 0, completedPomodoros: 1 });
    expect(text.endsWith("}\n")).toBe(true);
    expect(valid(parsed)).toEqual([]);
  });

  test("the schema lists exactly the keys the writer knows", () => {
    expect(Object.keys(schema.properties)).toEqual([...HUMAN_SESSION_KEYS]);
  });
});

describe("parseHumanSession", () => {
  test("takes back what the writer produced", () => {
    const record = fullRecord();
    expect(parseHumanSession(JSON.parse(serializeHumanSession(record)))).toEqual(record);
  });

  test("refuses anything that is not a human session", () => {
    const good = fullRecord();
    const bad: unknown[] = [
      null,
      "x",
      [],
      { ...good, kind: undefined },
      { ...good, kind: "ai" },
      { id: ID, name: "AI", startedAt: at(0), agent: "pane", dataRepo: "/d", specs: [] },
      { ...good, schemaVersion: undefined },
      { ...good, schemaVersion: 2 },
      { ...good, id: "not-a-uuid" },
      { ...good, name: "" },
      { ...good, name: "x".repeat(121) },
      { ...good, startedAt: "yesterday" },
    ];
    for (const value of bad) {
      expect(parseHumanSession(value)).toBeNull();
      expect(valid(value)).not.toEqual([]);
    }
  });

  // The schema says what is written; the parser takes more — each of these
  // fails the schema and still comes back as a usable record.
  test("tolerates the near misses the schema rejects", () => {
    const good = fullRecord();
    const cases: [unknown, (r: HumanSession) => void][] = [
      [{ ...good, extra: 1 }, (r) => expect(Object.keys(r)).not.toContain("extra")],
      [{ ...good, specs: undefined, pages: undefined, intervals: undefined }, (r) => {
        expect(r.specs).toEqual([]);
        expect(r.pages).toEqual([]);
        expect(r.intervals).toEqual([]);
      }],
      [{ ...good, pomodoro: { workMinutes: 0, shortBreakMinutes: "5", longBreakEvery: 50 } }, (r) =>
        expect(r.pomodoro).toEqual({ workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 })],
      [{ ...good, pages: [{ folder: "notes", file: "a.md" }, { folder: "tasks", file: "b.md" }] }, (r) =>
        expect(r.pages).toEqual([{ folder: "tasks", file: "b.md" }])],
      [{ ...good, intervals: [{ kind: "work", startedAt: at(0), outcome: "completed" }] }, (r) =>
        expect(r.intervals).toEqual([{ kind: "work", startedAt: at(0) }])],
      [{ ...good, intervals: [{ kind: "work", startedAt: at(0), endedAt: at(25) }] }, (r) =>
        expect(r.intervals[0]!.outcome).toBe("abandoned")],
      [{ ...good, intervals: [{ kind: "nap", startedAt: at(0) }, { kind: "work" }], totals: { workMs: 5, breakMs: 5, completedPomodoros: 5 } }, (r) => {
        expect(r.intervals).toEqual([]);
        expect(r.totals).toEqual({ workMs: 0, breakMs: 0, completedPomodoros: 0 });
      }],
      [{ ...good, updatedAt: undefined, user: "", notes: 3 }, (r) => {
        expect(r.updatedAt).toBe(r.startedAt);
        expect(Object.keys(r)).not.toContain("user");
        expect(Object.keys(r)).not.toContain("notes");
      }],
    ];
    for (const [value, check] of cases) {
      expect(valid(value)).not.toEqual([]);
      const record = parseHumanSession(value);
      expect(record).not.toBeNull();
      check(record!);
      expect(valid(record)).toEqual([]);
    }
  });

  test("normalizers stand on their own", () => {
    expect(normalizePomodoro(null)).toEqual({ workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 });
    expect(normalizePomodoro({ workMinutes: 180, longBreakEvery: 12 }).workMinutes).toBe(180);
    expect(normalizePomodoro({ workMinutes: 181 }).workMinutes).toBe(25);
    expect(normalizeInterval({ kind: "longBreak", startedAt: at(0), endedAt: "x" })).toEqual({ kind: "longBreak", startedAt: at(0) });
    expect(normalizeInterval({ kind: "work" })).toBeNull();
  });
});

describe("on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "specdriven-human-session-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("write sets updatedAt and the file round-trips", async () => {
    const record = fullRecord();
    const later = new Date(T0.getTime() + 30 * 60_000);
    const written = await writeHumanSession(dir, record, later);
    expect(written.updatedAt).toBe(later.toISOString());
    const text = await readFile(join(dir, ID, "session.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ ...record, updatedAt: later.toISOString() });
    expect(valid(JSON.parse(text))).toEqual([]);
    expect(await readHumanSession(dir, ID)).toEqual(written);
  });

  test("read is null for a missing, corrupt, foreign, or misfiled record", async () => {
    expect(await readHumanSession(dir, ID)).toBeNull();
    await mkdir(join(dir, ID), { recursive: true });
    await writeFile(join(dir, ID, "session.json"), "{not json");
    expect(await readHumanSession(dir, ID)).toBeNull();
    await writeFile(join(dir, ID, "session.json"), JSON.stringify({ id: ID, name: "AI", startedAt: at(0), agent: "pane", dataRepo: "/d", specs: [] }));
    expect(await readHumanSession(dir, ID)).toBeNull();
    const other = "11111111-2222-4333-8444-555555555555";
    await mkdir(join(dir, other), { recursive: true });
    await writeFile(join(dir, other, "session.json"), serializeHumanSession(fullRecord()));
    expect(await readHumanSession(dir, other)).toBeNull();
  });

  test("list skips AI records and junk, newest first; active is the open one", async () => {
    expect(await listHumanSessions(dir)).toEqual([]);
    expect(await activeHumanSession(dir)).toBeNull();
    const older = newHumanSession({ name: "older", now: T0 });
    const newer = newHumanSession({ name: "newer", now: new Date(T0.getTime() + 60_000) });
    await writeHumanSession(dir, { ...older, endedAt: at(10) }, T0);
    await writeHumanSession(dir, newer, T0);
    const ai = "22222222-3333-4444-8555-666666666666";
    await mkdir(join(dir, ai), { recursive: true });
    await writeFile(join(dir, ai, "session.json"), JSON.stringify({ id: ai, name: "AI", startedAt: at(0), agent: "pane", dataRepo: "/d", specs: [] }));
    await writeFile(join(dir, "stray.txt"), "x");
    const listed = await listHumanSessions(dir);
    expect(listed.map((s) => s.name)).toEqual(["newer", "older"]);
    expect((await activeHumanSession(dir))?.name).toBe("newer");
  });
});
