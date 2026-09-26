// Observability: its own page in the editor pane, opened from the user menu
// like Settings and Plugins. The app's own log, newest first — searched as
// text or a regular expression, narrowed to a level and a component, and
// followed live — and the verbosity that decides what gets written: a
// default level and per-component overrides, applied at once and kept in
// the settings file (src/server/logs.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronRight, Copy, RefreshCw, Search } from "lucide-react";
import { AppPageLayout, PageSection } from "./AppPage";
import {
  DEFAULT_FILTER,
  LOG_LEVELS,
  PAGE_SIZE,
  clockTime,
  componentChoices,
  dayOf,
  entryLine,
  logsUrl,
  minimumLabel,
  searchPattern,
  splitMatches,
  type LogEntry,
  type LogFilter,
  type LogLevel,
  type LogPage,
  type LogSettings,
} from "./observability";

/** How often the list refreshes while following. */
const FOLLOW_MS = 3000;
/** Typing settles this long before the search runs. */
const SEARCH_DEBOUNCE_MS = 250;

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

function Marked({ text, pattern }: { text: string; pattern: RegExp | null }) {
  return (
    <>
      {splitMatches(text, pattern).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  );
}

export function LevelBadge({ level }: { level: LogLevel }) {
  return <span className={`log-level log-level-${level}`}>{level.toUpperCase()}</span>;
}

/** One entry: a line of time, level, component and message; details below when open. */
export function LogRow({
  entry,
  pattern,
  open,
  onToggle,
  onCopy,
  copied,
}: {
  entry: LogEntry;
  pattern: RegExp | null;
  open: boolean;
  onToggle(): void;
  onCopy(): void;
  copied: boolean;
}) {
  const attrs = Object.entries(entry.attributes);
  return (
    <li className={`log-row log-row-${entry.level}${open ? " open" : ""}`}>
      <button type="button" className="log-row-line" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={12} className="log-row-caret" aria-hidden="true" />
        <time className="log-time" dateTime={entry.time} title={entry.time}>
          {clockTime(entry.time)}
        </time>
        <LevelBadge level={entry.level} />
        <span className="log-component">
          <Marked text={entry.component} pattern={pattern} />
        </span>
        <span className="log-message">
          <Marked text={entry.message} pattern={pattern} />
          {!open &&
            attrs
              .filter(([k]) => k !== "exception.stacktrace")
              .map(([k, v]) => (
                <span className="log-attr" key={k}>
                  {" "}
                  <Marked text={`${k}=${v}`} pattern={pattern} />
                </span>
              ))}
        </span>
      </button>
      {open && (
        <div className="log-row-details">
          {attrs.length > 0 || entry.traceId ? (
            <dl className="log-attrs">
              {attrs.map(([k, v]) => (
                <div key={k} className="log-attrs-row">
                  <dt>{k}</dt>
                  <dd>
                    <Marked text={v} pattern={pattern} />
                  </dd>
                </div>
              ))}
              {entry.traceId && (
                <div className="log-attrs-row">
                  <dt>trace</dt>
                  <dd>
                    {entry.traceId} · span {entry.spanId}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="page-empty">No attributes.</p>
          )}
          <button type="button" className="link log-copy" onClick={onCopy}>
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {copied ? "Copied" : "Copy line"}
          </button>
        </div>
      )}
    </li>
  );
}

/** The entries, with a date line wherever the day changes. */
export function LogList({
  entries,
  pattern,
  openKey,
  setOpenKey,
  copiedKey,
  onCopy,
}: {
  entries: LogEntry[];
  pattern: RegExp | null;
  openKey: string | null;
  setOpenKey(key: string | null): void;
  copiedKey: string | null;
  onCopy(key: string, entry: LogEntry): void;
}) {
  const items: ReactNode[] = [];
  const seen = new Map<string, number>();
  let day = "";
  entries.forEach((entry, i) => {
    const d = dayOf(entry.time);
    if (d !== day) {
      day = d;
      items.push(
        <li key={`day-${d}-${i}`} className="log-day" role="presentation">
          {d}
        </li>,
      );
    }
    // Keyed by content, not position, so an open row stays open while
    // following pushes newer entries in above it; repeats get a count.
    const base = `${entry.time}|${entry.component}|${entry.message}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}#${n}`;
    items.push(
      <LogRow
        key={key}
        entry={entry}
        pattern={pattern}
        open={openKey === key}
        onToggle={() => setOpenKey(openKey === key ? null : key)}
        copied={copiedKey === key}
        onCopy={() => onCopy(key, entry)}
      />,
    );
  });
  return (
    <ol className="log-list" aria-label="Log entries">
      {items}
    </ol>
  );
}

/** The verbosity rows: the default level, then one per component. */
export function VerbosityRows({
  settings,
  saving,
  onChange,
}: {
  settings: LogSettings;
  saving: boolean;
  onChange(change: { level?: LogLevel; components?: Record<string, LogLevel> }): void;
}) {
  const setComponent = (name: string, value: string) => {
    const components = { ...settings.components };
    if (value === "") delete components[name];
    else components[name] = value as LogLevel;
    onChange({ components });
  };
  return (
    <>
      <label className="settings-row">
        <span className="settings-row-label">
          Default level
          <span className="settings-row-hint">
            The least severe entries written, for every component without its own level below.
          </span>
        </span>
        <select
          aria-label="Default level"
          value={settings.level}
          disabled={saving}
          onChange={(e) => onChange({ level: e.target.value as LogLevel })}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {minimumLabel(l)}
            </option>
          ))}
        </select>
      </label>
      {settings.known.map((name) => (
        <label className="settings-row" key={name} data-component={name}>
          <span className="settings-row-label">
            <code className="log-component-name">{name}</code>
          </span>
          <select
            aria-label={`Level for ${name}`}
            value={settings.components[name] ?? ""}
            disabled={saving}
            onChange={(e) => setComponent(name, e.target.value)}
          >
            <option value="">Default ({settings.level})</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {minimumLabel(l)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ObservabilityPageProps {
  onClose(): void;
  /** Injected in tests; the window's fetch otherwise. */
  fetcher?: Fetcher;
  /** Text onto the clipboard, false when that fails. */
  copyText?: (text: string) => Promise<boolean>;
}

export function ObservabilityPage({ onClose, fetcher, copyText }: ObservabilityPageProps) {
  const doFetch: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const fetchRef = useRef(doFetch);
  fetchRef.current = doFetch;

  const [settings, setSettings] = useState<LogSettings | null>(null);
  const [savingVerbosity, setSavingVerbosity] = useState(false);
  const [verbosityError, setVerbosityError] = useState<string | null>(null);

  const [filter, setFilter] = useState<LogFilter>(DEFAULT_FILTER);
  // What the search box holds; it reaches the filter after the debounce.
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState<LogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetchRef.current("/api/logs/settings");
      if (!res.ok) throw new Error(await errorOf(res));
      setSettings((await res.json()) as LogSettings);
      setVerbosityError(null);
    } catch (e) {
      setVerbosityError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // The newest request wins: a slow answer to an older filter is dropped.
  const requestId = useRef(0);
  const load = useCallback(async (f: LogFilter) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await fetchRef.current(logsUrl(f));
      if (!res.ok) throw new Error(await errorOf(res));
      const next = (await res.json()) as LogPage;
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
    void load(filter);
  }, [filter, load]);

  useEffect(() => {
    if (draft === filter.q) return;
    const t = setTimeout(() => setFilter((f) => ({ ...f, q: draft, limit: PAGE_SIZE })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, filter.q]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void load(filter), FOLLOW_MS);
    return () => clearInterval(t);
  }, [follow, filter, load]);

  const changeVerbosity = async (change: { level?: LogLevel; components?: Record<string, LogLevel> }) => {
    setSavingVerbosity(true);
    try {
      const res = await fetchRef.current("/api/logs/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      setSettings((await res.json()) as LogSettings);
      setVerbosityError(null);
    } catch (e) {
      setVerbosityError((e as Error).message);
    } finally {
      setSavingVerbosity(false);
    }
  };

  const copy = async (key: string, entry: LogEntry) => {
    const text = entryLine(entry);
    const ok = copyText
      ? await copyText(text)
      : await navigator.clipboard.writeText(text).then(
          () => true,
          () => false,
        );
    if (!ok) return;
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  };

  const update = (change: Partial<LogFilter>) => setFilter((f) => ({ ...f, limit: PAGE_SIZE, ...change }));
  const pattern = searchPattern(filter.q, filter.regex);
  const entries = page?.entries ?? [];
  const components = componentChoices(settings, entries);
  const filtered = filter.q.trim() !== "" || filter.level !== "debug" || filter.component !== "";

  const sourceHint =
    settings?.source.kind === "file" ? (
      <>
        Read from <code>{settings.source.dir}</code>, the current file and the rotated ones.
      </>
    ) : settings?.source.kind === "memory" ? (
      "File logging is off, so this is the latest entries kept in memory since the app started."
    ) : null;

  return (
    <AppPageLayout
      title="Observability"
      className="wide"
      sections={[
        { id: "observability-logs", title: "Logs" },
        { id: "observability-verbosity", title: "Verbosity" },
      ]}
      onClose={onClose}
    >
      <PageSection id="observability-logs" title="Logs" hint={sourceHint} className="log-panel">
        <div className="log-toolbar" role="search">
          <label className="log-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search logs"
              placeholder={filter.regex ? "Regular expression" : "Search logs"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") update({ q: draft });
              }}
            />
          </label>
          <label className="log-toggle">
            <input type="checkbox" checked={filter.regex} onChange={(e) => update({ regex: e.target.checked })} />
            Regex
          </label>
          <select aria-label="Level" value={filter.level} onChange={(e) => update({ level: e.target.value as LogLevel })}>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {minimumLabel(l)}
              </option>
            ))}
          </select>
          <select aria-label="Component" value={filter.component} onChange={(e) => update({ component: e.target.value })}>
            <option value="">All components</option>
            {components.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="log-toggle">
            <span className="switch">
              <input type="checkbox" role="switch" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
            </span>
            Follow
          </label>
          <button
            type="button"
            className="ibtn"
            aria-label="Refresh logs"
            title="Refresh"
            onClick={() => void load(filter)}
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? "spin" : undefined} />
          </button>
        </div>
        {error && (
          <p className="log-error" role="alert">
            {error}
          </p>
        )}
        <p className="log-status" aria-live="polite">
          {page === null
            ? "Loading…"
            : entries.length === 0
              ? filtered
                ? "No entries match."
                : "Nothing logged yet."
              : `${entries.length}${page.more ? "+" : ""} ${entries.length === 1 ? "entry" : "entries"}, newest first`}
        </p>
        {entries.length > 0 && (
          <LogList
            entries={entries}
            pattern={pattern}
            openKey={openKey}
            setOpenKey={setOpenKey}
            copiedKey={copiedKey}
            onCopy={(key, entry) => void copy(key, entry)}
          />
        )}
        {page?.more && (
          <button type="button" className="link log-more" onClick={() => setFilter((f) => ({ ...f, limit: f.limit + PAGE_SIZE }))}>
            Load older entries
          </button>
        )}
      </PageSection>
      <PageSection
        id="observability-verbosity"
        title="Verbosity"
        hint={
          <>
            Entries below a component's level are not written anywhere — not to the log file, the console or
            OpenTelemetry{settings?.otel ? " (exporting now)" : ""}. Changes apply at once and are kept for the next
            start.
          </>
        }
      >
        {verbosityError && (
          <p className="log-error settings-row" role="alert">
            {verbosityError}
          </p>
        )}
        {settings ? (
          <VerbosityRows settings={settings} saving={savingVerbosity} onChange={(c) => void changeVerbosity(c)} />
        ) : (
          !verbosityError && <p className="page-empty settings-row">Loading…</p>
        )}
      </PageSection>
    </AppPageLayout>
  );
}
