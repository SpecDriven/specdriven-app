// The Data page's client half (src/frontend/DataPage.tsx): the shapes
// /api/data/* answers with (src/server/dataViewer.ts) and the pure helpers
// the page builds its requests and cells from.

import type { Patch } from "@automerge/automerge";
import type {
  CellValue,
  ChangeSummary,
  ColumnDef,
  DocAtResponse,
  DocMeta,
  DocResponse,
  HistoryPage,
  SortDir,
  TableName,
  TablePage,
  TableRow,
  TableSummary,
  TablesResponse,
} from "../server/dataViewer";

export type {
  CellValue,
  ChangeSummary,
  ColumnDef,
  DocAtResponse,
  DocMeta,
  DocResponse,
  HistoryPage,
  SortDir,
  TableName,
  TablePage,
  TableRow,
  TableSummary,
  TablesResponse,
};

export const PAGE_SIZE = 100;
export const HISTORY_PAGE_SIZE = 50;

export interface RowsQuery {
  q: string;
  sort: string | null;
  dir: SortDir;
  offset: number;
}

export const DEFAULT_QUERY: RowsQuery = { q: "", sort: null, dir: "asc", offset: 0 };

function withParams(path: string, params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `${path}?${s}` : path;
}

export function tablesUrl(refresh = false): string {
  return withParams("/api/data/tables", { refresh: refresh ? 1 : null });
}

/** Defaults are left out of the url, like logsUrl. */
export function tableUrl(table: TableName, query: RowsQuery): string {
  return withParams(`/api/data/tables/${table}`, {
    q: query.q.trim(),
    sort: query.sort,
    dir: query.sort && query.dir !== "asc" ? query.dir : null,
    offset: query.offset || null,
    limit: PAGE_SIZE,
  });
}

export function docUrl(dirRel: string): string {
  return withParams("/api/data/doc", { path: dirRel });
}

export function historyUrl(dirRel: string, offset = 0): string {
  return withParams("/api/data/doc/history", { path: dirRel, offset: offset || null, limit: HISTORY_PAGE_SIZE });
}

export function atUrl(dirRel: string, hash: string): string {
  return withParams("/api/data/doc/at", { path: dirRel, heads: hash });
}

const SUMMARY_MAX = 80;

/** What a cell shows in the grid: a scalar as text, a nested value as a summary. */
export function cellText(cell: CellValue): string {
  if (cell === null) return "";
  if (typeof cell === "object") {
    const v = cell.json;
    if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.length}] ${clip(JSON.stringify(v))}`;
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      return keys.length === 0 ? "{}" : `{${keys.length}} ${clip(JSON.stringify(v))}`;
    }
    return clip(JSON.stringify(v));
  }
  return clip(String(cell));
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line;
}

/** The whole value, for a cell's tooltip. */
export function cellTitle(cell: CellValue): string {
  if (cell === null) return "null";
  if (typeof cell === "object") return JSON.stringify(cell.json, null, 2);
  return String(cell);
}

/** The cells of a row as the nested value they came from, for the tree. */
export function rowValue(row: TableRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.cells)) out[k] = v !== null && typeof v === "object" ? v.json : v;
  return out;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** A change's time, which Automerge keeps in seconds; "—" when it has none. */
export function changeTime(time: number): string {
  if (!time) return "—";
  const d = new Date(time * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pathText(path: (string | number)[]): string {
  return `/${path.join("/")}`;
}

/** One line per patch: what the change did, where. */
export function patchLine(patch: Patch): string {
  switch (patch.action) {
    case "put":
      return `put ${pathText(patch.path)} = ${clip(JSON.stringify(patch.value))}`;
    case "del":
      return `del ${pathText(patch.path)}${patch.length !== undefined && patch.length > 1 ? ` ×${patch.length}` : ""}`;
    case "insert":
      return `insert ${pathText(patch.path)} ${clip(JSON.stringify(patch.values))}`;
    case "splice":
      return `splice ${pathText(patch.path)} ${clip(JSON.stringify(patch.value))}`;
    case "inc":
      return `inc ${pathText(patch.path)} by ${patch.value}`;
    case "mark":
      return `mark ${pathText(patch.path)}`;
    case "unmark":
      return `unmark ${pathText(patch.path)} ${patch.name}`;
    case "conflict":
      return `conflict ${pathText(patch.path)}`;
    default:
      return clip(JSON.stringify(patch));
  }
}

/** A count with thousands separators — "1,431" — as the toolbar and the table list show it. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
