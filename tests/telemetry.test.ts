import { test, expect, afterEach, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { importDrift } from "../src/server/automerge/driftSync";
import { syncDataDir } from "../src/server/reload";
import {
  errorAttributes,
  getLogger,
  initTelemetry,
  shutdownTelemetry,
  startTelemetry,
  telemetryActive,
  withSpan,
} from "../src/server/telemetry";
import { stopServers, twoClones } from "./helpers/fixtures";

const OTEL_ENV = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "SPECDRIVEN_LOG_FILE",
  "SPECDRIVEN_LOG_DIR",
  "SPECDRIVEN_LOG_MAX_BYTES",
  "SPECDRIVEN_LOG_MAX_FILES",
] as const;
const savedEnv = new Map(OTEL_ENV.map((k) => [k, process.env[k]]));

afterEach(async () => {
  await shutdownTelemetry();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A live pipeline exporting into memory, for assertions. */
function startInMemory() {
  const spans = new InMemorySpanExporter();
  const logRecords = new InMemoryLogRecordExporter();
  startTelemetry({
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
  });
  return { spans, logRecords };
}

describe("withSpan", () => {
  test("is a safe no-op without a pipeline", async () => {
    expect(telemetryActive()).toBe(false);
    const result = await withSpan("noop", { a: 1 }, async () => "value");
    expect(result).toBe("value");
  });

  test("records nested spans with parentage and attributes", async () => {
    const { spans } = startInMemory();
    await withSpan("parent", { kind: "tick" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await withSpan("child", {}, async (span) => {
        span.setAttribute("file", "a.feature.md");
      });
    });
    // Only this test's trace: a span from work another test left running
    // must not land in the assertion.
    const parent = spans.getFinishedSpans().find((s) => s.name === "parent")!;
    const finished = spans
      .getFinishedSpans()
      .filter((s) => s.spanContext().traceId === parent.spanContext().traceId);
    expect(finished.map((s) => s.name).sort()).toEqual(["child", "parent"]);
    const child = finished.find((s) => s.name === "child")!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(parent.attributes["kind"]).toBe("tick");
    expect(child.attributes["file"]).toBe("a.feature.md");
  });

  test("records the exception, marks the span errored, and rethrows", async () => {
    const { spans } = startInMemory();
    await expect(
      withSpan("fails", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const span = spans.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.events.map((e) => e.name)).toContain("exception");
  });
});

describe("getLogger", () => {
  test("writes the established console format", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      getLogger("reload").info("pulled 3 file(s)", { files: 3, repo: "data x" });
    } finally {
      console.log = original;
    }
    expect(lines).toEqual(['[reload] pulled 3 file(s) files=3 repo="data x"']);
  });

  test("keeps debug off the console unless SPECDRIVEN_DEBUG is set", () => {
    const saved = process.env.SPECDRIVEN_DEBUG;
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      delete process.env.SPECDRIVEN_DEBUG;
      getLogger("automerge").debug("hidden");
      process.env.SPECDRIVEN_DEBUG = "1";
      getLogger("automerge").debug("shown");
    } finally {
      console.log = original;
      if (saved === undefined) delete process.env.SPECDRIVEN_DEBUG;
      else process.env.SPECDRIVEN_DEBUG = saved;
    }
    expect(lines).toEqual(["[automerge] shown"]);
  });

  test("mirrors entries to OTEL logs, correlated to the active span", async () => {
    const { logRecords } = startInMemory();
    let traceId = "";
    await withSpan("tick", {}, async (span) => {
      traceId = span.spanContext().traceId;
      getLogger("netsync").info("absorbed remote operations", { file: "a.feature.md" });
    });
    const records = logRecords.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.body).toBe("absorbed remote operations");
    expect(record.severityText).toBe("INFO");
    expect(record.attributes["file"]).toBe("a.feature.md");
    expect(record.spanContext?.traceId).toBe(traceId);
    expect(record.resource.attributes["service.name"]).toBe("specdriven");
  });

  test("debug records reach the OTEL sink even without SPECDRIVEN_DEBUG", () => {
    const saved = process.env.SPECDRIVEN_DEBUG;
    delete process.env.SPECDRIVEN_DEBUG;
    try {
      const { logRecords } = startInMemory();
      getLogger("automerge").debug("saved incremental chunk", { bytes: 42 });
      const records = logRecords.getFinishedLogRecords();
      expect(records).toHaveLength(1);
      expect(records[0]!.severityText).toBe("DEBUG");
    } finally {
      if (saved === undefined) delete process.env.SPECDRIVEN_DEBUG;
      else process.env.SPECDRIVEN_DEBUG = saved;
    }
  });
});

describe("initTelemetry", () => {
  test("stays inert without an OTLP endpoint", () => {
    for (const k of OTEL_ENV) delete process.env[k];
    expect(initTelemetry()).toBe(false);
    expect(telemetryActive()).toBe(false);
  });

  test("starts against a configured endpoint, exports, and is idempotent", async () => {
    // A stand-in OTLP collector, so the final flush has somewhere real to go.
    const posts: string[] = [];
    const collector = Bun.serve({
      port: 0,
      fetch: (req) => {
        posts.push(new URL(req.url).pathname);
        return new Response(null, { status: 200 });
      },
    });
    try {
      for (const k of OTEL_ENV) delete process.env[k];
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${collector.port}`;
      expect(initTelemetry()).toBe(true);
      expect(telemetryActive()).toBe(true);
      expect(initTelemetry()).toBe(true);
      await withSpan("exported", {}, async () => {});
      await shutdownTelemetry(); // flushes the batch processors
      expect(posts).toContain("/v1/traces");
      expect(posts).toContain("/v1/logs"); // the "export enabled" log record
    } finally {
      collector.stop(true);
    }
  });

  test("respects the OTEL_SDK_DISABLED off switch", () => {
    for (const k of OTEL_ENV) delete process.env[k];
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(initTelemetry()).toBe(false);
    expect(telemetryActive()).toBe(false);
  });

  test("an endpoint that is not an http(s) url is ignored, not exported to", () => {
    for (const k of OTEL_ENV) delete process.env[k];
    // Seen in the wild: a profile exporting `…_ENDPOINT=true`.
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "true";
    expect(initTelemetry()).toBe(false);
    expect(telemetryActive()).toBe(false);
  });
});

describe("shutdownTelemetry", () => {
  test("restores the inert no-op globals", async () => {
    const { spans } = startInMemory();
    await withSpan("before", {}, async () => {});
    expect(spans.getFinishedSpans()).toHaveLength(1);
    await shutdownTelemetry();
    expect(telemetryActive()).toBe(false);
    // Shutdown clears the in-memory exporter; a span after shutdown must not
    // reach it either.
    await withSpan("after", {}, async () => {});
    expect(spans.getFinishedSpans()).toHaveLength(0);
    expect(trace.getTracerProvider().constructor.name).not.toBe("BasicTracerProvider");
  });
});

describe("errorAttributes", () => {
  test("maps Errors and non-Errors to exception attributes", () => {
    const attrs = errorAttributes(new Error("boom"));
    expect(attrs["exception.type"]).toBe("Error");
    expect(attrs["exception.message"]).toBe("boom");
    expect(typeof attrs["exception.stacktrace"]).toBe("string");
    expect(errorAttributes("plain")).toEqual({ "exception.message": "plain" });
  });
});

describe("file sink", () => {
  const logPath = (dir: string) => join(dir, "specdriven.log");

  /** Point the sink at a fresh temp dir; unset the preload's off switch. */
  async function fileSinkDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "specdriven-otel-logs-"));
    delete process.env.SPECDRIVEN_LOG_FILE; // absent = on (the default)
    process.env.SPECDRIVEN_LOG_DIR = dir;
    return dir;
  }

  test("is on by default and records every level, debug included", async () => {
    const dir = await fileSinkDir();
    try {
      getLogger("reload").info("pulled", { files: 2 });
      getLogger("automerge").debug("saved chunk", { bytes: 42 });
      getLogger("netsync").error("boom");
      const lines = (await Bun.file(logPath(dir)).text()).trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z INFO {2}\[reload\] pulled files=2$/);
      expect(lines[1]).toContain("DEBUG [automerge] saved chunk bytes=42");
      expect(lines[2]).toContain("ERROR [netsync] boom");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SPECDRIVEN_LOG_FILE=0 turns the file sink off", async () => {
    const dir = await fileSinkDir();
    try {
      process.env.SPECDRIVEN_LOG_FILE = "0";
      getLogger("reload").info("not on disk");
      expect(await Bun.file(logPath(dir)).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rotates by size and drops the oldest file past the limit", async () => {
    const dir = await fileSinkDir();
    try {
      process.env.SPECDRIVEN_LOG_MAX_BYTES = "1"; // every line rotates
      process.env.SPECDRIVEN_LOG_MAX_FILES = "3";
      const log = getLogger("rotate");
      for (const n of [1, 2, 3, 4, 5]) log.info(`line ${n}`);
      expect(await Bun.file(logPath(dir)).text()).toContain("line 5");
      expect(await Bun.file(`${logPath(dir)}.1`).text()).toContain("line 4");
      expect(await Bun.file(`${logPath(dir)}.2`).text()).toContain("line 3");
      expect(await Bun.file(`${logPath(dir)}.3`).exists()).toBe(false); // dropped
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lines inside a traced span carry trace and span ids", async () => {
    const dir = await fileSinkDir();
    try {
      const { spans } = startInMemory();
      await withSpan("tick", {}, async () => {
        getLogger("reload").info("inside");
      });
      const finished = spans.getFinishedSpans()[0]!;
      const line = (await Bun.file(logPath(dir)).text()).trim();
      expect(line).toContain(`trace=${finished.spanContext().traceId}`);
      expect(line).toContain(`span=${finished.spanContext().spanId}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sync instrumentation", () => {
  test("importDrift traces the drift pass and the document import under it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "specdriven-otel-drift-"));
    try {
      await writeFile(join(dir, "a.feature.md"), "# A\n\n## S @v1\n\nbody\n");
      const { spans } = startInMemory();
      await importDrift(dir);
      const finished = spans.getFinishedSpans();
      const drift = finished.find((s) => s.name === "sync.import_drift")!;
      const create = finished.find((s) => s.name === "automerge.create_doc")!;
      expect(drift.attributes["sync.imported"]).toBe(1);
      expect(create.attributes["specdriven.file"]).toBe("a.feature.md");
      expect(create.parentSpanContext?.spanId).toBe(drift.spanContext().spanId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a sync tick traces pull, drift and push as one trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "specdriven-otel-tick-"));
    try {
      const { a } = await twoClones(root, {
        "seed.feature.md": "# Seed\n\n## Story @v1 [proposed]\n\n- line\n",
      });
      const { spans } = startInMemory();
      await syncDataDir(a);
      const finished = spans.getFinishedSpans();
      const names = finished.map((s) => s.name);
      expect(names).toContain("sync.tick");
      expect(names).toContain("git.pull");
      expect(names).toContain("sync.import_drift");
      expect(names).toContain("git.sync_saved_changes");
      const tick = finished.find((s) => s.name === "sync.tick")!;
      // Every step of the tick belongs to the tick's trace.
      for (const name of ["git.pull", "sync.import_drift", "git.sync_saved_changes"]) {
        const child = finished.find((s) => s.name === name)!;
        expect(child.spanContext().traceId).toBe(tick.spanContext().traceId);
      }
      expect(tick.attributes["sync.pull.ok"]).toBe(true);
      // The tick imported the seed and pushed the new document chunks.
      expect(tick.attributes["sync.pushed"]).toBe(true);
    } finally {
      stopServers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
