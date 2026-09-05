// Coding agent pane, client side (specs/agents/coding-agent-ui.feature.md):
// the store behind src/frontend/AgentPane.tsx. A module-level store read
// through useSyncExternalStore (the src/frontend/Toasts.tsx pattern) rather
// than more state in App.tsx: the pane's sessions, their transcripts and
// the event streams feeding them outlive any one render, and App.tsx only
// needs to know whether the pane is open and how wide it is.
//
// The transcript is a reduction of the server's event log
// (src/server/agentChat.ts): streamed text deltas become one assistant item
// that the final message then replaces, tool calls pair up with their
// results, permission requests become cards that resolve in place. Every
// event carries a sequence number; a stream that drops is reopened from
// the last one seen, so nothing is lost or shown twice.

import { useSyncExternalStore } from "react";
import type {
  AssistantBlock,
  ChatAgent,
  ChatEvent,
  ChatSessionMeta,
  ChatStatus,
  PermissionMode,
  SlashCommandInfo,
} from "../server/agentChat";
import { toast } from "./Toasts";

export type {
  ChatAgent,
  ChatEvent,
  ChatSessionMeta,
  ChatStatus,
  PermissionMode,
  SlashCommandInfo,
};

/** What the pane calls each agent. */
export const AGENT_LABEL: Record<ChatAgent, string> = { claude: "Claude", pi: "Pi" };

// --- Transcript ------------------------------------------------------------

export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; at: string }
  | {
      kind: "assistant";
      id: string;
      /** What to show: the final text once it is in, the stream until then. */
      text: string;
      streaming: boolean;
      streamText: string;
      finalParts: string[];
      at: string;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      summary: string;
      result?: { content: string; isError: boolean };
      at: string;
    }
  | {
      kind: "permission";
      id: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
      /** The SDK's suggested rules — "Allow always" sends them back. */
      suggestions: unknown[];
      title?: string;
      resolved?: { behavior: "allow" | "deny"; via: string };
      at: string;
    }
  | {
      kind: "question";
      id: string;
      requestId: string;
      questions: Question[];
      resolved?: { behavior: "allow" | "deny"; via: string };
      at: string;
    }
  | {
      kind: "result";
      id: string;
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      durationMs: number;
      numTurns: number;
      text?: string;
      at: string;
    }
  | { kind: "note"; id: string; level: "info" | "error"; code: string; text: string; at: string };

export interface Transcript {
  items: TranscriptItem[];
  /** Item id → position in `items`. */
  index: Record<string, number>;
  lastSeq: number;
}

export const EMPTY_TRANSCRIPT: Transcript = { items: [], index: {}, lastSeq: 0 };

function withItem(t: Transcript, item: TranscriptItem): Transcript {
  const at = t.index[item.id];
  if (at === undefined) {
    return { ...t, items: [...t.items, item], index: { ...t.index, [item.id]: t.items.length } };
  }
  const items = t.items.slice();
  items[at] = item;
  return { ...t, items };
}

function itemOf<K extends TranscriptItem["kind"]>(
  t: Transcript,
  id: string,
  kind: K,
): Extract<TranscriptItem, { kind: K }> | null {
  const at = t.index[id];
  const item = at === undefined ? undefined : t.items[at];
  return item && item.kind === kind ? (item as Extract<TranscriptItem, { kind: K }>) : null;
}

function isQuestions(value: unknown): value is Question[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (q) =>
        q && typeof q === "object" && typeof (q as Question).question === "string" && Array.isArray((q as Question).options),
    )
  );
}

/** Fold one server event into the transcript. Events already seen are skipped. */
export function applyEvent(t: Transcript, ev: ChatEvent): Transcript {
  if (ev.seq <= t.lastSeq) return t;
  const next = { ...t, lastSeq: ev.seq };
  switch (ev.kind) {
    case "user":
      return withItem(next, { kind: "user", id: `u:${ev.id}`, text: ev.text, at: ev.at });
    case "text_delta": {
      const id = `a:${ev.messageId}`;
      const current = itemOf(next, id, "assistant");
      const streamText = (current?.streamText ?? "") + ev.text;
      const finalParts = current?.finalParts ?? [];
      return withItem(next, {
        kind: "assistant",
        id,
        streamText,
        finalParts,
        text: finalParts.length > 0 ? finalParts.join("") : streamText,
        streaming: true,
        at: current?.at ?? ev.at,
      });
    }
    case "assistant": {
      let out = next;
      const id = `a:${ev.messageId}`;
      const texts = ev.blocks.filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text");
      if (texts.length > 0) {
        const current = itemOf(out, id, "assistant");
        const finalParts = [...(current?.finalParts ?? []), ...texts.map((b) => b.text)];
        out = withItem(out, {
          kind: "assistant",
          id,
          streamText: current?.streamText ?? "",
          finalParts,
          text: finalParts.join(""),
          streaming: false,
          at: current?.at ?? ev.at,
        });
      }
      for (const block of ev.blocks) {
        if (block.type !== "tool_use") continue;
        const tid = `t:${block.id}`;
        const placeholder = itemOf(out, tid, "tool");
        out = withItem(out, {
          kind: "tool",
          id: tid,
          name: block.name,
          input: block.input,
          summary: toolSummary(block.name, block.input),
          ...(placeholder?.result ? { result: placeholder.result } : {}),
          at: placeholder?.at ?? ev.at,
        });
      }
      return out;
    }
    case "tool_result": {
      const tid = `t:${ev.toolUseId}`;
      const tool = itemOf(next, tid, "tool");
      return withItem(next, {
        kind: "tool",
        id: tid,
        name: tool?.name ?? "",
        input: tool?.input ?? null,
        summary: tool?.summary ?? "",
        result: { content: ev.content, isError: ev.isError },
        at: tool?.at ?? ev.at,
      });
    }
    case "permission_request": {
      const id = `p:${ev.requestId}`;
      if (ev.toolName === "AskUserQuestion" && isQuestions(ev.input.questions)) {
        return withItem(next, {
          kind: "question",
          id,
          requestId: ev.requestId,
          questions: ev.input.questions,
          at: ev.at,
        });
      }
      return withItem(next, {
        kind: "permission",
        id,
        requestId: ev.requestId,
        toolName: ev.toolName,
        input: ev.input,
        summary: toolSummary(ev.toolName, ev.input),
        suggestions: ev.suggestions,
        ...(ev.title ? { title: ev.title } : {}),
        at: ev.at,
      });
    }
    case "permission_resolved": {
      const id = `p:${ev.requestId}`;
      const at = next.index[id];
      const item = at === undefined ? undefined : next.items[at];
      if (!item || (item.kind !== "permission" && item.kind !== "question")) return next;
      return withItem(next, { ...item, resolved: { behavior: ev.behavior, via: ev.via } });
    }
    case "result": {
      // The turn is over: nothing is streaming any more.
      const items = next.items.map((item) =>
        item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item,
      );
      // The result text is the reply's last words; shown only when the
      // transcript does not already end on them.
      const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant");
      const text = ev.text && ev.text.trim() !== lastAssistant?.text.trim() ? ev.text : undefined;
      return withItem(
        { ...next, items },
        {
          kind: "result",
          id: `r:${ev.seq}`,
          subtype: ev.subtype,
          isError: ev.isError,
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
          numTurns: ev.numTurns,
          ...(text ? { text } : {}),
          at: ev.at,
        },
      );
    }
    case "note":
      return withItem(next, {
        kind: "note",
        id: `n:${ev.seq}`,
        level: ev.level,
        code: ev.code,
        text: ev.text,
        at: ev.at,
      });
    default:
      return next;
  }
}

/** The one line that says what a tool call is about. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : null);
  switch (name) {
    case "Bash":
      return str("command") ?? str("description") ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str("file_path") ?? str("notebook_path") ?? "";
    case "Grep":
    case "Glob":
      return str("pattern") ?? "";
    case "WebFetch":
      return str("url") ?? "";
    case "WebSearch":
      return str("query") ?? "";
    case "Task":
    case "Agent":
      return str("description") ?? str("prompt") ?? "";
    case "Skill":
      return str("skill") ?? str("command") ?? "";
    default: {
      for (const value of Object.values(i)) {
        if (typeof value === "string" && value.trim()) return value;
      }
      return "";
    }
  }
}

// --- Slash commands --------------------------------------------------------

export const SLASH_LIMIT = 8;

/**
 * The "/" popup's contents for a draft: active only while the caret is in
 * the first word and that word starts with "/". Names that start with the
 * typed text rank above names that merely contain it.
 */
export function filterCommands(
  commands: SlashCommandInfo[],
  draft: string,
  caret: number,
): { active: boolean; query: string; items: SlashCommandInfo[] } {
  const head = draft.slice(0, Math.max(0, Math.min(caret, draft.length)));
  if (!draft.startsWith("/") || /\s/.test(head)) return { active: false, query: "", items: [] };
  const query = head.slice(1).toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const contains = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query),
  );
  const byName = (a: SlashCommandInfo, b: SlashCommandInfo) => a.name.localeCompare(b.name);
  const items = [...starts.sort(byName), ...contains.sort(byName)].slice(0, SLASH_LIMIT);
  return { active: true, query, items };
}

/** The draft after picking a command: the name, ready for its arguments. */
export function applyCommand(command: SlashCommandInfo): string {
  return `/${command.name} `;
}

// --- Geometry --------------------------------------------------------------

export const AGENT_MIN_WIDTH = 320;
export const AGENT_DEFAULT_WIDTH = 420;

/** Between the minimum and 60% of the window — the editor keeps the rest. */
export function clampAgentWidth(width: number, innerWidth: number): number {
  const max = Math.max(AGENT_MIN_WIDTH, Math.round(innerWidth * 0.6));
  return Math.min(max, Math.max(AGENT_MIN_WIDTH, Math.round(width)));
}

/** Whether the transcript should keep scrolling to new items: it does while
    the user is within `slack` px of the bottom. */
export function shouldFollow(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  slack = 48,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

/**
 * The name a session gets when the user types none —
 * "Session 2026-09-04 15:30:30 PDT" (specs/launch-ai-agent-session.feature.md
 * step 8): local time, with the zone's short name so the log reads the same
 * from anywhere.
 */
export function defaultSessionName(date: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return zone ? `Session ${stamp} ${zone}` : `Session ${stamp}`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function isFinalStatus(status: ChatStatus): boolean {
  return status === "ended" || status === "error";
}

// --- Persistence (device-local, like the sidebar width) --------------------

const WIDTH_KEY = "sd-agent-width";
const OPEN_KEY = "sd-agent-open";
const ACTIVE_KEY = "sd-agent-session";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or no storage: the pane just forgets.
  }
}

export function readAgentWidth(): number {
  const n = Number(readLocal(WIDTH_KEY));
  const inner = typeof window === "undefined" ? 1280 : window.innerWidth;
  return Number.isFinite(n) && n > 0 ? clampAgentWidth(n, inner) : AGENT_DEFAULT_WIDTH;
}

export function readAgentOpen(): boolean {
  return readLocal(OPEN_KEY) === "1";
}

// --- The store -------------------------------------------------------------

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "closed";

export interface SessionState {
  meta: ChatSessionMeta;
  commands: SlashCommandInfo[];
  transcript: Transcript;
  connection: Connection;
}

export interface AgentChatStore {
  open: boolean;
  width: number;
  activeId: string | null;
  sessions: Record<string, SessionState>;
  /** Every session the server knows, newest first. */
  list: ChatSessionMeta[];
  /** Whether the Claude CLI is there (from /api/state). */
  available: boolean;
  /** Whether the Pi CLI is there — a pane session can run on either. */
  piAvailable: boolean;
}

let state: AgentChatStore = {
  open: false,
  width: AGENT_DEFAULT_WIDTH,
  activeId: null,
  sessions: {},
  list: [],
  available: false,
  piAvailable: false,
};
const listeners = new Set<() => void>();
const streams = new Map<string, AbortController>();

function set(patch: Partial<AgentChatStore>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function setSession(id: string, patch: Partial<SessionState>): void {
  const current = state.sessions[id];
  if (!current) return;
  set({ sessions: { ...state.sessions, [id]: { ...current, ...patch } } });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useAgentChat(): AgentChatStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** For tests and the odd imperative read. */
export function agentChatState(): AgentChatStore {
  return state;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Apply one event: transcript, and the bits of meta that events carry. */
function receive(id: string, ev: ChatEvent): void {
  const s = state.sessions[id];
  if (!s || ev.seq <= s.transcript.lastSeq) return;
  const meta = { ...s.meta, lastSeq: ev.seq };
  let commands = s.commands;
  if (ev.kind === "status") {
    meta.status = ev.status;
    if (ev.agentSessionId) meta.agentSessionId = ev.agentSessionId;
    if (ev.model) meta.model = ev.model;
    if (ev.permissionMode) meta.permissionMode = ev.permissionMode;
    if (ev.commands) commands = ev.commands;
    if (isFinalStatus(ev.status)) meta.endedAt = ev.at;
  } else if (ev.kind === "mode") {
    meta.permissionMode = ev.permissionMode;
  }
  setSession(id, { meta, commands, transcript: applyEvent(s.transcript, ev) });
  set({ list: state.list.map((m) => (m.id === id ? meta : m)) });
  // A question nobody is looking at would hang the session in silence.
  if (ev.kind === "permission_request" && (!state.open || state.activeId !== id)) {
    const who = AGENT_LABEL[s.meta.agent] ?? "The agent";
    toast.info(`${who} is waiting for your approval in the coding agent pane`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the session's event stream until it ends, reopening it from the last
 * sequence seen whenever it drops before the session is final.
 */
async function stream(id: string): Promise<void> {
  streams.get(id)?.abort();
  const ctrl = new AbortController();
  streams.set(id, ctrl);
  let backoff = 500;
  let first = true;
  while (!ctrl.signal.aborted) {
    const s = state.sessions[id];
    if (!s) return;
    if (isFinalStatus(s.meta.status)) {
      setSession(id, { connection: "closed" });
      return;
    }
    setSession(id, { connection: first ? "connecting" : "reconnecting" });
    try {
      const res = await fetch(`/api/agent/chat/${id}/events?after=${s.transcript.lastSeq}`, {
        signal: ctrl.signal,
        headers: { accept: "application/x-ndjson" },
      });
      if (res.status === 404) {
        // Gone from the server (ended elsewhere, or a restart).
        forget(id);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setSession(id, { connection: "live" });
      backoff = 500;
      first = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            receive(id, JSON.parse(line) as ChatEvent);
          } catch {
            // A torn line; the next reconnect replays from lastSeq.
          }
        }
      }
    } catch {
      if (ctrl.signal.aborted) return;
    }
    const now = state.sessions[id];
    if (!now || isFinalStatus(now.meta.status)) {
      if (now) setSession(id, { connection: "closed" });
      return;
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 5000);
  }
}

function forget(id: string): void {
  streams.get(id)?.abort();
  streams.delete(id);
  const sessions = { ...state.sessions };
  delete sessions[id];
  const list = state.list.filter((m) => m.id !== id);
  const activeId =
    state.activeId === id ? (list.find((m) => sessions[m.id])?.id ?? list[0]?.id ?? null) : state.activeId;
  set({ sessions, list, activeId });
  writeLocal(ACTIVE_KEY, activeId);
  // The next session may be known only from the list — load it so the pane shows it.
  if (activeId && !sessions[activeId]) void agentChat.openSession(activeId).catch(() => undefined);
}

export interface CreateSessionOptions {
  name: string;
  /** Which agent drives the chat; absent is Claude. */
  agent?: ChatAgent;
  prompt?: string;
  permissionMode?: PermissionMode;
}

export const agentChat = {
  setAvailable(available: boolean, piAvailable = state.piAvailable): void {
    if (available !== state.available || piAvailable !== state.piAvailable) {
      set({ available, piAvailable });
    }
  },
  openPane(): void {
    if (!state.open) set({ open: true });
    writeLocal(OPEN_KEY, "1");
  },
  closePane(): void {
    if (state.open) set({ open: false });
    writeLocal(OPEN_KEY, "0");
  },
  togglePane(): void {
    if (state.open) agentChat.closePane();
    else agentChat.openPane();
  },
  setWidth(width: number, persist = true): void {
    if (width !== state.width) set({ width });
    if (persist) writeLocal(WIDTH_KEY, String(width));
  },
  /** Show a session; one not yet loaded is fetched and streamed. */
  setActive(id: string | null): void {
    set({ activeId: id });
    writeLocal(ACTIVE_KEY, id);
    if (id && !state.sessions[id]) void agentChat.openSession(id);
  },
  /** Fetch the whole transcript, then follow the live stream. */
  async openSession(id: string): Promise<void> {
    const data = await call<{ meta: ChatSessionMeta; commands: SlashCommandInfo[]; events: ChatEvent[] }>(
      `/api/agent/chat/${id}`,
    );
    let transcript = EMPTY_TRANSCRIPT;
    for (const ev of data.events) transcript = applyEvent(transcript, ev);
    const session: SessionState = {
      meta: data.meta,
      commands: data.commands,
      transcript,
      connection: "idle",
    };
    const known = state.list.some((m) => m.id === id);
    set({
      sessions: { ...state.sessions, [id]: session },
      list: known ? state.list.map((m) => (m.id === id ? data.meta : m)) : [data.meta, ...state.list],
      activeId: id,
    });
    writeLocal(ACTIVE_KEY, id);
    void stream(id);
  },
  /** Start a chat and show it. Throws with the server's words on failure. */
  async createSession(opts: CreateSessionOptions): Promise<string> {
    const meta = await call<ChatSessionMeta>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    await agentChat.openSession(meta.id);
    agentChat.openPane();
    return meta.id;
  },
  async refreshList(): Promise<void> {
    const data = await call<{ sessions: ChatSessionMeta[] }>("/api/agent/chat");
    set({ list: data.sessions });
    for (const id of Object.keys(state.sessions)) {
      if (!data.sessions.some((m) => m.id === id)) forget(id);
    }
  },
  /** On boot: the remembered pane state, and the remembered session if it is
      still there. */
  async restore(): Promise<void> {
    set({ width: readAgentWidth(), open: readAgentOpen() });
    try {
      await agentChat.refreshList();
    } catch {
      return;
    }
    const remembered = readLocal(ACTIVE_KEY);
    const pick = state.list.find((m) => m.id === remembered) ?? state.list[0];
    if (pick) await agentChat.openSession(pick.id).catch(() => undefined);
  },
  async send(id: string, text: string): Promise<void> {
    await call(`/api/agent/chat/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
  },
  async answer(
    id: string,
    answer: {
      requestId: string;
      behavior: "allow" | "deny";
      message?: string;
      updatedInput?: Record<string, unknown>;
      remember?: boolean;
    },
  ): Promise<void> {
    await call(`/api/agent/chat/${id}/permission`, { method: "POST", body: JSON.stringify(answer) });
  },
  async interrupt(id: string): Promise<void> {
    await call(`/api/agent/chat/${id}/interrupt`, { method: "POST" });
  },
  async setMode(id: string, permissionMode: PermissionMode): Promise<void> {
    await call(`/api/agent/chat/${id}/mode`, {
      method: "PUT",
      body: JSON.stringify({ permissionMode }),
    });
  },
  async end(id: string): Promise<void> {
    await call(`/api/agent/chat/${id}`, { method: "DELETE" }).catch((e: Error) => {
      if (!/not found/.test(e.message)) throw e;
    });
    forget(id);
  },
};
