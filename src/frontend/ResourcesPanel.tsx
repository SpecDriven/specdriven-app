// Resources (specs/app/resource-usage.feature.md): the Observability page's
// third tab. Memory — SpecDriven, its agents, MCP servers and anything else
// it started — measured every few seconds while the tab is shown; disk —
// every folder the app keeps things in — measured when the tab opens and on
// Refresh, with the cleanups that free space: an agent worktree, old logs,
// the browser cache, the app version kept to go back to.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { PageSection } from "./AppPage";
import type { ConfirmOptions } from "./ModalPrompts";
import {
  CLEANUP_URL,
  DISK_URL,
  MEMORY_POLL_MS,
  MEMORY_URL,
  cleanupPrompt,
  formatSize,
  shares,
  type CleanupOffer,
  type DiskEntry,
  type DiskSnapshot,
  type MemoryGroup,
  type MemorySnapshot,
} from "./resources";
import { toast } from "./Toasts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

export const MEMORY_SECTION = "observability-resources";
export const DISK_SECTION = "observability-disk";

const GROUP_COLORS = ["var(--meter-1)", "var(--meter-2)", "var(--meter-3)", "var(--meter-4)", "var(--meter-5)", "var(--meter-6)"];

function Bar({ parts, label }: { parts: { label: string; bytes: number }[]; label: string }) {
  const widths = shares(parts);
  return (
    <div className="res-bar" role="img" aria-label={label}>
      {parts.map((p, i) =>
        widths[i]! > 0 ? (
          <span key={p.label} style={{ width: `${widths[i]}%`, background: GROUP_COLORS[i % GROUP_COLORS.length] }} title={`${p.label}: ${formatSize(p.bytes)}`} />
        ) : null,
      )}
    </div>
  );
}

function Legend({ parts }: { parts: { label: string; bytes: number }[] }) {
  return (
    <ul className="res-legend">
      {parts.map((p, i) => (
        <li key={p.label}>
          <span className="res-swatch" style={{ background: GROUP_COLORS[i % GROUP_COLORS.length] }} aria-hidden="true" />
          {p.label} <span className="res-num">{formatSize(p.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

function MemoryGroupRows({ group }: { group: MemoryGroup }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="res-group">
      <div className="res-group-head">
        <h3>{group.label}</h3>
        <span className="res-num">{formatSize(group.bytes)}</span>
      </div>
      <ul className="res-rows">
        {group.branches.map((b, i) => {
          const key = `${b.label}:${b.processes[0]?.pid ?? i}`;
          const many = b.processes.length > 1;
          const isOpen = open.has(key);
          return (
            <li key={key}>
              <div className="res-row">
                {many ? (
                  <button type="button" className="btn btn-ghost res-caret-btn" aria-expanded={isOpen} onClick={() => toggle(key)}>
                    <ChevronRight size={12} className={`res-caret${isOpen ? " open" : ""}`} aria-hidden="true" />
                    {b.label}
                  </button>
                ) : (
                  <span className="res-row-label">{b.label}</span>
                )}
                <span className="res-meta">
                  {many ? `${b.processes.length} processes` : `pid ${b.processes[0]?.pid ?? "?"}`}
                </span>
                <span className="res-num">{formatSize(b.bytes)}</span>
              </div>
              {many && isOpen && (
                <ul className="res-rows res-sub">
                  {b.processes.map((p) => (
                    <li key={p.pid} className="res-row">
                      <span className="res-row-label">{p.name}</span>
                      <span className="res-meta">pid {p.pid}</span>
                      <span className="res-num">{formatSize(p.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiskRow({
  entry,
  depth,
  busy,
  onCleanUp,
}: {
  entry: DiskEntry;
  depth: number;
  busy: string | null;
  onCleanUp(entry: DiskEntry, offer: CleanupOffer): void;
}) {
  const [open, setOpen] = useState(entry.id !== "home-other");
  const kids = entry.children ?? [];
  const offer = entry.cleanup;
  return (
    <li>
      <div className="res-row" style={depth ? { paddingLeft: `${depth * 1.1}rem` } : undefined}>
        {kids.length > 0 ? (
          <button type="button" className="btn btn-ghost res-caret-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <ChevronRight size={12} className={`res-caret${open ? " open" : ""}`} aria-hidden="true" />
            {entry.label}
          </button>
        ) : (
          <span className="res-row-label">{entry.label}</span>
        )}
        {entry.tags?.map((t) => (
          <span key={t} className={`res-tag${t === "uncommitted changes" || t === "repository gone" ? " warn" : ""}`}>
            {t}
          </span>
        ))}
        <span className="res-path" title={entry.path}>
          {entry.path}
        </span>
        <span className="res-num">{formatSize(entry.bytes)}</span>
        <span className="res-action">
          {offer && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null || offer.blocked !== undefined}
              title={offer.blocked ?? `Frees about ${formatSize(offer.bytes)}`}
              onClick={() => onCleanUp(entry, offer)}
            >
              {busy === entry.id ? "Working…" : offer.label}
            </button>
          )}
        </span>
      </div>
      {kids.length > 0 && open && (
        <ul className="res-rows">
          {kids.map((k) => (
            <DiskRow key={k.id} entry={k} depth={depth + 1} busy={busy} onCleanUp={onCleanUp} />
          ))}
        </ul>
      )}
    </li>
  );
}

export interface ResourcesPanelProps {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  fetcher?: Fetcher;
  /** How often memory is measured again; tests shorten it. */
  pollMs?: number;
}

export function ResourcesPanel({ confirm, fetcher, pollMs = MEMORY_POLL_MS }: ResourcesPanelProps) {
  const doFetch: Fetcher = fetcher ?? ((url, init) => fetch(url, init));
  const fetchRef = useRef(doFetch);
  fetchRef.current = doFetch;

  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSnapshot | null>(null);
  const [diskError, setDiskError] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetchRef.current(MEMORY_URL);
      if (!res.ok) throw new Error(await errorOf(res));
      setMemory((await res.json()) as MemorySnapshot);
      setMemoryError(null);
    } catch (e) {
      setMemoryError((e as Error).message);
    }
  }, []);

  // Measured now, then every few seconds while the window is in view.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined || document.visibilityState === "hidden") return;
      void loadMemory();
      timer = setInterval(() => void loadMemory(), pollMs);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadMemory, pollMs]);

  const loadDisk = useCallback(async (refresh: boolean) => {
    setMeasuring(true);
    try {
      const res = await fetchRef.current(refresh ? `${DISK_URL}?refresh=1` : DISK_URL);
      if (!res.ok) throw new Error(await errorOf(res));
      setDisk((await res.json()) as DiskSnapshot);
      setDiskError(null);
    } catch (e) {
      setDiskError((e as Error).message);
    } finally {
      setMeasuring(false);
    }
  }, []);
  useEffect(() => {
    void loadDisk(false);
  }, [loadDisk]);

  const cleanUp = async (entry: DiskEntry, offer: CleanupOffer) => {
    if (busy) return;
    const prompt = cleanupPrompt(entry, offer);
    if (!(await confirm({ ...prompt, danger: true }))) return;
    setBusy(entry.id);
    try {
      const res = await fetchRef.current(CLEANUP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: offer.kind, ...(offer.target ? { target: offer.target } : {}), ...(offer.force ? { force: true } : {}) }),
      });
      if (!res.ok) {
        toast.error(await errorOf(res));
      } else {
        const { freedBytes } = (await res.json()) as { freedBytes: number };
        toast.success(`Freed ${formatSize(freedBytes)}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      await loadDisk(true);
    }
  };

  const memoryParts = memory?.groups.map((g) => ({ label: g.label, bytes: g.bytes })) ?? [];
  const diskParts = disk?.groups.map((g) => ({ label: g.label, bytes: g.bytes })) ?? [];

  return (
    <>
      <PageSection
        id={MEMORY_SECTION}
        title="Memory"
        panel
        className="res-panel"
        hint={
          <>
            Resident memory of SpecDriven and every process it started, measured every {Math.round(pollMs / 1000)} seconds.
            Approximate: memory that processes share is counted in each of them.
            {memory && !memory.desktop ? " The browser tab showing this page is not counted." : ""}
          </>
        }
      >
        {memoryError && (
          <p className="log-error" role="alert">
            {memoryError}
          </p>
        )}
        {memory?.error && (
          <p className="log-error" role="status">
            Could not read the process list ({memory.error}); only SpecDriven's own processes are counted.
          </p>
        )}
        {memory ? (
          <>
            <div className="res-total">
              <strong className="res-num">{formatSize(memory.totalBytes)}</strong>
              <span className="res-meta">of {formatSize(memory.systemBytes)} on this computer</span>
            </div>
            <Bar parts={memoryParts} label={`Memory by group: ${memoryParts.map((p) => `${p.label} ${formatSize(p.bytes)}`).join(", ")}`} />
            <Legend parts={memoryParts} />
            {memory.groups.map((g) => (
              <MemoryGroupRows key={g.id} group={g} />
            ))}
          </>
        ) : (
          !memoryError && <p className="page-empty res-pad">Measuring…</p>
        )}
      </PageSection>
      <PageSection
        id={DISK_SECTION}
        title="Disk"
        className="res-panel"
        hint="Every folder SpecDriven keeps things in, measured when this tab opens. Links are not followed, so a folder counts once."
      >
        <div className="res-toolbar">
          {disk && (
            <>
              <strong className="res-num">{formatSize(disk.totalBytes)}</strong>
              <span className="res-meta">
                in all
                {disk.volumes.map((v) => ` · ${formatSize(v.freeBytes)} free of ${formatSize(v.totalBytes)}`).join("")}
              </span>
            </>
          )}
          <button
            type="button"
            className="ibtn res-refresh"
            aria-label="Measure disk again"
            title="Refresh"
            disabled={measuring}
            onClick={() => void loadDisk(true)}
          >
            <RefreshCw size={14} aria-hidden="true" className={measuring ? "spin" : undefined} />
          </button>
        </div>
        {diskError && (
          <p className="log-error" role="alert">
            {diskError}
          </p>
        )}
        {disk ? (
          <>
            <Bar parts={diskParts} label={`Disk by group: ${diskParts.map((p) => `${p.label} ${formatSize(p.bytes)}`).join(", ")}`} />
            <Legend parts={diskParts} />
            {disk.groups.map((g) => (
              <div key={g.id} className="res-group">
                <div className="res-group-head">
                  <h3>{g.label}</h3>
                  <span className="res-num">{formatSize(g.bytes)}</span>
                </div>
                <ul className="res-rows">
                  {g.entries.map((e) => (
                    <DiskRow key={e.id} entry={e} depth={0} busy={busy} onCleanUp={(entry, offer) => void cleanUp(entry, offer)} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : (
          !diskError && <p className="page-empty res-pad">Measuring… a large folder can take a few seconds.</p>
        )}
      </PageSection>
    </>
  );
}
