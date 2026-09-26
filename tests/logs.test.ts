// Observability on the server (src/server/logs.ts, src/server/telemetry.ts):
// verbosity that drops entries below a component's level from every sink,
// log lines parsed back into entries, the query behind the page — search,
// level, component, newest first across rotated files — and the routes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchApi } from "../src/server/api";
import { getLogs, getLogSettings, parseLogLine, putLogSettings, queryLogs } from "../src/server/logs";
import {
  effectiveLogLevel,
  getLogger,
  logVerbosity,
  resetLogVerbosity,
  setLogVerbosity,
} from "../src/server/telemetry";

const ENV = [
  "SPECDRIVEN_LOG_FILE",
  "SPECDRIVEN_LOG_DIR",
  "SPECDRIVEN_LOG_LEVEL",
  "SPECDRIVEN_ROOT",
  "SPECDRIVEN_HOME",
  "DEMO_MODE",
] as const;
const savedEnv = new Map(ENV.map((k) => [k, process.env[k]]));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-logs-"));
  delete process.env.SPECDRIVEN_LOG_FILE;
  process.env.SPECDRIVEN_LOG_DIR = join(dir, "logs");
  process.env.SPECDRIVEN_ROOT = dir;
  process.env.SPECDRIVEN_HOME = join(dir, "home");
  delete process.env.SPECDRIVEN_LOG_LEVEL;
  delete process.env.DEMO_MODE;
  resetLogVerbosity();
});

afterEach(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetLogVerbosity();
  await rm(dir, { recursive: true, force: true });
});

const logFile = () => join(dir, "logs", "specdriven.log");

describe("verbosity", () => {
  test("everything is written by default", () => {
    expect(logVerbosity()).toEqual({ level: "debug", components: {} });
    expect(effectiveLogLevel("anything")).toBe("debug");
  });

  test("SPECDRIVEN_LOG_LEVEL sets the starting level", () => {
    process.env.SPECDRIVEN_LOG_LEVEL = "warn";
    resetLogVerbosity();
    expect(logVerbosity().level).toBe("warn");
  });

  test("entries below the level reach no sink; a component override wins", async () => {
    setLogVerbosity({ level: "warn", components: { sync: "debug" } });
    getLogger("reload").info("dropped");
    getLogger("reload").warn("kept");
    getLogger("sync").debug("kept too");
    const text = await readFile(logFile(), "utf8");
    expect(text).not.toContain("dropped");
    expect(text).toContain("WARN  [reload] kept");
    expect(text).toContain("DEBUG [sync] kept too");
  });

  test("invalid levels are ignored rather than applied", () => {
    setLogVerbosity({ level: "loud", components: { a: "info", b: "nope", "": "error" } });
    expect(logVerbosity()).toEqual({ level: "debug", components: { a: "info" } });
  });
});

describe("parseLogLine", () => {
  test("splits time, level, component, message, attributes and trace", () => {
    const line =
      '2026-09-26T10:00:00.000Z WARN  [netsync] peer gone a=b count=2 note="x \\"y\\" z" ' +
      `trace=${"a".repeat(32)} span=${"b".repeat(16)}`;
    expect(parseLogLine(line)).toEqual({
      time: "2026-09-26T10:00:00.000Z",
      level: "warn",
      component: "netsync",
      message: "peer gone",
      attributes: { a: "b", count: "2", note: 'x "y" z' },
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    });
  });

  test("an equals sign inside the message stays in the message", () => {
    const entry = parseLogLine('2026-09-26T10:00:00.000Z INFO  [git] set x=1 and go files=3');
    expect(entry!.message).toBe("set x=1 and go");
    expect(entry!.attributes).toEqual({ files: "3" });
  });

  test("a line not in the format is not an entry", () => {
    expect(parseLogLine("garbage")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });

  test("round-trips what getLogger writes", async () => {
    getLogger("pages").error("save failed", { "exception.message": "disk full", bytes: 7 });
    const line = (await readFile(logFile(), "utf8")).trim();
    const entry = parseLogLine(line)!;
    expect(entry.level).toBe("error");
    expect(entry.component).toBe("pages");
    expect(entry.message).toBe("save failed");
    expect(entry.attributes).toEqual({ "exception.message": "disk full", bytes: "7" });
  });
});

describe("queryLogs", () => {
  const at = (s: number) => `2026-09-26T10:00:${String(s).padStart(2, "0")}.000Z`;

  async function seed() {
    // Rotated file .1 holds the older lines.
    await Bun.write(
      `${logFile()}.1`,
      [`${at(1)} INFO  [reload] pulled files=2`, `${at(2)} DEBUG [automerge] saved chunk`].join("\n") + "\n",
    );
    await writeFile(
      logFile(),
      [`${at(3)} WARN  [netsync] peer gone`, `${at(4)} ERROR [reload] Pull failed`, "not a log line"].join("\n") + "\n",
    );
  }

  test("reads newest first across the current and rotated files", async () => {
    await seed();
    const page = await queryLogs();
    expect(page.entries.map((e) => e.time)).toEqual([at(4), at(3), at(2), at(1)]);
    expect(page.more).toBe(false);
  });

  test("filters by minimum level and component", async () => {
    await seed();
    expect((await queryLogs({ level: "warn" })).entries.map((e) => e.component)).toEqual(["reload", "netsync"]);
    expect((await queryLogs({ components: ["reload"] })).entries.map((e) => e.message)).toEqual([
      "Pull failed",
      "pulled",
    ]);
  });

  test("searches text case-insensitively, or as a regular expression", async () => {
    await seed();
    expect((await queryLogs({ q: "PULL" })).entries.map((e) => e.message)).toEqual(["Pull failed", "pulled"]);
    expect((await queryLogs({ q: "files=2" })).entries).toHaveLength(1);
    expect((await queryLogs({ q: "^\\S+ (WARN|ERROR)", regex: true })).entries).toHaveLength(2);
    await expect(queryLogs({ q: "(", regex: true })).rejects.toThrow(SyntaxError);
  });

  test("stops at the limit and says there is more", async () => {
    await seed();
    const page = await queryLogs({ limit: 2 });
    expect(page.entries.map((e) => e.time)).toEqual([at(4), at(3)]);
    expect(page.more).toBe(true);
  });

  test("with the file sink off, reads the in-memory tail", async () => {
    process.env.SPECDRIVEN_LOG_FILE = "0";
    const marker = `memory-${Math.random()}`;
    getLogger("memtest").info(marker);
    const page = await queryLogs({ q: marker });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.component).toBe("memtest");
  });
});

describe("routes", () => {
  const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

  test("are registered", () => {
    expect(matchApi("GET", "/api/logs")).not.toBeNull();
    expect(matchApi("GET", "/api/logs/settings")).not.toBeNull();
    expect(matchApi("PUT", "/api/logs/settings")).not.toBeNull();
    expect(matchApi("POST", "/api/logs")).toBeNull();
  });

  test("GET /api/logs answers a page and refuses bad parameters", async () => {
    getLogger("routes").warn("hello there");
    const ok = await getLogs(req("/api/logs?q=hello&level=info&components=routes"), {});
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entries: { message: string }[] };
    expect(body.entries.map((e) => e.message)).toEqual(["hello there"]);
    expect((await getLogs(req("/api/logs?level=loud"), {})).status).toBe(400);
    expect((await getLogs(req("/api/logs?limit=0"), {})).status).toBe(400);
    const bad = await getLogs(req("/api/logs?q=(&regex=1"), {});
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("Invalid regular expression");
  });

  test("PUT /api/logs/settings applies the verbosity and saves it", async () => {
    getLogger("git");
    const res = await putLogSettings(
      req("/api/logs/settings", {
        method: "PUT",
        body: JSON.stringify({ level: "info", components: { git: "error" } }),
      }),
      {},
    );
    expect(res.status).toBe(200);
    const settings = (await res.json()) as { level: string; components: object; known: string[]; source: object };
    expect(settings.level).toBe("info");
    expect(settings.components).toEqual({ git: "error" });
    expect(settings.known).toContain("git");
    expect(settings.source).toEqual({ kind: "file", dir: join(dir, "logs") });
    expect(effectiveLogLevel("git")).toBe("error");
    const saved = JSON.parse(await readFile(join(dir, ".specdriven", "settings.json"), "utf8"));
    expect(saved.logLevel).toBe("info");
    expect(saved.logLevels).toEqual({ git: "error" });
  });

  test("PUT /api/logs/settings refuses invalid levels", async () => {
    const put = (body: unknown) =>
      putLogSettings(req("/api/logs/settings", { method: "PUT", body: JSON.stringify(body) }), {});
    expect((await put({ level: "loud" })).status).toBe(400);
    expect((await put({ components: { git: "loud" } })).status).toBe(400);
    expect((await put([])).status).toBe(400);
    expect(logVerbosity()).toEqual({ level: "debug", components: {} });
  });

  test("the demo refuses them all", async () => {
    process.env.DEMO_MODE = "1";
    expect((await getLogs(req("/api/logs"), {})).status).toBe(403);
    expect((await getLogSettings(req("/api/logs/settings"), {})).status).toBe(403);
    const put = await putLogSettings(
      req("/api/logs/settings", { method: "PUT", body: JSON.stringify({ level: "error" }) }),
      {},
    );
    expect(put.status).toBe(403);
    expect(logVerbosity().level).toBe("debug");
  });
});
