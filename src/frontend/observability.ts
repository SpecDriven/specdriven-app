// The Observability page's client half (src/frontend/ObservabilityPage.tsx):
// the shapes /api/logs and /api/logs/settings answer with (src/server/logs.ts)
// and the pure helpers the page builds its requests and rows from.

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogEntry {
  time: string;
  level: LogLevel;
  component: string;
  message: string;
  attributes: Record<string, string>;
  traceId?: string;
  spanId?: string;
}

export interface LogPage {
  entries: LogEntry[];
  more: boolean;
  scanned: number;
}

export interface LogSettings {
  level: LogLevel;
  components: Record<string, LogLevel>;
  levels: readonly LogLevel[];
  known: string[];
  source: { kind: "file"; dir: string } | { kind: "memory" };
  otel: boolean;
}

export interface LogFilter {
  q: string;
  regex: boolean;
  /** The least severe level shown. */
  level: LogLevel;
  /** "" for every component. */
  component: string;
  limit: number;
}

export const PAGE_SIZE = 500;

export const DEFAULT_FILTER: LogFilter = { q: "", regex: false, level: "debug", component: "", limit: PAGE_SIZE };

/** What a level means as a minimum, for the filter and verbosity selects. */
export function minimumLabel(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "Everything (debug)";
    case "info":
      return "Info and above";
    case "warn":
      return "Warnings and errors";
    case "error":
      return "Errors only";
  }
}

/** `/api/logs?…` for a filter; defaults are left out of the url. */
export function logsUrl(filter: LogFilter): string {
  const params = new URLSearchParams();
  const q = filter.q.trim();
  if (q) params.set("q", q);
  if (q && filter.regex) params.set("regex", "1");
  if (filter.level !== "debug") params.set("level", filter.level);
  if (filter.component) params.set("components", filter.component);
  params.set("limit", String(filter.limit));
  return `/api/logs?${params}`;
}

/**
 * The pattern whose matches are marked in the rows: the search text as a
 * regular expression or literally, case-insensitive. Null without a search,
 * or for a regular expression that doesn't compile (the server says why).
 */
export function searchPattern(q: string, regex: boolean): RegExp | null {
  const text = q.trim();
  if (!text) return null;
  try {
    return new RegExp(regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return null;
  }
}

/**
 * `text` cut into plain and matching runs, in order. A pattern that can
 * match the empty string marks nothing rather than looping.
 */
export function splitMatches(text: string, pattern: RegExp | null): { text: string; match: boolean }[] {
  if (!pattern) return [{ text, match: false }];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") break;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `HH:MM:SS.mmm` local time; the raw value when it isn't a date. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `YYYY-MM-DD` local date, for the day separators. */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The entry as one line again, for copying. */
export function entryLine(entry: LogEntry): string {
  const attrs = Object.entries(entry.attributes)
    .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`)
    .join("");
  const trace = entry.traceId ? ` trace=${entry.traceId} span=${entry.spanId}` : "";
  return `${entry.time} ${entry.level.toUpperCase()} [${entry.component}] ${entry.message}${attrs}${trace}`;
}

/** The components the filter offers: the known ones and any seen in results. */
export function componentChoices(settings: LogSettings | null, entries: LogEntry[]): string[] {
  return [...new Set([...(settings?.known ?? []), ...entries.map((e) => e.component)])].sort();
}
