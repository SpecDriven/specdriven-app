// The data viewer (specs/app/data-viewer.feature.md [proposed]): a read-only
// browse of the Automerge store the way a SQL tool browses a database. The
// store's documents (specs/datastore/automerge-store.feature.md "Storage
// layout") are loaded as they are on disk — no schema check, no migration —
// and flattened into tables: one row per document, feature, spec entry,
// page, test case, plan, execution, or event model. Rows are filtered,
// sorted and paged here; a document reads back whole, with its chunk files
// and change history, and at any change (Automerge.view) with what that
// change touched (Automerge.diff). Nothing here writes to the data repo.
//
// The client never holds an Automerge document (src/frontend/DataPage.tsx
// talks JSON to /api/data/*), so every shape below crosses the wire as plain
// JSON; src/frontend/dataViewer.ts imports the types.

import * as A from "@automerge/automerge";
import {
  docDirMtime,
  isSafeDocDir,
  listDocDirs,
  loadRawDoc,
  onDocSaved,
  sourceFileOf,
  type DocChunk,
  type RawLoadedDoc,
} from "./automerge/store";
import { json, type Params } from "./http";
import { getLogger } from "./telemetry";

const log = getLogger("data-viewer");

export const TABLE_NAMES = [
  "documents",
  "features",
  "specs",
  "pages",
  "test_cases",
  "test_plans",
  "test_executions",
  "event_models",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export const TABLE_LABELS: Record<TableName, string> = {
  documents: "Documents",
  features: "Features",
  specs: "Specs",
  pages: "Pages",
  test_cases: "Test cases",
  test_plans: "Test plans",
  test_executions: "Test executions",
  event_models: "Event models",
};

export function isTableName(value: string): value is TableName {
  return (TABLE_NAMES as readonly string[]).includes(value);
}

export type ColumnType = "string" | "number" | "boolean" | "json" | "null";

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

/** A grid cell: a scalar, or a nested value wrapped so the client can tell. */
export type CellValue = string | number | boolean | null | { json: unknown };

export interface TableRow {
  /** Unique within the table. */
  key: string;
  /** The document the row came from, relative to the store root. */
  doc: string;
  cells: Record<string, CellValue>;
}

export interface TableSummary {
  name: TableName;
  label: string;
  rows: number;
}

export interface TablesResponse {
  tables: TableSummary[];
  /** How many document directories the store holds. */
  documents: number;
  /** When the store was last read for these counts. */
  scannedAt: string;
}

export type SortDir = "asc" | "desc";

export interface TableQuery {
  /** Case-insensitive substring over every cell. */
  q?: string;
  sort?: string;
  dir?: SortDir;
  offset: number;
  limit: number;
}

export interface TablePage {
  table: TableName;
  columns: ColumnDef[];
  rows: TableRow[];
  /** Rows in the whole table. */
  total: number;
  /** Rows matching the filter, before paging. */
  filtered: number;
  offset: number;
  limit: number;
  sort: string | null;
  dir: SortDir;
}

export type DocKindName = "feature" | "page" | "testing" | "file";

export interface DocMeta {
  dirRel: string;
  /** The data repo file the document mirrors; null for the testing document. */
  path: string | null;
  kind: DocKindName;
  docId: string;
  heads: string[];
  schemaVersion: number | null;
  chunks: DocChunk[];
  skippedChunks: string[];
  stats: { changes: number; ops: number; actors: number };
}

export interface DocResponse {
  meta: DocMeta;
  json: unknown;
}

export interface ChangeSummary {
  hash: string;
  actor: string;
  seq: number;
  /** Seconds since the epoch; 0 when the change carries none. */
  time: number;
  message: string | null;
  deps: string[];
  ops: number;
}

export interface HistoryPage {
  dirRel: string;
  changes: ChangeSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface DocAtResponse {
  dirRel: string;
  heads: string[];
  /** The change's parents — what the patches are measured from. */
  parents: string[];
  json: unknown;
  patches: A.Patch[];
  change: ChangeSummary | null;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
/** Longest cell text the grid gets; the document view has the whole value. */
export const CELL_TEXT_MAX = 500;
/** How long a scan serves counts and rows before the store is checked again. */
const MAX_AGE_MS = 30_000;

// ---------------------------------------------------------------------------
// Loading, with one cached scan per data dir

interface Scan {
  fingerprint: string;
  docs: RawLoadedDoc[];
  at: number;
  scannedAt: string;
  /** Decoded changes per document, newest first, decoded on first request. */
  history: Map<string, ChangeSummary[]>;
  tables: Map<TableName, { columns: ColumnDef[]; rows: TableRow[] }>;
}

const scans = new Map<string, Scan>();

// A local save adds a chunk, so the next request reads the store again.
onDocSaved((dataDir) => scans.delete(dataDir));

/** Drop every cached scan — tests, and a data folder switch. */
export function resetDataViewer(): void {
  scans.clear();
}

/** The doc dirs and when each last changed: cheap to compute, changes when a chunk lands. */
async function fingerprintOf(dataDir: string, dirs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const dir of dirs) parts.push(`${dir}@${await docDirMtime(dataDir, dir)}`);
  return parts.join("\n");
}

/**
 * Every document of the store, loaded raw. Served from the last scan while
 * the store's directories are unchanged and the scan is recent; `refresh`
 * reads again regardless.
 */
export async function scanStore(dataDir: string, opts: { refresh?: boolean } = {}): Promise<Scan> {
  const dirs = await listDocDirs(dataDir);
  const cached = scans.get(dataDir);
  if (cached && !opts.refresh && Date.now() - cached.at < MAX_AGE_MS) return cached;
  const fingerprint = await fingerprintOf(dataDir, dirs);
  if (cached && !opts.refresh && cached.fingerprint === fingerprint) {
    cached.at = Date.now();
    return cached;
  }
  const docs: RawLoadedDoc[] = [];
  for (const dir of dirs) {
    try {
      const doc = await loadRawDoc(dataDir, dir);
      if (doc) docs.push(doc);
    } catch (e) {
      log.warn(`data viewer skipped ${dir}: ${(e as Error).message}`);
    }
  }
  const scan: Scan = {
    fingerprint,
    docs,
    at: Date.now(),
    scannedAt: new Date().toISOString(),
    history: new Map(),
    tables: new Map(),
  };
  scans.set(dataDir, scan);
  return scan;
}

// ---------------------------------------------------------------------------
// Pure helpers

const TESTING_DIR = "test-management/project";
const PAGE_FOLDERS = new Set(["roadmap", "tasks", "notebook"]);

/** What schema a store directory's document follows, from where it sits. */
export function classify(dirRel: string): DocKindName {
  if (dirRel === TESTING_DIR) return "testing";
  const folder = dirRel.split("/")[0] ?? "";
  if (folder === "specs") return "feature";
  if (PAGE_FOLDERS.has(folder)) return "page";
  return "file";
}

/** The document as plain JSON — an ImmutableString reads as its text. */
export function plain(doc: A.Doc<unknown>): unknown {
  return JSON.parse(JSON.stringify(A.toJS(doc)));
}

/** A value as a grid cell: scalars as they are, anything nested wrapped. */
export function toCell(value: unknown): CellValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  return { json: value };
}

function cellType(value: CellValue): ColumnType {
  if (value === null) return "null";
  if (typeof value === "object") return "json";
  return typeof value as ColumnType;
}

/** The text a cell is filtered and sorted by. */
export function cellSearchText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value.json);
  return String(value);
}

/**
 * The columns of a set of rows: `preferred` first, in that order, then any
 * key the rows carry beyond them (a legacy field, a plugin's own), in the
 * order first seen. A column's type is that of its first non-null cell.
 */
export function columnsOf(rows: TableRow[], preferred: readonly string[]): ColumnDef[] {
  const names = [...preferred];
  for (const row of rows) for (const name of Object.keys(row.cells)) if (!names.includes(name)) names.push(name);
  return names.map((name) => {
    const first = rows.find((r) => r.cells[name] !== null && r.cells[name] !== undefined);
    return { name, type: first ? cellType(first.cells[name]!) : "null" };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cellsOf(record: Record<string, unknown>, fields: readonly string[], extra: Record<string, unknown> = {}): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(extra)) cells[k] = toCell(v);
  for (const field of fields) cells[field] = toCell(record[field]);
  for (const [k, v] of Object.entries(record)) if (!(k in cells)) cells[k] = toCell(v);
  return cells;
}

const DOCUMENT_COLUMNS = [
  "kind",
  "path",
  "dirRel",
  "docId",
  "heads",
  "schemaVersion",
  "chunkFiles",
  "snapshotBytes",
  "changesBytes",
  "skippedChunks",
  "changes",
] as const;

const FEATURE_FIELDS = [
  "id",
  "name",
  "schemaVersion",
  "assigned",
  "createdBy",
  "updatedBy",
  "description",
  "link",
  "confluence",
  "qtest",
  "prs",
  "aha",
  "figma",
  "flags",
  "attributes",
] as const;

const SPEC_FIELDS = [
  "id",
  "type",
  "name",
  "version",
  "status",
  "rank",
  "negative",
  "body",
  "publishedBody",
  "createdBy",
  "updatedBy",
  "tests",
  "link",
  "qtest",
  "prs",
  "aha",
  "figma",
  "files",
  "flags",
  "attributes",
] as const;

const PAGE_FIELDS = ["id", "name", "schemaVersion", "assigned", "estimate", "done", "author", "date", "kind", "supersedes", "body"] as const;
const CASE_FIELDS = ["id", "title", "priority", "refs", "body", "createdAt", "updatedAt"] as const;
const PLAN_FIELDS = ["id", "name", "assigned", "caseIds", "description", "createdAt", "updatedAt"] as const;
const EXECUTION_FIELDS = ["id", "name", "planId", "assigned", "caseIds", "results", "startedAt", "finishedAt"] as const;

function schemaVersionOf(value: unknown): number | null {
  const v = asRecord(value).schemaVersion;
  return typeof v === "number" ? v : null;
}

/** Build one table from the loaded documents: its columns and every row. */
export function buildTable(name: TableName, docs: RawLoadedDoc[]): { columns: ColumnDef[]; rows: TableRow[] } {
  const rows: TableRow[] = [];
  const byKind = (kind: DocKindName) => docs.filter((d) => classify(d.dirRel) === kind);
  let preferred: readonly string[] = [];
  switch (name) {
    case "documents": {
      preferred = DOCUMENT_COLUMNS;
      for (const d of docs) {
        const value = plain(d.doc);
        const stats = A.stats(d.doc);
        rows.push({
          key: d.dirRel,
          doc: d.dirRel,
          cells: {
            kind: classify(d.dirRel),
            path: sourceFileOf(d.dirRel),
            dirRel: d.dirRel,
            docId: d.docId,
            heads: d.heads.join(","),
            schemaVersion: schemaVersionOf(value),
            chunkFiles: d.chunks.length,
            snapshotBytes: d.chunks.filter((c) => c.kind === "snapshot").reduce((n, c) => n + c.bytes, 0),
            changesBytes: d.chunks.filter((c) => c.kind === "changes").reduce((n, c) => n + c.bytes, 0),
            skippedChunks: d.skippedChunks.length,
            changes: stats.numChanges,
          },
        });
      }
      break;
    }
    case "features": {
      preferred = ["path", "specs", ...FEATURE_FIELDS];
      for (const d of byKind("feature")) {
        const value = asRecord(plain(d.doc));
        const { specs, scenarios, ...rest } = value;
        const count = (Array.isArray(specs) ? specs.length : 0) + (Array.isArray(scenarios) ? scenarios.length : 0);
        rows.push({
          key: d.dirRel,
          doc: d.dirRel,
          cells: cellsOf(rest, FEATURE_FIELDS, { path: sourceFileOf(d.dirRel), specs: count }),
        });
      }
      break;
    }
    case "specs": {
      preferred = ["feature", "list", ...SPEC_FIELDS];
      for (const d of byKind("feature")) {
        const value = asRecord(plain(d.doc));
        // A raw pre-v3 document still calls its list `scenarios`; the `list`
        // column says which one an entry came from.
        for (const list of ["specs", "scenarios"] as const) {
          const entries = Array.isArray(value[list]) ? (value[list] as unknown[]) : [];
          entries.forEach((entry, i) => {
            const record = asRecord(entry);
            rows.push({
              key: `${d.dirRel}#${list}/${typeof record.id === "string" ? record.id : i}`,
              doc: d.dirRel,
              cells: cellsOf(record, SPEC_FIELDS, { feature: sourceFileOf(d.dirRel), list }),
            });
          });
        }
      }
      break;
    }
    case "pages": {
      preferred = ["folder", "path", ...PAGE_FIELDS];
      for (const d of byKind("page")) {
        const value = asRecord(plain(d.doc));
        rows.push({
          key: d.dirRel,
          doc: d.dirRel,
          cells: cellsOf(value, PAGE_FIELDS, { folder: d.dirRel.split("/")[0], path: sourceFileOf(d.dirRel) }),
        });
      }
      break;
    }
    case "test_cases":
    case "test_plans":
    case "test_executions": {
      const map = name === "test_cases" ? "cases" : name === "test_plans" ? "plans" : "executions";
      preferred = name === "test_cases" ? CASE_FIELDS : name === "test_plans" ? PLAN_FIELDS : EXECUTION_FIELDS;
      for (const d of byKind("testing")) {
        const value = asRecord(plain(d.doc));
        for (const [id, entry] of Object.entries(asRecord(value[map]))) {
          rows.push({ key: `${d.dirRel}#${id}`, doc: d.dirRel, cells: cellsOf(asRecord(entry), preferred) });
        }
      }
      break;
    }
    case "event_models": {
      preferred = ["path"];
      for (const d of byKind("file")) {
        const value = asRecord(plain(d.doc));
        rows.push({ key: d.dirRel, doc: d.dirRel, cells: cellsOf(value, [], { path: sourceFileOf(d.dirRel) }) });
      }
      break;
    }
  }
  return { columns: columnsOf(rows, preferred), rows };
}

function compareCells(a: CellValue, b: CellValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return cellSearchText(a).localeCompare(cellSearchText(b));
}

/** Filter, sort and page a table's rows. */
export function queryRows(rows: TableRow[], query: TableQuery): { rows: TableRow[]; filtered: number } {
  const needle = query.q?.trim().toLowerCase() ?? "";
  let matched = needle
    ? rows.filter((row) => Object.values(row.cells).some((cell) => cellSearchText(cell).toLowerCase().includes(needle)))
    : rows;
  if (query.sort) {
    const sort = query.sort;
    const sign = query.dir === "desc" ? -1 : 1;
    // Empty cells sit at the end whichever way the column is sorted.
    matched = [...matched].sort((a, b) => {
      const x = a.cells[sort] ?? null;
      const y = b.cells[sort] ?? null;
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return sign * compareCells(x, y);
    });
  }
  return { rows: matched.slice(query.offset, query.offset + query.limit), filtered: matched.length };
}

/** A row for the wire: long text shortened; the document view has it whole. */
export function clipRow(row: TableRow): TableRow {
  const cells: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(row.cells)) {
    cells[k] = typeof v === "string" && v.length > CELL_TEXT_MAX ? `${v.slice(0, CELL_TEXT_MAX)}…` : v;
  }
  return { ...row, cells };
}

export function summarizeChange(change: A.DecodedChange): ChangeSummary {
  return {
    hash: change.hash,
    actor: change.actor,
    seq: change.seq,
    time: change.time,
    message: change.message,
    deps: change.deps,
    ops: change.ops.length,
  };
}

/**
 * A document's changes, newest first. Automerge hands them out in causal
 * order (every change after the ones it depends on), which is the order to
 * trust: a change's timestamp is advisory and may be absent or set by hand.
 */
export function historyOf(doc: A.Doc<unknown>): ChangeSummary[] {
  return A.getAllChanges(doc)
    .map((c) => summarizeChange(A.decodeChange(c)))
    .reverse();
}

export function metaOf(d: RawLoadedDoc): DocMeta {
  const stats = A.stats(d.doc);
  return {
    dirRel: d.dirRel,
    path: sourceFileOf(d.dirRel),
    kind: classify(d.dirRel),
    docId: d.docId,
    heads: d.heads,
    schemaVersion: schemaVersionOf(plain(d.doc)),
    chunks: d.chunks,
    skippedChunks: d.skippedChunks,
    stats: { changes: stats.numChanges, ops: stats.numOps, actors: stats.numActors },
  };
}

const HASH = /^[0-9a-f]{64}$/;

export function isChangeHash(value: string): boolean {
  return HASH.test(value);
}

// ---------------------------------------------------------------------------
// Readers

export async function listTables(dataDir: string, opts: { refresh?: boolean } = {}): Promise<TablesResponse> {
  const scan = await scanStore(dataDir, opts);
  const tables = TABLE_NAMES.map((name) => ({ name, label: TABLE_LABELS[name], rows: tableOf(scan, name).rows.length }));
  return { tables, documents: scan.docs.length, scannedAt: scan.scannedAt };
}

function tableOf(scan: Scan, name: TableName) {
  let table = scan.tables.get(name);
  if (!table) {
    table = buildTable(name, scan.docs);
    scan.tables.set(name, table);
  }
  return table;
}

export async function readTable(dataDir: string, name: TableName, query: TableQuery): Promise<TablePage> {
  const scan = await scanStore(dataDir);
  const table = tableOf(scan, name);
  if (query.sort && !table.columns.some((c) => c.name === query.sort)) throw new BadQuery(`unknown column ${query.sort}`);
  const { rows, filtered } = queryRows(table.rows, query);
  return {
    table: name,
    columns: table.columns,
    rows: rows.map(clipRow),
    total: table.rows.length,
    filtered,
    offset: query.offset,
    limit: query.limit,
    sort: query.sort ?? null,
    dir: query.dir ?? "asc",
  };
}

async function docOf(dataDir: string, dirRel: string): Promise<{ scan: Scan; doc: RawLoadedDoc } | null> {
  const scan = await scanStore(dataDir);
  const doc = scan.docs.find((d) => d.dirRel === dirRel);
  return doc ? { scan, doc } : null;
}

export async function readDoc(dataDir: string, dirRel: string): Promise<DocResponse | null> {
  const found = await docOf(dataDir, dirRel);
  if (!found) return null;
  return { meta: metaOf(found.doc), json: plain(found.doc.doc) };
}

export async function readHistory(dataDir: string, dirRel: string, offset: number, limit: number): Promise<HistoryPage | null> {
  const found = await docOf(dataDir, dirRel);
  if (!found) return null;
  let changes = found.scan.history.get(dirRel);
  if (!changes) {
    changes = historyOf(found.doc.doc);
    found.scan.history.set(dirRel, changes);
  }
  return { dirRel, changes: changes.slice(offset, offset + limit), total: changes.length, offset, limit };
}

/**
 * The document as it stood at `heads`, and — when `heads` is one change —
 * what that change did to the document its parents described. Null when
 * the document or any of the heads is unknown.
 */
export async function readDocAt(dataDir: string, dirRel: string, heads: string[]): Promise<DocAtResponse | null> {
  const found = await docOf(dataDir, dirRel);
  if (!found) return null;
  const doc = found.doc.doc;
  let view: A.Doc<unknown>;
  try {
    view = A.view(doc, heads);
  } catch {
    return null;
  }
  const decoded = heads.length === 1 ? A.inspectChange(doc, heads[0]!) : null;
  if (heads.length === 1 && !decoded) return null;
  const change = decoded ? summarizeChange(decoded) : null;
  const parents = change?.deps ?? [];
  // The first change has no parents: everything in the document is its
  // doing, which the view shows whole rather than as one patch per value.
  let patches: A.Patch[] = [];
  if (change && parents.length > 0) {
    try {
      patches = A.diff(doc, parents, heads);
    } catch {
      patches = [];
    }
  }
  return { dirRel, heads, parents, json: plain(view), patches, change };
}

// ---------------------------------------------------------------------------
// Handlers — wrapped by api.ts withDataDir, which hands them the data dir

class BadQuery extends Error {}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadQuery(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function pathParam(params: URLSearchParams): string {
  const path = params.get("path") ?? "";
  if (!path) throw new BadQuery("path is required");
  if (!isSafeDocDir(path)) throw new BadQuery("invalid document path");
  return path;
}

type DataHandler = (dir: string, req: Request, params: Params) => Promise<Response>;

/** Errors a bad request earns map to 400; a path that leaves the store too. */
function guarded(handler: DataHandler): DataHandler {
  return async (dir, req, params) => {
    try {
      return await handler(dir, req, params);
    } catch (e) {
      if (e instanceof BadQuery || (e as Error).message === "invalid document path") return json({ error: (e as Error).message }, 400);
      throw e;
    }
  };
}

export const getDataTables: DataHandler = guarded(async (dir, req) => {
  const params = new URL(req.url).searchParams;
  return json(await listTables(dir, { refresh: params.get("refresh") === "1" }));
});

export const getDataTable: DataHandler = guarded(async (dir, req, params) => {
  const name = params.table ?? "";
  if (!isTableName(name)) return json({ error: `unknown table ${name}` }, 400);
  const search = new URL(req.url).searchParams;
  const dir_ = search.get("dir") ?? "asc";
  if (dir_ !== "asc" && dir_ !== "desc") return json({ error: "dir must be asc or desc" }, 400);
  return json(
    await readTable(dir, name, {
      q: search.get("q") ?? undefined,
      sort: search.get("sort") ?? undefined,
      dir: dir_,
      offset: intParam(search, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
      limit: intParam(search, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    }),
  );
});

export const getDataDoc: DataHandler = guarded(async (dir, req) => {
  const search = new URL(req.url).searchParams;
  const result = await readDoc(dir, pathParam(search));
  return result ? json(result) : json({ error: "no such document" }, 404);
});

export const getDataDocHistory: DataHandler = guarded(async (dir, req) => {
  const search = new URL(req.url).searchParams;
  const result = await readHistory(
    dir,
    pathParam(search),
    intParam(search, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    intParam(search, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
  );
  return result ? json(result) : json({ error: "no such document" }, 404);
});

export const getDataDocAt: DataHandler = guarded(async (dir, req) => {
  const search = new URL(req.url).searchParams;
  const heads = (search.get("heads") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (heads.length === 0) return json({ error: "heads is required" }, 400);
  if (!heads.every(isChangeHash)) return json({ error: "heads must be 64-character hex change hashes" }, 400);
  const result = await readDocAt(dir, pathParam(search), heads);
  return result ? json(result) : json({ error: "no such document or change" }, 404);
});
