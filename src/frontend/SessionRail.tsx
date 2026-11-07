// The session popover of the coding agent pane (specs/agents/agent-pane
// .feature.md S10), as in Claude Desktop: a ring in the pane's header that
// says how full the context window is, opening on the folder the session
// works in, its branch or worktree, and the context window by category.
//
// The count is the agent's (AgentHost.context, src/server/agentChat.ts):
// Claude says what fills the window, Codex only how much, Pi nothing. Every
// helper below is pure, so the pane's tests pin the numbers and the words.

import { ChevronRight, Copy, Folder, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "./Popover";
import { Tooltip } from "./Tooltip";
import { toast } from "./Toasts";
import {
  agentChat,
  formatPercent,
  formatTokens,
  useFolderInfo,
  type AgentDescriptor,
  type ChatContextUsage,
  type ChatSessionMeta,
  type ContextSlice,
} from "./agentChat";
import { copyText } from "./clipboard";

// --- Paths -------------------------------------------------------------------

function lastPart(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The folder a path sits in: "/a/b/c" → "/a/b"; a root stays itself. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/(?<=[^\\/])[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  if (cut === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, cut);
}

/**
 * A path short enough for one line of the popover: the home folder as `~`,
 * then, past `max` characters, the middle cut out — the start and as many
 * whole folders from the end as fit, as in "~/dev/…/SpecDriven". A single
 * folder name too long by itself is cut in its middle.
 */
export function abbreviatePath(path: string, home: string | null, max = 40): string {
  let p = path;
  if (home) {
    const h = home.replace(/[\\/]+$/, "");
    if (p === h) p = "~";
    else if (p.startsWith(`${h}/`) || p.startsWith(`${h}\\`)) p = `~${p.slice(h.length)}`;
  }
  if (p.length <= max) return p;
  const sep = p.includes("/") ? "/" : "\\";
  const parts = p.split(sep);
  const head = parts[0] === "" ? `${sep}${parts[1] ?? ""}` : parts[0]!;
  const rest = parts.slice(parts[0] === "" ? 2 : 1);
  let tail = "";
  for (let i = rest.length - 1; i >= 0; i--) {
    const next = tail ? `${rest[i]}${sep}${tail}` : rest[i]!;
    if (`${head}${sep}…${sep}${next}`.length > max) break;
    tail = next;
  }
  if (tail) return `${head}${sep}…${sep}${tail}`;
  // Not even the last folder fits after the head: cut characters instead.
  const keep = Math.max(1, Math.floor((max - 1) / 2));
  return `${p.slice(0, keep)}…${p.slice(p.length - (max - 1 - keep))}`;
}

// --- The context window --------------------------------------------------------

/**
 * The meter's colour slots in a fixed order, by what a slice is — never by
 * its size, so a part keeps its colour as it grows. The order is the
 * validated categorical order (blue, orange, aqua, yellow, magenta, violet):
 * the bar draws its parts in it, so neighbours stay told apart.
 */
const SLOTS: readonly string[] = ["mcp_tools", "system_tools", "messages", "system_prompt", "memory_files", "skills"];

/** The CSS colour a slice is drawn in. */
export function sliceColor(slice: Pick<ContextSlice, "id" | "kind">): string {
  if (slice.kind === "free") return "var(--meter-free)";
  if (slice.kind === "buffer") return "var(--meter-buffer)";
  const slot = SLOTS.indexOf(slice.id);
  return slot < 0 ? "var(--meter-other)" : `var(--meter-${slot + 1})`;
}

/** How full the window is, rounded, as the header ring shows it; null when the agent gives no window. */
export function contextPercent(usage: Pick<ChatContextUsage, "totalTokens" | "maxTokens"> | undefined): number | null {
  if (!usage || !usage.maxTokens || usage.maxTokens <= 0) return null;
  return Math.round((100 * usage.totalTokens) / usage.maxTokens);
}

/** One part of the bar, and its row in the legend. */
export interface MeterSegment {
  id: string;
  label: string;
  tokens: number;
  kind: ContextSlice["kind"];
  color: string;
}

/**
 * The bar's parts, left to right: what is used (by slot, then any slice the
 * pane has no colour for), the compaction reserve, then what is free. An
 * agent that gives only totals gets one "Used" part; the reserve comes from
 * where the agent compacts when it sends no slice for it, and free space is
 * what is left. Null when the agent gives no window — there is no whole to
 * split. Parts at zero draw nothing.
 */
export function meterSegments(usage: ChatContextUsage): MeterSegment[] | null {
  const max = usage.maxTokens;
  if (!max || max <= 0) return null;
  const slices = usage.slices ?? [];
  const used = slices.filter((s) => s.kind === "used");
  const ordered = used.length
    ? [...used].sort((a, b) => rank(a.id) - rank(b.id))
    : [{ id: "used", label: "Used", tokens: usage.totalTokens, kind: "used" as const }];
  const bufferSlice = slices.find((s) => s.kind === "buffer");
  const buffer =
    bufferSlice?.tokens ?? (usage.autoCompactAt !== undefined ? Math.max(0, max - usage.autoCompactAt) : 0);
  const freeSlice = slices.find((s) => s.kind === "free");
  const free = freeSlice?.tokens ?? Math.max(0, max - usage.totalTokens - buffer);
  const parts: MeterSegment[] = [
    ...ordered.map((s) => ({ id: s.id, label: s.label, tokens: s.tokens, kind: s.kind, color: sliceColor(s) })),
    {
      id: bufferSlice?.id ?? "buffer",
      label: bufferSlice?.label ?? "Autocompact buffer",
      tokens: buffer,
      kind: "buffer",
      color: sliceColor({ id: "buffer", kind: "buffer" }),
    },
    {
      id: freeSlice?.id ?? "free",
      label: freeSlice?.label ?? "Free space",
      tokens: free,
      kind: "free",
      color: sliceColor({ id: "free", kind: "free" }),
    },
  ];
  return parts.filter((p) => p.tokens > 0);
}

function rank(id: string): number {
  const slot = SLOTS.indexOf(id);
  return slot < 0 ? SLOTS.length : slot;
}

/** How the ring reads: fine, getting full, nearly full. */
export function contextLevel(percent: number | null): "ok" | "warn" | "high" {
  if (percent === null || percent < 70) return "ok";
  return percent < 90 ? "warn" : "high";
}

/** The one line the header's tooltip and the popover's head say of the window. */
export function contextHeadline(usage: ChatContextUsage): { left: string; right: string } {
  const pct = contextPercent(usage);
  if (pct === null) return { left: `${formatTokens(usage.totalTokens)} used`, right: "" };
  return { left: `${pct}% used`, right: `${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens!)}` };
}

// --- The header button -----------------------------------------------------------

/** A 14px ring filled to the share of the window in use; empty while unknown. */
export function ContextRing({ percent }: { percent: number | null }) {
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  const filled = percent === null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * circ;
  return (
    <svg className="agent-rail-ring" data-level={contextLevel(percent)} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="agent-rail-ring-track" cx="7" cy="7" r={r} fill="none" strokeWidth="2" />
      {filled > 0 && (
        <circle
          className="agent-rail-ring-fill"
          cx="7"
          cy="7"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circ}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

/**
 * The header's "Session details" button: the ring and, once the agent gave
 * a window, how full it is; it opens the popover below.
 */
export function SessionRailButton({
  meta,
  agent,
  homeDir,
  defaultOpen = false,
}: {
  meta: ChatSessionMeta;
  agent: AgentDescriptor;
  homeDir: string | null;
  /** Tests: render the popover open. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const percent = contextPercent(meta.context);
  const folder = meta.worktree?.folder ?? meta.cwd;
  const tip = [
    lastPart(folder),
    meta.worktree?.branch,
    meta.context ? `Context ${contextHeadline(meta.context).left}${percent !== null ? ` (${contextHeadline(meta.context).right})` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="agent-rail-anchor">
      <Tooltip label={open ? "Session details" : tip || "Session details"}>
        <button
          type="button"
          className="ibtn agent-rail-btn"
          aria-label="Session details"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ContextRing percent={percent} />
          {percent !== null && <span className="agent-rail-pct">{percent}%</span>}
        </button>
      </Tooltip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        label="Session details"
        className="agent-rail-popover"
        containerSelector=".agent-rail-anchor"
      >
        <SessionRail meta={meta} agent={agent} homeDir={homeDir} />
      </Popover>
    </div>
  );
}

// --- The popover -------------------------------------------------------------------

async function copy(text: string, what: string): Promise<void> {
  if (await copyText(text)) toast.success(`Copied the ${what}`);
  else toast.error(`Could not copy the ${what}`);
}

function CopyButton({ text, what }: { text: string; what: string }) {
  return (
    <Tooltip label={`Copy the ${what}`}>
      <button type="button" className="ibtn agent-rail-copy" aria-label={`Copy the ${what}`} onClick={() => void copy(text, what)}>
        <Copy size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** The popover's content: folder, branch, context window. */
export function SessionRail({
  meta,
  agent,
  homeDir,
}: {
  meta: ChatSessionMeta;
  agent: AgentDescriptor;
  homeDir: string | null;
}) {
  const folder = meta.worktree?.folder ?? meta.cwd;
  const parent = parentPath(folder);
  // Focus lands on the popover itself, not its first control: that one's
  // tooltip would open at once and cover the row below it. Tab goes on in.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  return (
    <div className="agent-rail" ref={root} tabIndex={-1}>
      <div className="agent-rail-row" data-row="folder">
        <Folder size={15} aria-hidden="true" className="agent-rail-icon" />
        <Tooltip label={folder}>
          <span className="agent-rail-value" tabIndex={0}>
            <span className="agent-rail-name">{lastPart(folder)}</span>
            {parent && <span className="agent-rail-path"> · {abbreviatePath(parent, homeDir)}</span>}
          </span>
        </Tooltip>
        <CopyButton text={folder} what="folder path" />
      </div>
      <BranchRow meta={meta} homeDir={homeDir} />
      <ContextSection meta={meta} agent={agent} />
    </div>
  );
}

function BranchRow({ meta, homeDir }: { meta: ChatSessionMeta; homeDir: string | null }) {
  const wt = meta.worktree;
  // A session in the folder itself: the branch the folder has checked out.
  const info = useFolderInfo(wt ? null : meta.cwd);
  if (wt) {
    return (
      <div className="agent-rail-row" data-row="branch">
        <GitBranch size={15} aria-hidden="true" className="agent-rail-icon" />
        <div className="agent-rail-value">
          <span className="agent-rail-name agent-rail-mono">{wt.branch}</span>
          <Tooltip label={wt.path}>
            <span className="agent-rail-sub" tabIndex={0}>
              {`${wt.base ? `off ${wt.base} · ` : ""}${abbreviatePath(wt.path, homeDir)}`}
            </span>
          </Tooltip>
        </div>
        <span className="chip muted agent-rail-tag">Worktree</span>
        <CopyButton text={wt.path} what="worktree path" />
      </div>
    );
  }
  const branch = info?.branch;
  return (
    <div className="agent-rail-row" data-row="branch">
      <GitBranch size={15} aria-hidden="true" className="agent-rail-icon" />
      {branch ? (
        <span className="agent-rail-value agent-rail-name agent-rail-mono">{branch}</span>
      ) : (
        <span className="agent-rail-value agent-rail-quiet">{info ? "Not in a git repository" : "…"}</span>
      )}
    </div>
  );
}

function ContextSection({ meta, agent }: { meta: ChatSessionMeta; agent: AgentDescriptor }) {
  const [refreshing, setRefreshing] = useState(false);
  const can = agent.capabilities.contextUsage;
  const usage = meta.context;
  const idle = meta.status === "idle";
  const refresh = () => {
    setRefreshing(true);
    void agentChat
      .refreshContext(meta.id, "full")
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setRefreshing(false));
  };
  return (
    <section className="agent-rail-context" aria-label="Context">
      <div className="agent-rail-head">
        <span>Context</span>
        {can === "breakdown" && (
          <Tooltip label={idle ? "Count every category again" : "Counts again once the turn is over"}>
            <button
              type="button"
              className="ibtn agent-rail-refresh"
              aria-label="Refresh the context count"
              disabled={!idle || refreshing}
              data-busy={refreshing || undefined}
              onClick={refresh}
            >
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      {!can && !usage ? (
        <p className="agent-rail-note">{agent.label} does not report its context usage.</p>
      ) : !usage ? (
        <p className="agent-rail-note">Counted once the first turn is over.</p>
      ) : (
        <ContextMeter usage={usage} />
      )}
    </section>
  );
}

/** The headline, the bar, the legend and the lists under it. */
export function ContextMeter({ usage }: { usage: ChatContextUsage }) {
  const head = contextHeadline(usage);
  const segments = meterSegments(usage);
  const max = usage.maxTokens ?? 0;
  const lists = (usage.slices ?? []).filter((s) => s.items && s.items.length > 0);
  const deferred = (usage.slices ?? []).filter((s) => s.kind === "deferred" && s.tokens > 0);
  const time = new Date(usage.at);
  const when = Number.isNaN(time.getTime())
    ? ""
    : ` · ${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return (
    <div className="agent-meter-wrap">
      <div className="agent-meter-headline">
        <span>{head.left}</span>
        {head.right && <span className="agent-meter-of">{head.right}</span>}
      </div>
      {segments && (
        <div
          className="agent-meter"
          role="img"
          aria-label={segments.map((s) => `${s.label} ${formatTokens(s.tokens)} (${formatPercent(s.tokens, max)})`).join(", ")}
        >
          {segments.map((s) => (
            <span
              key={`${s.kind}:${s.id}`}
              className="agent-meter-seg"
              data-slice={s.id}
              data-kind={s.kind}
              style={{ flexGrow: s.tokens, background: s.color }}
            />
          ))}
        </div>
      )}
      {segments && segments.length > 1 && (
        <ul className="agent-meter-legend">
          {segments.map((s) => (
            <li key={`${s.kind}:${s.id}`} data-slice={s.id} data-kind={s.kind}>
              <span className="agent-meter-swatch" style={{ background: s.color }} aria-hidden="true" />
              <span className="agent-meter-label">{s.label}</span>
              <span className="agent-meter-num">{formatTokens(s.tokens)}</span>
              <span className="agent-meter-num agent-meter-pct">{formatPercent(s.tokens, max)}</span>
            </li>
          ))}
          {deferred.map((s) => (
            <li key={`deferred:${s.id}`} data-slice={s.id} data-kind="deferred">
              <span className="agent-meter-swatch" aria-hidden="true" />
              <span className="agent-meter-label">{s.label}</span>
              <span className="agent-meter-num">{formatTokens(s.tokens)}</span>
              <span className="agent-meter-num agent-meter-pct">not loaded</span>
            </li>
          ))}
        </ul>
      )}
      {lists.length > 0 && (
        <div className="agent-rail-lists">
          {lists.map((s) => (
            <details key={`${s.kind}:${s.id}`} className="agent-rail-items" data-slice={s.id}>
              <summary>
                <span className="agent-rail-items-label">{s.label}</span>
                <span className="agent-rail-items-count">{s.items!.length}</span>
                <ChevronRight size={13} aria-hidden="true" className="agent-rail-items-chevron" />
              </summary>
              <ul>
                {[...s.items!]
                  .sort((a, b) => b.tokens - a.tokens)
                  .map((item, i) => (
                    <li key={`${item.name}:${i}`}>
                      <span className="agent-rail-item-name" title={item.name}>
                        {item.name}
                      </span>
                      {item.detail && <span className="agent-rail-item-detail">{item.detail}</span>}
                      <span className="agent-meter-num">{formatTokens(item.tokens)}</span>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      <p className="agent-rail-note">
        {usage.detail === "measured" ? "Measured" : "Estimated after the last turn"}
        {when}
      </p>
    </div>
  );
}
