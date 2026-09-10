// The human session routes (roadmap/support-for-human-code-sessions.md):
// create, resume, run intervals, end — all without a data repo, since a
// Pomodoro needs none, and all recorded beside the settings file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-human-api-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-human-api-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method: string, body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

async function start(name = "focus on quotes", extra: Record<string, unknown> = {}) {
  const res = await api("/api/session/human", "POST", { name, ...extra });
  return { res, record: await res.json() };
}

describe("POST /api/session/human", () => {
  test("creates the record beside the settings file, with no data repo configured", async () => {
    const { res, record } = await start("focus on quotes", {
      pomodoro: { workMinutes: 50, longBreakEvery: 2 },
      specs: [{ fileName: "specs/quote.feature.md", partial: true }, { nope: 1 }],
      pages: [{ folder: "roadmap", file: "a.md" }, { folder: "notes", file: "b.md" }],
    });
    expect(res.status).toBe(201);
    expect(record.kind).toBe("human");
    expect(record.schemaVersion).toBe(1);
    expect(record.pomodoro).toEqual({ workMinutes: 50, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 2 });
    expect(record.specs).toEqual([{ fileName: "specs/quote.feature.md", partial: true }]);
    expect(record.pages).toEqual([{ folder: "roadmap", file: "a.md" }]);
    expect(typeof record.user).toBe("string");
    expect(record.dataRepo).toBeUndefined();
    expect(record.intervals).toEqual([]);
    const file = join(root, ".specdriven", "sessions", record.id, "session.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
  });

  test("names the data repo when one is configured", async () => {
    await writeState({ dataRepo: "/repos/specs" }, root);
    const { record } = await start();
    expect(record.dataRepo).toBe("/repos/specs");
  });

  test("refuses a missing name, a name too long, or settings out of range", async () => {
    expect((await start("")).res.status).toBe(400);
    expect((await start("  ")).res.status).toBe(400);
    expect((await start("x".repeat(121))).res.status).toBe(400);
    expect((await start("ok", { pomodoro: { workMinutes: 0 } })).res.status).toBe(400);
    expect((await start("ok", { pomodoro: { longBreakEvery: "x" } })).res.status).toBe(400);
    expect((await start("ok", { pomodoro: "yes" })).res.status).toBe(400);
    const bad = await api("/api/session/human", "POST");
    expect(bad.status).toBe(400);
  });

  test("one at a time: a second start is refused until the first ends", async () => {
    const { record } = await start();
    const again = await start("another");
    expect(again.res.status).toBe(409);
    expect(again.record.id).toBe(record.id);
    await api(`/api/session/human/${record.id}/end`, "POST");
    expect((await start("another")).res.status).toBe(201);
  });
});

describe("GET /api/session/human", () => {
  test("/active is the open session or null, and /:id finds one or 404s", async () => {
    expect(await (await api("/api/session/human/active", "GET")).json()).toEqual({ session: null });
    const { record } = await start();
    expect((await (await api("/api/session/human/active", "GET")).json()).session.id).toBe(record.id);
    expect((await (await api(`/api/session/human/${record.id}`, "GET")).json()).name).toBe("focus on quotes");
    expect((await api("/api/session/human/00000000-0000-4000-8000-000000000000", "GET")).status).toBe(404);
  });

  test("the table matches /active before /:id", () => {
    const active = matchApi("GET", "/api/session/human/active");
    const byId = matchApi("GET", "/api/session/human/abc");
    expect(active?.params).toEqual({});
    expect(byId?.params).toEqual({ id: "abc" });
    expect(active?.handler).not.toBe(byId?.handler);
  });
});

describe("intervals", () => {
  test("open one, refuse a second, refuse a bad kind", async () => {
    const { record } = await start();
    const opened = await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "work" });
    expect(opened.status).toBe(200);
    const body = await opened.json();
    expect(body.intervals).toHaveLength(1);
    expect(body.intervals[0].kind).toBe("work");
    expect(body.intervals[0].endedAt).toBeUndefined();
    expect((await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "shortBreak" })).status).toBe(409);
    expect((await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "nap" })).status).toBe(400);
  });

  test("close as completed at the planned end, and the totals follow", async () => {
    const { record } = await start("s", { pomodoro: { workMinutes: 1 } });
    const opened = await (await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "work" })).json();
    const startedAt = Date.parse(opened.intervals[0].startedAt);
    // The timer "ran out" a second ago: the client reports the planned end.
    const endedAt = new Date(startedAt + 1_000).toISOString();
    const closed = await api(`/api/session/human/${record.id}/interval`, "PATCH", { outcome: "completed", endedAt });
    expect(closed.status).toBe(200);
    const body = await closed.json();
    expect(body.intervals[0]).toEqual({ kind: "work", startedAt: opened.intervals[0].startedAt, endedAt, outcome: "completed" });
    expect(body.totals).toEqual({ workMs: 1_000, breakMs: 0, completedPomodoros: 1 });
  });

  test("refuses closing when nothing runs, a bad outcome, or an end out of bounds", async () => {
    const { record } = await start();
    const path = `/api/session/human/${record.id}/interval`;
    expect((await api(path, "PATCH", { outcome: "completed" })).status).toBe(409);
    const opened = await (await api(path, "POST", { kind: "work" })).json();
    expect((await api(path, "PATCH", { outcome: "paused" })).status).toBe(400);
    expect((await api(path, "PATCH", { outcome: "completed", endedAt: 5 })).status).toBe(400);
    const before = new Date(Date.parse(opened.intervals[0].startedAt) - 60_000).toISOString();
    expect((await api(path, "PATCH", { outcome: "completed", endedAt: before })).status).toBe(400);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await api(path, "PATCH", { outcome: "completed", endedAt: future })).status).toBe(400);
    // Still open after all those refusals.
    const abandoned = await api(path, "PATCH", { outcome: "abandoned" });
    expect(abandoned.status).toBe(200);
    expect((await abandoned.json()).intervals[0].outcome).toBe("abandoned");
  });

  test("an ended session takes no more intervals", async () => {
    const { record } = await start();
    await api(`/api/session/human/${record.id}/end`, "POST");
    expect((await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "work" })).status).toBe(409);
  });
});

describe("POST /api/session/human/:id/end", () => {
  test("ends the session, abandons a running break, counts its time, and is idempotent", async () => {
    const { record } = await start();
    await api(`/api/session/human/${record.id}/interval`, "POST", { kind: "shortBreak" });
    const ended = await api(`/api/session/human/${record.id}/end`, "POST");
    expect(ended.status).toBe(200);
    const body = await ended.json();
    expect(typeof body.endedAt).toBe("string");
    expect(body.intervals[0].outcome).toBe("abandoned");
    expect(body.intervals[0].endedAt).toBe(body.endedAt);
    expect(body.totals.breakMs).toBeGreaterThanOrEqual(0);
    expect(await (await api("/api/session/human/active", "GET")).json()).toEqual({ session: null });
    const again = await api(`/api/session/human/${record.id}/end`, "POST");
    expect(again.status).toBe(200);
    expect((await again.json()).endedAt).toBe(body.endedAt);
    expect((await api("/api/session/human/00000000-0000-4000-8000-000000000000/end", "POST")).status).toBe(404);
  });
});
