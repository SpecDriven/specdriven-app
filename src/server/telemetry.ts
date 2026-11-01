// OpenTelemetry support and the server's logging facade. Telemetry is off by
// default and configured entirely through the standard OTEL environment
// variables — no Settings entry, since exporting telemetry is an operator
// concern, not a workspace preference:
//
//   OTEL_EXPORTER_OTLP_ENDPOINT          collector base url, e.g. http://localhost:4318
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   per-signal override (traces only)
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT     per-signal override (logs only)
//   OTEL_SERVICE_NAME                    service.name, default "specdriven"
//   OTEL_SDK_DISABLED=true               hard off switch
//
// With an endpoint configured, initTelemetry() starts an OTLP/HTTP pipeline:
// batched spans and log records, resource-stamped with the service name and
// app version. Without one, every span and log record emitted through this
// module is a cheap no-op — instrumented code never has to check.
//
// getLogger(component) is the one way server code logs. It always writes to
// the console in the established `[component] message` format, and mirrors
// each entry to OTEL logs when the pipeline is up, correlated to the active
// span. Debug entries reach the console only when SPECDRIVEN_DEBUG is set;
// the OTEL sink receives them whenever it is running.
//
// Every entry (debug included) also lands in a rotating log file, on by
// default so the packaged desktop app — whose stdout goes nowhere — still
// leaves a trail:
//
//   SPECDRIVEN_LOG_DIR        directory, default $SPECDRIVEN_HOME/logs
//                             (~/.specdriven/logs) — specdriven.log, .1 … .N
//   SPECDRIVEN_LOG_MAX_BYTES  rotate size, default 5 MB
//   SPECDRIVEN_LOG_MAX_FILES  files kept including the current, default 5
//   SPECDRIVEN_LOG_FILE=0     turns file logging off
//
// Verbosity is adjustable while the app runs (the Observability page,
// src/frontend/ObservabilityPage.tsx): a global minimum level plus
// per-component overrides. An entry below its component's level goes to no
// sink at all. SPECDRIVEN_LOG_LEVEL sets the starting global level (default
// debug, i.e. everything); the saved settings replace it at startup. The
// latest entries are also kept in memory, so the page has something to show
// when the file sink is off.
//
// Pure-JS dependencies only — like the automerge store, this runs under both
// Bun and Electron's Node runtime.

import { context, isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import type { AnyValueMap, Logger as OtelLogger } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { version } from "../../package.json";

const SERVICE_NAME = "specdriven";

/**
 * Fetched per use, not cached: a tracer obtained through the api proxy pins
 * its delegate at first use, which would strand spans on a stopped provider
 * after a shutdown/start cycle (tests cycle pipelines; production could too).
 */
function tracer() {
  return trace.getTracer(SERVICE_NAME, version);
}

interface RunningTelemetry {
  tracerProvider: BasicTracerProvider;
  loggerProvider: LoggerProvider;
}

/**
 * The running pipeline lives on globalThis, not in module state: under
 * `bun --hot` every edit re-evaluates this module, and a module-local
 * variable would forget the old pipeline — each reload would then stack
 * another exporter (and its retry timers) onto the process. One process,
 * one pipeline, however many times the module loads.
 */
const RUNNING = Symbol.for("specdriven.telemetry.running");

function getRunning(): RunningTelemetry | null {
  return ((globalThis as Record<symbol, unknown>)[RUNNING] as RunningTelemetry | null) ?? null;
}

function setRunning(value: RunningTelemetry | null): void {
  (globalThis as Record<symbol, unknown>)[RUNNING] = value;
}

/** Whether a telemetry pipeline is currently exporting. */
export function telemetryActive(): boolean {
  return getRunning() !== null;
}

/**
 * Endpoint a signal would export to, from the standard OTEL variables. A
 * value that is not an http(s) url (say, a stray `=true` in a profile) is
 * reported and treated as unset rather than starting a doomed exporter.
 */
function envEndpoint(signal: "TRACES" | "LOGS"): string | null {
  const url = (
    process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    ""
  ).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    console.warn(`[telemetry] ignoring OTLP ${signal.toLowerCase()} endpoint (not an http(s) url): ${url}`);
    return null;
  }
  return url;
}

export interface TelemetryOptions {
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
  serviceName?: string;
}

/**
 * Start a telemetry pipeline with explicit processors (tests hand in
 * in-memory exporters). Production goes through initTelemetry(), which
 * builds OTLP processors from the environment. No-op when already running.
 */
export function startTelemetry(options: TelemetryOptions = {}): void {
  if (getRunning()) return;
  const resource = resourceFromAttributes({
    // Literal keys, standard per the OTEL semantic conventions — not worth a
    // dependency on @opentelemetry/semantic-conventions for two strings.
    "service.name": options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
    "service.version": version,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: options.spanProcessors ?? [],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: options.logRecordProcessors ?? [],
  });
  // The async-hooks context manager is what parents a child span (or a log
  // record) to the span active across an await boundary.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  setRunning({ tracerProvider, loggerProvider });
  otelLoggers.clear();
}

/** On globalThis for the same hot-reload reason as the running pipeline. */
const HOOKS = Symbol.for("specdriven.telemetry.hooks");

/**
 * Flush the last batch on the ways a server process actually ends: signals
 * (the web app under Bun) and a draining event loop. Installed only once a
 * pipeline runs, so without OTEL configured process behavior is untouched.
 * Adding a signal listener replaces the default exit — the handler must
 * exit itself, with the conventional 128+signal code.
 */
function installShutdownHooks(): void {
  const flags = globalThis as Record<symbol, unknown>;
  if (flags[HOOKS]) return;
  flags[HOOKS] = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      void shutdownTelemetry().finally(() => process.exit(code));
    });
  }
  process.on("beforeExit", () => {
    // The pending flush keeps the loop alive until it completes.
    void shutdownTelemetry();
  });
}

/**
 * Start the OTLP/HTTP pipeline when the environment configures an endpoint;
 * false (and fully inert telemetry) when it doesn't. Safe to call more than
 * once. The exporters read the OTEL_EXPORTER_OTLP_* variables themselves —
 * the environment only decides here whether each signal runs at all.
 */
export function initTelemetry(): boolean {
  if (getRunning()) return true;
  if ((process.env.OTEL_SDK_DISABLED || "").trim().toLowerCase() === "true") return false;
  const traces = envEndpoint("TRACES");
  const logRecords = envEndpoint("LOGS");
  if (!traces && !logRecords) return false;
  startTelemetry({
    spanProcessors: traces ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [],
    logRecordProcessors: logRecords
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
      : [],
  });
  installShutdownHooks();
  getLogger("telemetry").info("OpenTelemetry export enabled", {
    "otel.traces_endpoint": traces ?? "off",
    "otel.logs_endpoint": logRecords ?? "off",
  });
  return true;
}

/**
 * Flush and stop the pipeline, restoring the inert no-op globals. The entry
 * points call this on shutdown so the last batch of spans and log records
 * reaches the collector.
 */
export async function shutdownTelemetry(): Promise<void> {
  const active = getRunning();
  if (!active) return;
  setRunning(null);
  otelLoggers.clear();
  // Globals go inert first, synchronously: nothing new enters the stopping
  // pipeline, and a following startTelemetry can register cleanly even while
  // the final flush is still on the wire.
  trace.disable();
  logs.disable();
  context.disable();
  await Promise.all([active.tracerProvider.shutdown(), active.loggerProvider.shutdown()]);
}

/**
 * Run fn inside an active span. Exceptions are recorded on the span, mark it
 * errored, and rethrow — the helper never swallows. With no pipeline running
 * this degrades to just calling fn.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Standard exception attributes for a caught error, for logs and spans. */
export function errorAttributes(e: unknown): Attributes {
  if (e instanceof Error) {
    const attrs: Attributes = { "exception.type": e.name, "exception.message": e.message };
    if (e.stack) attrs["exception.stacktrace"] = e.stack;
    return attrs;
  }
  return { "exception.message": String(e) };
}

export interface ComponentLogger {
  /** Console only when SPECDRIVEN_DEBUG is set; always mirrored to OTEL. */
  debug(message: string, attributes?: Attributes): void;
  info(message: string, attributes?: Attributes): void;
  warn(message: string, attributes?: Attributes): void;
  error(message: string, attributes?: Attributes): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
type Level = LogLevel;

/** Least to most severe. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

const SEVERITY: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const CONSOLE: Record<Level, (line: string) => void> = {
  debug: (line) => console.log(line),
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

function debugToConsole(): boolean {
  const v = (process.env.SPECDRIVEN_DEBUG || "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/**
 * ` key=value …` suffix for a log line; "" without attributes. The console
 * keeps its one-line format by dropping exception.stacktrace; the file line
 * keeps the stack, newline-escaped by JSON.stringify.
 */
function formatAttributes(attributes: Attributes | undefined, { stacks = false } = {}): string {
  if (!attributes) return "";
  const parts = Object.entries(attributes)
    .filter(([, v]) => v !== undefined)
    .filter(([k]) => stacks || k !== "exception.stacktrace")
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

// ---------------------------------------------------------------------------
// Rotating file sink. Writes are synchronous on purpose: entries stay ordered
// across concurrent async work, nothing buffered is lost on a hard exit, and
// the volume here (sync ticks, document writes) is far too low for the
// blocking to matter.

const LOG_FILE = "specdriven.log";
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_MAX_FILES = 5;

function fileLoggingEnabled(): boolean {
  const v = (process.env.SPECDRIVEN_LOG_FILE || "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** The log directory: SPECDRIVEN_LOG_DIR, else <settings home>/logs. */
function logDir(): string {
  const explicit = (process.env.SPECDRIVEN_LOG_DIR || "").trim();
  if (explicit) return explicit;
  // Same anchor as the settings-file fallback (state.ts homeStatePath), so
  // web and desktop runs of one machine log to one predictable place.
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), ".specdriven"), "logs");
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Directories mkdir'd once, and ones that failed — warned once, then quiet. */
const ensuredDirs = new Set<string>();
const brokenDirs = new Set<string>();

/**
 * specdriven.log → specdriven.log.1 → … → specdriven.log.N-1, oldest dropped.
 * Every step tolerates a missing file or a concurrent process rotating the
 * same directory — rotation is best-effort, never a reason to lose the line.
 */
function rotate(file: string, maxFiles: number): void {
  if (maxFiles <= 1) {
    rmSync(file, { force: true });
    return;
  }
  rmSync(`${file}.${maxFiles - 1}`, { force: true });
  for (let i = maxFiles - 2; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // that slot doesn't exist yet
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // another process rotated first
  }
}

function writeLogLine(line: string): void {
  if (!fileLoggingEnabled()) return;
  const dir = logDir();
  if (brokenDirs.has(dir)) return;
  try {
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    const file = join(dir, LOG_FILE);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no current file yet
    }
    if (size >= envInt("SPECDRIVEN_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES)) {
      rotate(file, envInt("SPECDRIVEN_LOG_MAX_FILES", DEFAULT_LOG_MAX_FILES));
    }
    appendFileSync(file, `${line}\n`);
  } catch (e) {
    // An unwritable directory must not take the app down or spam the
    // console — one warning, then the file sink stays off for that dir.
    brokenDirs.add(dir);
    ensuredDirs.delete(dir);
    console.warn(`[telemetry] file logging to ${dir} disabled: ${(e as Error).message}`);
  }
}

/** ` trace=… span=…` when a real span is active, for grep-to-trace jumps. */
function traceSuffix(): string {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return "";
  return ` trace=${spanContext.traceId} span=${spanContext.spanId}`;
}

function fileLine(
  level: Level,
  component: string,
  message: string,
  attributes?: Attributes,
): string {
  const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}]`;
  return `${head} ${message}${formatAttributes(attributes, { stacks: true })}${traceSuffix()}`;
}

// ---------------------------------------------------------------------------
// Verbosity, the in-memory tail and where the entries can be read back — all
// on globalThis for the same hot-reload reason as the running pipeline.

export interface LogVerbosity {
  /** The minimum level for components without an override. */
  level: LogLevel;
  /** Per-component minimum levels, overriding `level`. */
  components: Record<string, LogLevel>;
}

const VERBOSITY = Symbol.for("specdriven.telemetry.verbosity");
const COMPONENTS = Symbol.for("specdriven.telemetry.components");
const MEMORY = Symbol.for("specdriven.telemetry.memory");

/** Lines kept in memory, newest last. */
export const MEMORY_LOG_LINES = 2000;

function envLogLevel(): LogLevel {
  const v = (process.env.SPECDRIVEN_LOG_LEVEL || "").trim().toLowerCase();
  return isLogLevel(v) ? v : "debug";
}

function verbosityState(): LogVerbosity {
  const flags = globalThis as Record<symbol, unknown>;
  flags[VERBOSITY] ??= { level: envLogLevel(), components: {} };
  return flags[VERBOSITY] as LogVerbosity;
}

/** The current verbosity, a copy. */
export function logVerbosity(): LogVerbosity {
  const v = verbosityState();
  return { level: v.level, components: { ...v.components } };
}

/**
 * Change the verbosity: `level` replaces the global minimum, `components`
 * replaces the whole override map. Invalid levels are dropped, not applied.
 */
export function setLogVerbosity(change: { level?: unknown; components?: unknown }): LogVerbosity {
  const v = verbosityState();
  if (isLogLevel(change.level)) v.level = change.level;
  if (change.components && typeof change.components === "object" && !Array.isArray(change.components)) {
    v.components = Object.fromEntries(
      Object.entries(change.components as Record<string, unknown>).filter(
        (entry): entry is [string, LogLevel] => entry[0] !== "" && isLogLevel(entry[1]),
      ),
    );
  }
  return logVerbosity();
}

/** Back to SPECDRIVEN_LOG_LEVEL (or debug) with no overrides — for tests. */
export function resetLogVerbosity(): void {
  (globalThis as Record<symbol, unknown>)[VERBOSITY] = { level: envLogLevel(), components: {} };
}

/** The minimum level an entry of this component needs to be recorded. */
export function effectiveLogLevel(component: string): LogLevel {
  const v = verbosityState();
  return v.components[component] ?? v.level;
}

function knownComponents(): Set<string> {
  const flags = globalThis as Record<symbol, unknown>;
  flags[COMPONENTS] ??= new Set<string>();
  return flags[COMPONENTS] as Set<string>;
}

/** Every component a logger was created for, sorted. */
export function logComponents(): string[] {
  return [...knownComponents()].sort();
}

function memoryLines(): string[] {
  const flags = globalThis as Record<symbol, unknown>;
  flags[MEMORY] ??= [];
  return flags[MEMORY] as string[];
}

function rememberLine(line: string): void {
  const lines = memoryLines();
  lines.push(line);
  if (lines.length > MEMORY_LOG_LINES) lines.splice(0, lines.length - MEMORY_LOG_LINES);
}

/** Where recorded entries can be read back from. */
export type LogSource =
  | { kind: "file"; dir: string; /** Newest first: specdriven.log, .1, … */ files: string[] }
  | { kind: "memory"; /** Oldest first. */ lines: readonly string[] };

/**
 * The log files while the file sink is writing, else the in-memory tail —
 * the same line format either way.
 */
export function logSource(): LogSource {
  const dir = logDir();
  if (!fileLoggingEnabled() || brokenDirs.has(dir)) return { kind: "memory", lines: [...memoryLines()] };
  const file = join(dir, LOG_FILE);
  const files = [file];
  const maxFiles = envInt("SPECDRIVEN_LOG_MAX_FILES", DEFAULT_LOG_MAX_FILES);
  for (let i = 1; i < maxFiles; i++) files.push(`${file}.${i}`);
  return { kind: "file", dir, files };
}

/** api-logs getLogger is documented as non-trivial; fetch each once. */
const otelLoggers = new Map<string, OtelLogger>();

function otelLogger(component: string): OtelLogger {
  let logger = otelLoggers.get(component);
  if (!logger) {
    logger = logs.getLogger(component, version);
    otelLoggers.set(component, logger);
  }
  return logger;
}

/**
 * The logger server code writes through, named after the component the way
 * existing console output already is ("[reload] …", "[netsync] …").
 */
export function getLogger(component: string): ComponentLogger {
  knownComponents().add(component);
  const emit = (level: Level, message: string, attributes?: Attributes) => {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(effectiveLogLevel(component))) return;
    if (level !== "debug" || debugToConsole()) {
      CONSOLE[level](`[${component}] ${message}${formatAttributes(attributes)}`);
    }
    const line = fileLine(level, component, message, attributes);
    rememberLine(line);
    writeLogLine(line);
    otelLogger(component).emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      // api 1.10 widened Attributes values to unknown; api-logs still types
      // them narrowly. What we log is always the simple-value subset.
      attributes: attributes as AnyValueMap | undefined,
    });
  };
  return {
    debug: (message, attributes) => emit("debug", message, attributes),
    info: (message, attributes) => emit("info", message, attributes),
    warn: (message, attributes) => emit("warn", message, attributes),
    error: (message, attributes) => emit("error", message, attributes),
  };
}
