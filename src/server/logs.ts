// Observability (src/frontend/ObservabilityPage.tsx): reading the app's own
// log back, and changing how much of it is written. The entries come from
// the rotating log files the telemetry module writes (or, with the file sink
// off, from its in-memory tail), parsed back out of their one-line format:
//
//   2026-09-26T10:00:00.000Z INFO  [netsync] message key="value" trace=… span=…
//
// Verbosity — a global minimum level plus per-component overrides — applies
// at once and is saved to the settings file, so the next run starts with it.

import { readFile } from "node:fs/promises";
import { isDemoMode } from "./demoMode";
import { bodyOf, json, type Handler } from "./http";
import { getAppRoot } from "./paths";
import { readState, writeState } from "./state";
import {
  LOG_LEVELS,
  isLogLevel,
  logComponents,
  logSource,
  logVerbosity,
  setLogVerbosity,
  telemetryActive,
  type LogLevel,
  type LogVerbosity,
} from "./telemetry";

export interface LogEntry {
  time: string;
  level: LogLevel;
  component: string;
  message: string;
  /** Attribute values as written — JSON strings come back unquoted. */
  attributes: Record<string, string>;
  traceId?: string;
  spanId?: string;
}

const LINE = /^(\S+) (DEBUG|INFO|WARN|ERROR) *\[([^\]]*)\] ?(.*)$/;
const TRACE = / trace=([0-9a-f]{32}) span=([0-9a-f]{16})$/;
/** One trailing ` key=value`; a value is a JSON string or a bare token. */
const TRAILING_ATTR = / ([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|[^\s"]+)$/;

/** A log line back into its parts; null for a line not in the format. */
export function parseLogLine(line: string): LogEntry | null {
  const m = line.match(LINE);
  if (!m) return null;
  let rest = m[4]!;
  const entry: LogEntry = {
    time: m[1]!,
    level: m[2]!.toLowerCase() as LogLevel,
    component: m[3]!,
    message: "",
    attributes: {},
  };
  const t = rest.match(TRACE);
  if (t) {
    entry.traceId = t[1];
    entry.spanId = t[2];
    rest = rest.slice(0, t.index);
  }
  // Attributes are peeled off the end, so a message that itself contains
  // `a=b` keeps it unless it is the very last thing on the line.
  const attrs: [string, string][] = [];
  for (let a = rest.match(TRAILING_ATTR); a; a = rest.match(TRAILING_ATTR)) {
    let value = a[2]!;
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // kept as written
      }
    }
    attrs.unshift([a[1]!, value]);
    rest = rest.slice(0, a.index);
  }
  entry.message = rest;
  entry.attributes = Object.fromEntries(attrs);
  return entry;
}

export interface LogQuery {
  /** Text to find in the whole line, case-insensitive. */
  q?: string;
  /** Treat `q` as a regular expression. */
  regex?: boolean;
  /** The least severe level shown. */
  level?: LogLevel;
  /** Only these components; empty or absent means all. */
  components?: string[];
  /** Most entries returned, newest first. */
  limit?: number;
}

export interface LogPage {
  entries: LogEntry[];
  /** More matches exist past `limit`. */
  more: boolean;
  /** Lines read to answer. */
  scanned: number;
}

export const DEFAULT_LOG_LIMIT = 500;
export const MAX_LOG_LIMIT = 5000;

/** The line test for `q`; throws on an invalid regular expression. */
function matcher(q: string | undefined, regex: boolean | undefined): (line: string) => boolean {
  const text = (q ?? "").trim();
  if (!text) return () => true;
  if (regex) {
    const re = new RegExp(text, "i");
    return (line) => re.test(line);
  }
  const needle = text.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

/** The source's lines, newest first, one file at a time. */
async function* newestFirst(): AsyncGenerator<string> {
  const source = logSource();
  if (source.kind === "memory") {
    for (let i = source.lines.length - 1; i >= 0; i--) yield source.lines[i]!;
    return;
  }
  for (const file of source.files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // not rotated that far yet
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) yield lines[i]!;
  }
}

/** The newest entries matching the query. */
export async function queryLogs(query: LogQuery = {}): Promise<LogPage> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LOG_LIMIT)), MAX_LOG_LIMIT);
  const minRank = LOG_LEVELS.indexOf(query.level ?? "debug");
  const components = new Set(query.components ?? []);
  const matches = matcher(query.q, query.regex);
  const entries: LogEntry[] = [];
  let scanned = 0;
  for await (const line of newestFirst()) {
    scanned++;
    // The cheap text test first: most lines fail it while searching.
    if (!matches(line)) continue;
    const entry = parseLogLine(line);
    if (!entry) continue;
    if (LOG_LEVELS.indexOf(entry.level) < minRank) continue;
    if (components.size > 0 && !components.has(entry.component)) continue;
    if (entries.length === limit) return { entries, more: true, scanned };
    entries.push(entry);
  }
  return { entries, more: false, scanned };
}

// ---------------------------------------------------------------------------
// Settings: what the page's Verbosity section shows and changes.

export interface LogSettings extends LogVerbosity {
  levels: readonly LogLevel[];
  /** Components that have logged (or can log) this run. */
  known: string[];
  /** Where entries are read from: the log directory, or memory. */
  source: { kind: "file"; dir: string } | { kind: "memory" };
  /** Whether entries are also exported over OTLP. */
  otel: boolean;
}

export function logSettings(): LogSettings {
  const verbosity = logVerbosity();
  const source = logSource();
  return {
    ...verbosity,
    levels: LOG_LEVELS,
    known: [...new Set([...logComponents(), ...Object.keys(verbosity.components)])].sort(),
    source: source.kind === "file" ? { kind: "file", dir: source.dir } : { kind: "memory" },
    otel: telemetryActive(),
  };
}

/** The saved verbosity in the settings file, as setLogVerbosity takes it. */
export function savedVerbosity(state: { logLevel?: unknown; logLevels?: unknown }) {
  return { level: state.logLevel, components: state.logLevels };
}

const DEMO_REFUSAL = { error: "Logs are not available in demo mode" };

export const getLogs: Handler = async (req) => {
  if (isDemoMode()) return json(DEMO_REFUSAL, 403);
  const params = new URL(req.url).searchParams;
  const level = params.get("level");
  if (level !== null && !isLogLevel(level)) return json({ error: `level must be one of ${LOG_LEVELS.join(", ")}` }, 400);
  const limit = Number(params.get("limit") ?? DEFAULT_LOG_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) return json({ error: "limit must be a positive number" }, 400);
  const components = (params.get("components") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  try {
    return json(
      await queryLogs({
        q: params.get("q") ?? undefined,
        regex: params.get("regex") === "1",
        level: level ?? undefined,
        components,
        limit,
      }),
    );
  } catch (e) {
    if (e instanceof SyntaxError) return json({ error: `Invalid regular expression: ${e.message}` }, 400);
    throw e;
  }
};

export const getLogSettings: Handler = () =>
  isDemoMode() ? json(DEMO_REFUSAL, 403) : json(logSettings());

export const putLogSettings: Handler = async (req) => {
  if (isDemoMode()) return json(DEMO_REFUSAL, 403);
  let body: Record<string, unknown>;
  try {
    body = await bodyOf(req);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  if (body.level !== undefined && !isLogLevel(body.level)) {
    return json({ error: `level must be one of ${LOG_LEVELS.join(", ")}` }, 400);
  }
  if (body.components !== undefined) {
    const c = body.components;
    if (!c || typeof c !== "object" || Array.isArray(c) || !Object.values(c).every(isLogLevel)) {
      return json({ error: "components must map component names to levels" }, 400);
    }
  }
  const applied = setLogVerbosity({ level: body.level, components: body.components });
  const root = getAppRoot();
  const state = await readState(root);
  state.logLevel = applied.level;
  if (Object.keys(applied.components).length > 0) state.logLevels = applied.components;
  else delete state.logLevels;
  await writeState(state, root);
  return json(logSettings());
};
