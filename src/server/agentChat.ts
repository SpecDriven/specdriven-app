// Coding agent pane (specs/agents/agent-pane.feature.md,
// specs/agents/agent-plugins.feature.md): the app drives a live coding
// agent session itself, for developers who have a CLI but not Claude Code
// Desktop. Which agent is a provider's business (src/plugins/host/agents.ts
// — Claude, Codex and Pi today, src/server/agents/*; a plugin's tomorrow).
// This engine owns what every session has in common: the event log, the
// permission cards, the turn count, the session record, and the routes'
// API. A provider gets an AgentHost over one session and nothing else.
//
// Every message the agent produces becomes an event in an in-memory log
// with a sequence number; the browser reads the log over a one-way stream
// and, on reconnect, asks for everything after the last sequence it saw.
//
// Node APIs only (src/server/run.ts): this module also runs inside Electron.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sessionWorkDir } from "./agent";
import type { SessionPlace } from "./agent";
import type {
  AgentHost,
  AgentProvider,
  AgentReadyInfo,
  AgentSession,
  PermissionDecision,
  PermissionOutcome,
  PermissionRequest,
} from "../plugins/host/agents";
import { AgentError, agents } from "../plugins/host/agents";
import type {
  ChatAgent,
  ChatEvent,
  ChatEventBody,
  ChatSessionMeta,
  ChatStatus,
  PermissionAnswer,
  PermissionMode,
  PermissionSuggestion,
  SlashCommandInfo,
} from "./agentTypes";
import { isFinalStatus, normalizePermissionMode, PERMISSION_MODES } from "./agentTypes";
import { writeTextFile } from "./fsx";

// The types the routes, the client and the tests share live in
// src/server/agentTypes.ts; re-exported here for one release.
export type {
  AgentCapabilities,
  AgentDescriptor,
  AgentOffer,
  AssistantBlock,
  ChatAccount,
  ChatAgent,
  ChatEvent,
  ChatEventBody,
  ChatSessionMeta,
  ChatStatus,
  PermissionAnswer,
  PermissionMode,
  PermissionSuggestion,
  SlashCommandInfo,
} from "./agentTypes";
export { isFinalStatus, normalizePermissionMode, PERMISSION_MODES };

/** An HTTP-shaped failure: the route turns `status` into the response code. */
export class ChatError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Live sessions at once — each is an agent subprocess. */
export const MAX_LIVE_SESSIONS = 8;

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  resolve: (outcome: PermissionOutcome) => void;
}

interface ChatSession {
  meta: ChatSessionMeta;
  log: ChatEvent[];
  listeners: Set<(event: ChatEvent) => void>;
  provider: AgentProvider;
  /** The provider's side, once start() resolved. */
  session: AgentSession | null;
  /** Fires on end and on shutdown; the provider kills its child on it. */
  abort: AbortController;
  pending: Map<string, PendingPermission>;
  /** A user message is in and its result is not yet out. */
  busy: boolean;
  turn: number;
  commands: SlashCommandInfo[];
  recordPath: string;
  /** Record writes queue up here — two in flight would tear the file. */
  saving: Promise<void>;
}

// The registry hangs off globalThis: `bun --hot` swaps modules but keeps
// globalThis, so a reload during development does not orphan subprocesses.
const REGISTRY = Symbol.for("specdriven.agentChat.sessions");
function registry(): Map<string, ChatSession> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY]) g[REGISTRY] = new Map<string, ChatSession>();
  return g[REGISTRY] as Map<string, ChatSession>;
}

function live(): ChatSession[] {
  return [...registry().values()].filter((s) => !isFinalStatus(s.meta.status));
}

function get(id: string): ChatSession {
  const session = registry().get(id);
  if (!session) throw new ChatError(404, "coding agent session not found");
  return session;
}

function emit(session: ChatSession, body: ChatEventBody, now: Date = new Date()): ChatEvent {
  const event: ChatEvent = { ...body, seq: session.meta.lastSeq + 1, at: now.toISOString() };
  session.meta.lastSeq = event.seq;
  // Once the final message of a streamed reply is in, its deltas are dead
  // weight for replay — the message carries the whole text.
  if (body.kind === "assistant" && body.blocks.some((b) => b.type === "text")) {
    session.log = session.log.filter(
      (e) => !(e.kind === "text_delta" && e.messageId === body.messageId),
    );
  }
  session.log.push(event);
  for (const listener of session.listeners) {
    try {
      listener(event);
    } catch {
      // A dead stream must not take the session down.
    }
  }
  return event;
}

function setStatus(
  session: ChatSession,
  status: ChatStatus,
  extra: Omit<Extract<ChatEventBody, { kind: "status" }>, "kind" | "status"> = {},
): void {
  session.meta.status = status;
  if (isFinalStatus(status)) session.meta.endedAt = new Date().toISOString();
  emit(session, { kind: "status", status, ...extra });
}

/** The local, non-git record beside the settings file (src/server/agent.ts). */
function recordOf(session: ChatSession) {
  const m = session.meta;
  return {
    id: m.id,
    name: m.name,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    agent: m.agent,
    dataRepo: m.dataRepo,
    ...(m.codeRepo ? { codeRepo: m.codeRepo } : {}),
    cwd: m.cwd,
    ...(m.agentSessionId ? { agentSessionId: m.agentSessionId } : {}),
    ...(m.model ? { model: m.model } : {}),
    permissionMode: m.permissionMode,
    status: m.status,
    specs: [],
  };
}

function saveRecord(session: ChatSession): Promise<void> {
  session.saving = session.saving
    .then(() => writeTextFile(session.recordPath, JSON.stringify(recordOf(session), null, 2) + "\n"))
    .catch(() => {
      // A record that cannot be written must not stop the chat.
    });
  return session.saving;
}

/** The modes a provider offers, as a refusal lists them. */
function modeList(provider: AgentProvider): string {
  return provider.capabilities.permissionModes.join(", ");
}

// --- What a provider gets ------------------------------------------------------

/** The facts a ready/update carries into the meta and the status event. */
function applyInfo(session: ChatSession, info: Partial<AgentReadyInfo>): Omit<Extract<ChatEventBody, { kind: "status" }>, "kind" | "status"> {
  const m = session.meta;
  if (info.agentSessionId) m.agentSessionId = info.agentSessionId;
  if (info.model) m.model = info.model;
  if (info.account) m.account = info.account;
  if (info.permissionMode) m.permissionMode = info.permissionMode;
  if (info.commands) session.commands = info.commands;
  return {
    ...(info.agentSessionId ? { agentSessionId: info.agentSessionId } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.account ? { account: info.account } : {}),
    ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
    ...(info.tools ? { tools: info.tools } : {}),
    ...(info.commands ? { commands: info.commands } : {}),
  };
}

function hostFor(session: ChatSession): AgentHost {
  const final = () => isFinalStatus(session.meta.status);
  const announce = (info: Partial<AgentReadyInfo>, quiet = false) => {
    if (final()) return;
    const extra = applyInfo(session, info);
    if (info.agentSessionId || info.model || info.permissionMode) void saveRecord(session);
    if (session.meta.status === "starting") {
      // Ready: the status event says the session can be typed into, and
      // carries what it is made of.
      setStatus(session, session.busy ? "running" : "idle", {
        permissionMode: session.meta.permissionMode,
        commands: session.commands,
        ...extra,
      });
      return;
    }
    if (!quiet) emit(session, { kind: "status", status: session.meta.status, ...extra });
  };
  return {
    emit(body) {
      if (final()) return;
      emit(session, body);
    },
    note(level, code, text) {
      if (final()) return;
      emit(session, { kind: "note", level, code, text });
    },
    ready: (info) => announce(info),
    update: (info, opts) => announce(info, opts?.quiet),
    turnStarted() {
      if (final()) return;
      session.busy = true;
      if (session.meta.status === "idle") setStatus(session, "running");
    },
    turnEnded() {
      if (final()) return;
      // A card still open belongs to a turn that is over.
      denyAllPending(session, "interrupt", "The turn ended");
      session.busy = false;
      if (session.meta.status !== "starting") setStatus(session, "idle");
    },
    requestPermission: (req) => requestPermission(session, req),
    ended(text) {
      if (final()) return;
      void finish(session, "ended", text);
    },
    failed(text, code = "ended") {
      if (final()) return;
      void finish(session, "error", text, code);
    },
    status: () => session.meta.status,
    busy: () => session.busy,
    turn: () => session.turn,
    permissionMode: () => session.meta.permissionMode,
  };
}

/** The agent asks; the pane answers (specs: "permission card"). */
function requestPermission(session: ChatSession, req: PermissionRequest): Promise<PermissionOutcome> {
  if (isFinalStatus(session.meta.status)) {
    return Promise.resolve({ decision: { behavior: "deny", message: "The session has ended" }, via: "ended" });
  }
  const requestId = randomUUID();
  return new Promise<PermissionOutcome>((resolve) => {
    session.pending.set(requestId, { toolName: req.toolName, input: req.input, suggestions: req.suggestions, resolve });
    emit(session, {
      kind: "permission_request",
      requestId,
      toolName: req.toolName,
      input: req.input,
      suggestions: req.suggestions,
      ...(req.title ? { title: req.title } : {}),
    });
    setStatus(session, "awaiting_input");
    // The provider withdrew the question (an interrupt, a dying turn).
    req.signal?.addEventListener("abort", () => {
      if (!session.pending.has(requestId)) return;
      resolvePending(session, requestId, { behavior: "deny", message: "Cancelled" }, "interrupt");
    });
  });
}

function resolvePending(
  session: ChatSession,
  requestId: string,
  decision: PermissionDecision,
  via: PermissionOutcome["via"],
): void {
  const pending = session.pending.get(requestId);
  if (!pending) return;
  session.pending.delete(requestId);
  pending.resolve({ decision, via });
  emit(session, { kind: "permission_resolved", requestId, behavior: decision.behavior, via });
  if (session.pending.size === 0 && session.meta.status === "awaiting_input") {
    setStatus(session, "running");
  }
}

function denyAllPending(session: ChatSession, via: "interrupt" | "ended", message: string): void {
  for (const requestId of [...session.pending.keys()]) {
    resolvePending(session, requestId, { behavior: "deny", message }, via);
  }
}

function finish(
  session: ChatSession,
  status: "ended" | "error",
  text: string,
  code: "ended" | "spawn_failed" | "interrupted" = "ended",
): Promise<void> {
  denyAllPending(session, "ended", "The session has ended");
  session.busy = false;
  emit(session, { kind: "note", level: status === "error" ? "error" : "info", code, text });
  setStatus(session, status);
  try {
    session.session?.close();
  } catch {
    // A child that is already gone.
  }
  return saveRecord(session);
}

// --- Starting one -----------------------------------------------------------

export interface CreateChatOptions {
  place: SessionPlace;
  name: string;
  /** Which provider; absent is the lowest-ranked one whose CLI is there. */
  agent?: ChatAgent;
  /** Sent as the first user message, before the pane says anything. */
  prompt?: string;
  permissionMode?: PermissionMode;
  /** <settings dir>/sessions — see sessionsDirectory in agent.ts. */
  sessionsDir: string;
  id?: string;
  now?: Date;
}

/** The provider a request names, or the refusal: none installed, none by that id, its CLI missing. */
export function resolveProvider(agent?: ChatAgent): AgentProvider {
  const provider = agent === undefined ? agents.default() : agents.get(agent);
  if (!provider) {
    throw new ChatError(
      agent === undefined ? 502 : 404,
      agent === undefined
        ? "No coding agent is installed — install one from Settings → Plugins"
        : `No agent plugin provides "${agent}" — install it from Settings → Plugins`,
    );
  }
  if (!provider.available()) throw new ChatError(502, provider.missingMessage);
  return provider;
}

/**
 * Start one chat: spawn the agent on the work dir and begin pumping its
 * output into the event log. Resolves as soon as the subprocess is
 * requested; the ready status follows on the stream.
 */
export async function createChatSession(opts: CreateChatOptions): Promise<ChatSessionMeta> {
  if (live().length >= MAX_LIVE_SESSIONS) {
    throw new ChatError(409, `At most ${MAX_LIVE_SESSIONS} coding agent sessions can run at once — end one first`);
  }
  const provider = resolveProvider(opts.agent);
  const id = opts.id ?? randomUUID();
  const now = opts.now ?? new Date();
  const cwd = sessionWorkDir(opts.place);
  // A provider with no gate sits on its default; any other mode would
  // promise a prompt that never comes.
  const modes = provider.capabilities.permissionModes;
  const permissionMode =
    modes.length > 0 && opts.permissionMode && modes.includes(opts.permissionMode)
      ? opts.permissionMode
      : provider.defaultPermissionMode;
  const session: ChatSession = {
    meta: {
      id,
      name: opts.name,
      agent: provider.id,
      cwd,
      dataRepo: opts.place.dataRepo,
      ...(opts.place.codeRepo ? { codeRepo: opts.place.codeRepo } : {}),
      startedAt: now.toISOString(),
      status: "starting",
      permissionMode,
      lastSeq: 0,
    },
    log: [],
    listeners: new Set(),
    provider,
    session: null,
    abort: new AbortController(),
    pending: new Map(),
    busy: false,
    turn: 0,
    commands: [],
    recordPath: join(opts.sessionsDir, id, "session.json"),
    saving: Promise.resolve(),
  };
  registry().set(id, session);
  installShutdownHook();
  emit(session, { kind: "status", status: "starting", permissionMode }, now);
  if (opts.prompt) {
    session.turn = 1;
    session.busy = true;
    emit(session, { kind: "user", id: randomUUID(), text: opts.prompt }, now);
  }
  try {
    session.session = await provider.start({
      sessionId: id,
      name: opts.name,
      cwd,
      dataRepo: opts.place.dataRepo,
      ...(opts.place.codeRepo ? { codeRepo: opts.place.codeRepo } : {}),
      permissionMode,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      signal: session.abort.signal,
      host: hostFor(session),
    });
  } catch (e) {
    registry().delete(id);
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw new ChatError(502, `Could not start ${provider.label}: ${(e as Error).message}`);
  }
  // A provider that failed before start() resolved has already finished
  // the session; the record then says so.
  await saveRecord(session);
  return { ...session.meta };
}

// --- The API the routes call -------------------------------------------------

export function listChatSessions(): ChatSessionMeta[] {
  return [...registry().values()]
    .map((s) => ({ ...s.meta }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getChatSession(id: string): ChatSessionMeta | null {
  const session = registry().get(id);
  return session ? { ...session.meta } : null;
}

export function getChatCommands(id: string): SlashCommandInfo[] {
  return [...get(id).commands];
}

/** Events after `after` (a sequence number), oldest first. */
export function getChatEvents(id: string, after = 0): ChatEvent[] {
  return get(id).log.filter((e) => e.seq > after);
}

export function subscribeChat(id: string, fn: (event: ChatEvent) => void): () => void {
  const session = get(id);
  session.listeners.add(fn);
  return () => {
    session.listeners.delete(fn);
  };
}

/** One user turn: text (a plain message or a `/command`) to the agent. */
export function sendChatMessage(id: string, text: string): ChatEvent {
  const session = get(id);
  const trimmed = text.trim();
  if (!trimmed) throw new ChatError(400, "text is required");
  if (isFinalStatus(session.meta.status)) throw new ChatError(409, "The session has ended");
  if (session.busy) throw new ChatError(409, "A turn is in progress — Stop it first");
  if (!session.session) throw new ChatError(409, `${session.provider.label} is still starting`);
  session.turn += 1;
  session.busy = true;
  const event = emit(session, { kind: "user", id: randomUUID(), text: trimmed });
  if (session.meta.status === "idle") setStatus(session, "running");
  session.session.send(trimmed).catch((e: Error) => {
    // The turn never started: say so, and give the composer back.
    if (isFinalStatus(session.meta.status)) return;
    session.busy = false;
    emit(session, { kind: "note", level: "error", code: "api", text: e.message });
    if (session.meta.status === "running") setStatus(session, "idle");
  });
  return event;
}

export function answerPermission(id: string, answer: PermissionAnswer): void {
  const session = get(id);
  const pending = session.pending.get(answer.requestId);
  if (!pending) throw new ChatError(404, "no such permission request — it may have been answered");
  const decision: PermissionDecision =
    answer.behavior === "allow"
      ? {
          behavior: "allow",
          updatedInput: answer.updatedInput ?? pending.input,
          remember: answer.remember === true && pending.suggestions.length > 0,
        }
      : { behavior: "deny", message: answer.message?.trim() || "Denied in SpecDriven" };
  resolvePending(session, answer.requestId, decision, "user");
}

/** Stop the current turn; the agent stays up for the next message. */
export async function interruptChat(id: string): Promise<void> {
  const session = get(id);
  if (session.meta.status !== "running" && session.meta.status !== "awaiting_input") {
    throw new ChatError(409, "Nothing is running");
  }
  if (!session.provider.capabilities.canInterrupt) {
    throw new ChatError(409, `${session.provider.label} cannot be interrupted`);
  }
  denyAllPending(session, "interrupt", "Interrupted by the user");
  emit(session, { kind: "note", level: "info", code: "interrupted", text: "Stopped." });
  await session.session?.interrupt();
}

export async function setChatPermissionMode(id: string, mode: PermissionMode): Promise<void> {
  const session = get(id);
  if (isFinalStatus(session.meta.status)) throw new ChatError(409, "The session has ended");
  const { provider } = session;
  const modes = provider.capabilities.permissionModes;
  if (modes.length === 0) throw new ChatError(409, `${provider.label} has no permission modes`);
  if (!modes.includes(mode)) {
    throw new ChatError(400, `${provider.label} offers only ${modeList(provider)}`);
  }
  if (session.meta.status === "starting" || !session.session) {
    throw new ChatError(409, `${provider.label} is still starting`);
  }
  try {
    await session.session.setPermissionMode(mode);
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw e;
  }
  session.meta.permissionMode = mode;
  emit(session, { kind: "mode", permissionMode: mode });
  void saveRecord(session);
}

/** End the chat and forget it: the subprocess is aborted, the record kept. */
export async function endChatSession(id: string): Promise<void> {
  const session = get(id);
  if (!isFinalStatus(session.meta.status)) {
    const saved = finish(session, "ended", "Session ended.");
    session.abort.abort();
    await saved;
  }
  registry().delete(id);
}

/** Server shutdown: every live subprocess goes. */
export async function endAllChatSessions(): Promise<void> {
  const saves: Promise<void>[] = [];
  for (const session of registry().values()) {
    if (!isFinalStatus(session.meta.status)) {
      saves.push(finish(session, "ended", "SpecDriven is shutting down."));
      session.abort.abort();
    }
  }
  registry().clear();
  await Promise.all(saves);
}

// A provider that goes (its plugin switched off) takes its live sessions
// with it: nothing could answer them. Subscribed once; the registry is on
// globalThis, so a `bun --hot` reload must not add a second listener.
const WATCH = Symbol.for("specdriven.agentChat.providerWatch");
{
  const flags = globalThis as Record<symbol, unknown>;
  if (!flags[WATCH]) {
    flags[WATCH] = true;
    agents.subscribe((change) => {
      if (change.type !== "removed") return;
      for (const session of registry().values()) {
        if (session.meta.agent !== change.id || isFinalStatus(session.meta.status)) continue;
        void finish(session, "ended", `The ${session.provider.label} plugin was switched off.`);
        session.abort.abort();
      }
    });
  }
}

// `exit` handlers cannot await; aborting is synchronous and each provider
// kills its child on it. Installed once, the first time a session starts,
// so a server that never opens the pane is untouched.
const HOOK = Symbol.for("specdriven.agentChat.exitHook");
function installShutdownHook(): void {
  const flags = globalThis as Record<symbol, unknown>;
  if (flags[HOOK]) return;
  flags[HOOK] = true;
  process.on("exit", () => {
    for (const session of registry().values()) {
      if (isFinalStatus(session.meta.status)) continue;
      session.abort.abort();
      try {
        session.session?.close();
      } catch {
        // Already gone.
      }
    }
  });
}
