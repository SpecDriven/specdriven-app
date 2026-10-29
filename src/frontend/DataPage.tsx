// Data (specs/app/data-viewer.feature.md [proposed]): the Automerge store
// browsed the way a SQL tool browses a database, in its own editor-pane page
// opened from the user menu like Observability. The store's tables sit on
// the left with their row counts; a table shows as a grid — filtered, sorted
// and paged on the server (src/server/dataViewer.ts) — whose row opens as a
// tree in a drawer and leads to its document: what is on disk, unmigrated,
// with its chunk files, and its change history, where picking a change shows
// the document as it stood then and what the change touched. Read-only.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { AppPageLayout, PageSection } from "./AppPage";
import { JsonTree } from "./JsonTree";
import {
  DEFAULT_QUERY,
  HISTORY_PAGE_SIZE,
  PAGE_SIZE,
  atUrl,
  cellText,
  cellTitle,
  changeTime,
  docUrl,
  formatBytes,
  historyUrl,
  patchLine,
  rowValue,
  shortHash,
  tableUrl,
  tablesUrl,
  type ChangeSummary,
  type DocAtResponse,
  type DocResponse,
  type HistoryPage,
  type RowsQuery,
  type TableName,
  type TablePage,
  type TableRow,
  type TablesResponse,
} from "./dataViewer";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

type View = "rows" | "document" | "history";

/** Typing settles this long before the filter runs. */
const FILTER_DEBOUNCE_MS = 250;

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

/** The grid: sortable headers, one selectable row per table row. */
export function DataGrid({
  page,
  query,
  selectedKey,
  onSort,
  onSelect,
}: {
  page: TablePage;
  query: RowsQuery;
  selectedKey: string | null;
  onSort(column: string): void;
  onSelect(row: TableRow): void;
}) {
  return (
    <div className="data-grid">
      <table>
        <thead>
          <tr>
            {page.columns.map((col) => {
              const sorted = query.sort === col.name;
              return (
                <th
                  key={col.name}
                  scope="col"
                  className="data-th"
                  data-type={col.type}
                  aria-sort={sorted ? (query.dir === "desc" ? "descending" : "ascending") : "none"}
                >
                  <button type="button" className="data-sort" onClick={() => onSort(col.name)} title={`Sort by ${col.name}`}>
                    {col.name}
                    {sorted &&
                      (query.dir === "desc" ? (
                        <ArrowDown size={11} aria-hidden="true" />
                      ) : (
                        <ArrowUp size={11} aria-hidden="true" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr
              key={row.key}
              className="data-row"
              aria-selected={selectedKey === row.key}
              tabIndex={0}
              onClick={() => onSelect(row)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(row);
                }
              }}
            >
              {page.columns.map((col) => {
                const cell = row.cells[col.name] ?? null;
                const json = cell !== null && typeof cell === "object";
                return (
                  <td
                    key={col.name}
                    className={`data-cell${json ? " data-cell-json" : ""}${cell === null ? " data-cell-null" : ""}`}
                    data-type={cell === null ? "null" : json ? "json" : typeof cell}
                    title={cellTitle(cell)}
                  >
                    {cell === null ? "∅" : cellText(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One change of the history list. */
export function ChangeRow({ change, selected, onSelect }: { change: ChangeSummary; selected: boolean; onSelect(): void }) {
  return (
    <li className={`data-change${selected ? " selected" : ""}`}>
      <button type="button" className="data-change-line" aria-pressed={selected} onClick={onSelect}>
        <code className="data-hash" title={change.hash}>
          {shortHash(change.hash)}
        </code>
        <time className="data-change-time">{changeTime(change.time)}</time>
        <span className="data-change-actor" title={change.actor}>
          {shortHash(change.actor)} · seq {change.seq}
        </span>
        <span className="data-change-message">{change.message ?? <span className="data-muted">no message</span>}</span>
        <span className="data-change-ops">
          {change.ops} {change.ops === 1 ? "op" : "ops"}
        </span>
      </button>
    </li>
  );
}

export interface DataPageProps {
  onClose(): void;
  /** Injected in tests; the window's fetch otherwise. */
  fetcher?: Fetcher;
  initialTable?: TableName;
}

export function DataPage({ onClose, fetcher, initialTable }: DataPageProps) {
  const doFetch: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const fetchRef = useRef(doFetch);
  fetchRef.current = doFetch;

  const [tables, setTables] = useState<TablesResponse | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [table, setTable] = useState<TableName>(initialTable ?? "documents");

  const [query, setQuery] = useState<RowsQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState<TablePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<TableRow | null>(null);

  const [view, setView] = useState<View>("rows");
  const [docPath, setDocPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocResponse | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [treeDepth, setTreeDepth] = useState(2);
  const [treeGen, setTreeGen] = useState(0);

  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [at, setAt] = useState<DocAtResponse | null>(null);
  const [atError, setAtError] = useState<string | null>(null);

  const loadTables = useCallback(async (refresh = false) => {
    try {
      const res = await fetchRef.current(tablesUrl(refresh));
      if (!res.ok) throw new Error(await errorOf(res));
      setTables((await res.json()) as TablesResponse);
      setTablesError(null);
    } catch (e) {
      setTablesError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // The newest request wins: a slow answer to an older query is dropped.
  const requestId = useRef(0);
  const loadRows = useCallback(async (name: TableName, q: RowsQuery) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await fetchRef.current(tableUrl(name, q));
      if (!res.ok) throw new Error(await errorOf(res));
      const next = (await res.json()) as TablePage;
      if (id !== requestId.current) return;
      setPage(next);
      setError(null);
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadRows(table, query);
  }, [table, query, loadRows]);

  useEffect(() => {
    if (draft === query.q) return;
    const t = setTimeout(() => setQuery((q) => ({ ...q, q: draft, offset: 0 })), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, query.q]);

  const selectTable = (name: string) => {
    setTable(name as TableName);
    setQuery(DEFAULT_QUERY);
    setDraft("");
    setSelectedRow(null);
    setView("rows");
  };

  const sortBy = (column: string) =>
    setQuery((q) => ({
      ...q,
      sort: column,
      dir: q.sort === column && q.dir === "asc" ? "desc" : "asc",
      offset: 0,
    }));

  const openDocument = (dirRel: string) => {
    if (dirRel !== docPath) {
      setDocPath(dirRel);
      setDoc(null);
      setDocError(null);
      setHistory(null);
      setHistoryError(null);
      setSelectedHash(null);
      setAt(null);
      setAtError(null);
    }
    setView("document");
  };

  // The document, once its view is shown.
  useEffect(() => {
    if (view !== "document" || !docPath || doc) return;
    let stale = false;
    void (async () => {
      try {
        const res = await fetchRef.current(docUrl(docPath));
        if (!res.ok) throw new Error(await errorOf(res));
        const next = (await res.json()) as DocResponse;
        if (!stale) setDoc(next);
      } catch (e) {
        if (!stale) setDocError((e as Error).message);
      }
    })();
    return () => {
      stale = true;
    };
  }, [view, docPath, doc]);

  const loadHistory = useCallback(
    async (dirRel: string, offset: number) => {
      try {
        const res = await fetchRef.current(historyUrl(dirRel, offset));
        if (!res.ok) throw new Error(await errorOf(res));
        const next = (await res.json()) as HistoryPage;
        setHistory((h) => (offset > 0 && h ? { ...next, changes: [...h.changes, ...next.changes] } : next));
        setHistoryError(null);
      } catch (e) {
        setHistoryError((e as Error).message);
      }
    },
    [],
  );
  useEffect(() => {
    if (view !== "history" || !docPath || history) return;
    void loadHistory(docPath, 0);
  }, [view, docPath, history, loadHistory]);

  // The document at the picked change, and what the change did.
  useEffect(() => {
    if (!docPath || !selectedHash) return;
    let stale = false;
    setAt(null);
    setAtError(null);
    void (async () => {
      try {
        const res = await fetchRef.current(atUrl(docPath, selectedHash));
        if (!res.ok) throw new Error(await errorOf(res));
        const next = (await res.json()) as DocAtResponse;
        if (!stale) setAt(next);
      } catch (e) {
        if (!stale) setAtError((e as Error).message);
      }
    })();
    return () => {
      stale = true;
    };
  }, [docPath, selectedHash]);

  const resetTree = (depth: number) => {
    setTreeDepth(depth);
    setTreeGen((g) => g + 1);
  };

  const shownTables = (tables?.tables ?? []).filter((t) => t.label.toLowerCase().includes(tableFilter.trim().toLowerCase()));
  const sections = shownTables.map((t) => ({ id: t.name, title: `${t.label} · ${t.rows}` }));
  const label = tables?.tables.find((t) => t.name === table)?.label ?? table;
  const rows = page?.rows ?? [];
  const filtered = query.q.trim() !== "";
  const from = page ? page.offset + 1 : 0;
  const to = page ? page.offset + rows.length : 0;

  const viewTabs = (
    <div className="data-views" role="tablist" aria-label="Views">
      {(
        [
          ["rows", "Rows"],
          ["document", "Document"],
          ["history", "History"],
        ] as const
      ).map(([id, title]) => (
        <button
          key={id}
          type="button"
          role="tab"
          className={`data-view${view === id ? " active" : ""}`}
          aria-selected={view === id}
          disabled={id !== "rows" && !docPath}
          title={id !== "rows" && !docPath ? "Pick a row first" : undefined}
          onClick={() => setView(id)}
        >
          {title}
        </button>
      ))}
      {docPath && view !== "rows" && (
        <code className="data-views-doc" title={docPath}>
          {docPath}
        </code>
      )}
    </div>
  );

  const treeTools = (
    <div className="data-tree-tools">
      <button type="button" className="link" onClick={() => resetTree(99)}>
        Expand all
      </button>
      <button type="button" className="link" onClick={() => resetTree(1)}>
        Collapse all
      </button>
    </div>
  );

  return (
    <AppPageLayout
      title="Data"
      className="wide data-page"
      sections={sections}
      tabs={{ active: table, onSelect: selectTable }}
      aside={
        <div className="data-aside">
          <label className="data-table-search">
            <Search size={12} aria-hidden="true" />
            <input
              type="search"
              aria-label="Find a table"
              placeholder="Find a table"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
            />
          </label>
          <p className="data-aside-note">
            {tablesError ? (
              <span className="log-error">{tablesError}</span>
            ) : tables ? (
              <>
                {tables.documents} {tables.documents === 1 ? "document" : "documents"} in the store
              </>
            ) : (
              "Scanning the store…"
            )}
          </p>
          <button type="button" className="link" onClick={() => void loadTables(true)}>
            Rescan
          </button>
        </div>
      }
      onClose={onClose}
    >
      <PageSection
        id={table}
        title={label}
        panel
        className="data-panel"
        hint={
          view === "rows"
            ? "Rows as the store holds them: unmigrated, nested values as JSON. Click a row for its tree and its document."
            : view === "document"
              ? "The document as its chunk files merge on disk — no schema check, no migration."
              : "Every change the document carries, newest first. Pick one to see the document as it stood then, and what the change did."
        }
      >
        {viewTabs}
        {view === "rows" && (
          <>
            <div className="data-toolbar" role="search">
              <label className="log-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Filter rows"
                  placeholder="Filter rows"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setQuery((q) => ({ ...q, q: draft, offset: 0 }));
                  }}
                />
              </label>
              <p className="data-status" aria-live="polite">
                {page === null
                  ? "Loading…"
                  : rows.length === 0
                    ? filtered
                      ? "No rows match."
                      : "No rows."
                    : `${from}–${to} of ${page.filtered}${filtered && page.filtered !== page.total ? ` (of ${page.total})` : ""}`}
              </p>
              <button
                type="button"
                className="ibtn"
                aria-label="Previous page"
                title="Previous page"
                disabled={!page || page.offset === 0}
                onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - PAGE_SIZE) }))}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ibtn"
                aria-label="Next page"
                title="Next page"
                disabled={!page || page.offset + rows.length >= page.filtered}
                onClick={() => setQuery((q) => ({ ...q, offset: q.offset + PAGE_SIZE }))}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ibtn"
                aria-label="Refresh rows"
                title="Refresh"
                onClick={() => {
                  void loadTables(true);
                  void loadRows(table, query);
                }}
              >
                <RefreshCw size={14} aria-hidden="true" className={loading ? "spin" : undefined} />
              </button>
            </div>
            {error && (
              <p className="log-error" role="alert">
                {error}
              </p>
            )}
            <div className={`data-rows${selectedRow ? " with-drawer" : ""}`}>
              {page && rows.length > 0 && (
                <DataGrid page={page} query={query} selectedKey={selectedRow?.key ?? null} onSort={sortBy} onSelect={setSelectedRow} />
              )}
              {selectedRow && (
                <aside className="data-drawer" aria-label="Row">
                  <div className="data-drawer-head">
                    <code className="data-drawer-title" title={selectedRow.key}>
                      {selectedRow.key}
                    </code>
                    <button type="button" className="ibtn" aria-label="Close row" onClick={() => setSelectedRow(null)}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <JsonTree value={rowValue(selectedRow)} openDepth={2} />
                  <button type="button" className="link data-open-doc" onClick={() => openDocument(selectedRow.doc)}>
                    Open document
                    <ChevronRight size={12} aria-hidden="true" />
                  </button>
                </aside>
              )}
            </div>
          </>
        )}
        {view === "document" && (
          <div className="data-document">
            {docError && (
              <p className="log-error" role="alert">
                {docError}
              </p>
            )}
            {doc ? (
              <>
                <dl className="data-meta">
                  <div className="data-meta-row">
                    <dt>kind</dt>
                    <dd>{doc.meta.kind}</dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>path</dt>
                    <dd>{doc.meta.path ?? <span className="data-muted">none (store only)</span>}</dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>docId</dt>
                    <dd>
                      <code>{doc.meta.docId}</code>
                    </dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>heads</dt>
                    <dd>
                      {doc.meta.heads.map((h) => (
                        <code key={h} className="data-hash" title={h}>
                          {h}
                        </code>
                      ))}
                    </dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>schemaVersion</dt>
                    <dd>{doc.meta.schemaVersion ?? <span className="data-muted">none</span>}</dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>stats</dt>
                    <dd>
                      {doc.meta.stats.changes} changes · {doc.meta.stats.ops} ops · {doc.meta.stats.actors} actors
                    </dd>
                  </div>
                  <div className="data-meta-row">
                    <dt>chunks</dt>
                    <dd>
                      <table className="data-chunks">
                        <tbody>
                          {doc.meta.chunks.map((c) => (
                            <tr key={c.file} className={c.applied ? undefined : "skipped"}>
                              <td>
                                <code>{c.file}</code>
                              </td>
                              <td>{c.kind}</td>
                              <td>{formatBytes(c.bytes)}</td>
                              <td>{c.applied ? "applied" : "skipped"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </dd>
                  </div>
                </dl>
                {doc.meta.skippedChunks.length > 0 && (
                  <p className="log-error">
                    {doc.meta.skippedChunks.length} chunk{doc.meta.skippedChunks.length === 1 ? "" : "s"} could not be applied:{" "}
                    {doc.meta.skippedChunks.join(", ")}
                  </p>
                )}
                {treeTools}
                <JsonTree value={doc.json} openDepth={treeDepth} generation={treeGen} />
              </>
            ) : (
              !docError && <p className="page-empty data-loading">Loading…</p>
            )}
          </div>
        )}
        {view === "history" && (
          <div className="data-history">
            <div className="data-history-list">
              {historyError && (
                <p className="log-error" role="alert">
                  {historyError}
                </p>
              )}
              {history ? (
                <>
                  <p className="data-status">
                    {history.total} {history.total === 1 ? "change" : "changes"}
                  </p>
                  <ol className="data-changes" aria-label="Changes">
                    {history.changes.map((c) => (
                      <ChangeRow key={c.hash} change={c} selected={selectedHash === c.hash} onSelect={() => setSelectedHash(c.hash)} />
                    ))}
                  </ol>
                  {history.changes.length < history.total && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => docPath && void loadHistory(docPath, history.changes.length)}
                    >
                      Load older ({HISTORY_PAGE_SIZE} more)
                    </button>
                  )}
                </>
              ) : (
                !historyError && <p className="page-empty data-loading">Loading…</p>
              )}
            </div>
            <div className="data-history-detail">
              {!selectedHash ? (
                <p className="page-empty">Pick a change to see the document as it stood then.</p>
              ) : atError ? (
                <p className="log-error" role="alert">
                  {atError}
                </p>
              ) : !at ? (
                <p className="page-empty data-loading">Loading…</p>
              ) : (
                <>
                  <h3 className="data-at-title">
                    At <code className="data-hash">{shortHash(selectedHash)}</code>
                    {at.change?.message && <span className="data-change-message"> — {at.change.message}</span>}
                  </h3>
                  {at.parents.length === 0 ? (
                    <p className="data-muted">First change: everything below is new.</p>
                  ) : at.patches.length === 0 ? (
                    <p className="data-muted">No patches against its parents.</p>
                  ) : (
                    <ul className="data-patches" aria-label="Patches">
                      {at.patches.map((p, i) => (
                        <li key={i}>
                          <code>{patchLine(p)}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {treeTools}
                  <JsonTree value={at.json} openDepth={treeDepth} generation={treeGen} />
                </>
              )}
            </div>
          </div>
        )}
      </PageSection>
    </AppPageLayout>
  );
}
