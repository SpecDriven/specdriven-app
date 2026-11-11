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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveRefs, sessionWorkDir, withRefs } from "./agent";
import { agentMcpServers } from "./agentMcp";
import { cleanUpWorktree, createWorktree, discardWorktree, WorktreeError } from "./agentWorktree";
import type { WorktreeCleanup } from "./agentWorktree";
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
  AgentChoices,
  AgentConnection,
  AgentImage,
  ChatImage,
  ImageMediaType,
  ImageUpload,
  AgentDefaultsPatch,
  ChatAgent,
  ChatContextUsage,
  ChatEvent,
  ChatEventBody,
  ChatSessionMeta,
  ChatStatus,
  ChatWorktree,
  ContextDetail,
  PermissionAnswer,
  PermissionMode,
  EffortLevel,
  PermissionSuggestion,
  SlashCommandInfo,
} from "./agentTypes";
import {
  isFinalStatus,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_OPEN_SESSIONS,
  normalizeImageMediaType,
  normalizePermissionMode,
  PERMISSION_MODES,
} from "./agentTypes";
import { writeTextFile } from "./fsx";

/** An HTTP-shaped failure: the route turns `status` into the response code. */
export class ChatError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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
  /** Images pasted into the session, by id: where the bytes are kept. */
  images: Map<string, { path: string; mediaType: ImageMediaType }>;
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
  // A context count stands for the window now: the one before is history no
  // replay needs, and with every MCP tool listed it is not small.
  if (body.kind === "context") session.log = session.log.filter((e) => e.kind !== "context");
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
    ...(m.worktree ? { worktree: m.worktree } : {}),
    ...(m.agentSessionId ? { agentSessionId: m.agentSessionId } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.effort ? { effort: m.effort } : {}),
    permissionMode: m.permissionMode,
    // The totals only: nobody reads the breakdown back from the record.
    ...(m.context
      ? {
          context: {
            at: m.context.at,
            ...(m.context.model ? { model: m.context.model } : {}),
            totalTokens: m.context.totalTokens,
            maxTokens: m.context.maxTokens,
            detail: m.context.detail,
          },
        }
      : {}),
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
  if (info.effort) m.effort = info.effort;
  if (info.account) m.account = info.account;
  if (info.permissionMode) m.permissionMode = info.permissionMode;
  if (info.commands) session.commands = info.commands;
  return {
    ...(info.agentSessionId ? { agentSessionId: info.agentSessionId } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.effort ? { effort: info.effort } : {}),
    ...(info.account ? { account: info.account } : {}),
    ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
    ...(info.tools ? { tools: info.tools } : {}),
    ...(info.commands ? { commands: info.commands } : {}),
  };
}

/** Show a context count: the meta holds it, the stream carries it, the
    record keeps its totals. Never a status change — a count may come while
    the session is still starting. */
function showContext(session: ChatSession, usage: Omit<ChatContextUsage, "at"> & { at?: string }): ChatContextUsage {
  const context: ChatContextUsage = { ...usage, at: usage.at ?? new Date().toISOString() };
  session.meta.context = context;
  emit(session, { kind: "context", context });
  void saveRecord(session);
  return context;
}

function hostFor(session: ChatSession): AgentHost {
  const final = () => isFinalStatus(session.meta.status);
  const announce = (info: Partial<AgentReadyInfo>, quiet = false) => {
    if (final()) return;
    const extra = applyInfo(session, info);
    if (info.agentSessionId || info.model || info.effort || info.permissionMode) void saveRecord(session);
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
    context(usage) {
      if (final()) return;
      showContext(session, usage);
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

// --- Pasted images ------------------------------------------------------------

const IMAGE_EXT: Record<ImageMediaType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The images a request carries, checked; the refusal is a 400 (413 for
    one too big). Nothing is written yet. */
export function checkImages(value: unknown): { mediaType: ImageMediaType; data: string; bytes: Buffer; name?: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ChatError(400, "images must be a list");
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ChatError(400, `At most ${MAX_IMAGES_PER_MESSAGE} images go with one message`);
  }
  return value.map((raw: unknown, i) => {
    const upload = (raw ?? {}) as Partial<ImageUpload>;
    const mediaType = normalizeImageMediaType(upload.mediaType);
    if (!mediaType) throw new ChatError(400, `Image ${i + 1} must be a PNG, JPEG, GIF or WebP image`);
    const data = typeof upload.data === "string" ? upload.data.replace(/\s+/g, "") : "";
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) {
      throw new ChatError(400, `Image ${i + 1} must be base64 data`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ChatError(
        413,
        `Image ${i + 1} is ${(bytes.length / 1e6).toFixed(1)} MB; one image may be at most ${(MAX_IMAGE_BYTES / 1e6).toFixed(2)} MB`,
      );
    }
    const name = typeof upload.name === "string" && upload.name.trim() ? upload.name.trim().slice(0, 200) : undefined;
    return { mediaType, data, bytes, ...(name ? { name } : {}) };
  });
}

/** Keep the images in the session's folder (<sessions>/<id>/images): the
    pane fetches them back from there, and an agent that reads images from
    disk gets the path. */
async function saveImages(
  sessionId: string,
  sessionDir: string,
  images: ReturnType<typeof checkImages>,
): Promise<{ shown: ChatImage[]; given: AgentImage[]; kept: [string, { path: string; mediaType: ImageMediaType }][] }> {
  const shown: ChatImage[] = [];
  const given: AgentImage[] = [];
  const kept: [string, { path: string; mediaType: ImageMediaType }][] = [];
  if (images.length === 0) return { shown, given, kept };
  const dir = join(sessionDir, "images");
  await mkdir(dir, { recursive: true });
  for (const image of images) {
    const id = randomUUID();
    const path = join(dir, id + IMAGE_EXT[image.mediaType]);
    await writeFile(path, image.bytes);
    shown.push({
      id,
      mediaType: image.mediaType,
      url: `/api/agent/chat/${encodeURIComponent(sessionId)}/images/${id}`,
      ...(image.name ? { name: image.name } : {}),
    });
    given.push({ mediaType: image.mediaType, data: image.data, path });
    kept.push([id, { path, mediaType: image.mediaType }]);
  }
  return { shown, given, kept };
}

/** Refuse images an agent cannot read. */
function refuseImages(provider: AgentProvider, count: number): void {
  if (count > 0 && !provider.capabilities.images) {
    throw new ChatError(409, `${provider.label} cannot read images — send text only`);
  }
}

/** A pasted image's file and type, for the route that serves it. */
export function getChatImage(id: string, imageId: string): { path: string; mediaType: ImageMediaType } | null {
  return get(id).images.get(imageId) ?? null;
}

// --- Starting one -----------------------------------------------------------

/** The files that go with a message: paths relative to `root`, the folder
    open in the app (src/server/agent.ts checkRefs, resolveRefs). */
export interface MessageRefs {
  root: string;
  paths: string[];
}

/** Those files as this session's agent is told them; none for a `/command`. */
function refsFor(meta: Pick<ChatSessionMeta, "cwd" | "worktree">, text: string, refs?: MessageRefs): string[] {
  if (!refs || refs.paths.length === 0 || text.trimStart().startsWith("/")) return [];
  return resolveRefs(refs.paths, refs.root, meta);
}

export interface CreateChatOptions {
  place: SessionPlace;
  /** The folder open in the app (ChatSessionMeta.project); absent is the
      place's data repo, which is that folder whenever specs are open. */
  project?: string;
  name: string;
  /** Which provider; absent is the lowest-ranked one whose CLI is there. */
  agent?: ChatAgent;
  /** Sent as the first user message, before the pane says anything. */
  prompt?: string;
  /** Pasted with the first message (checkImages has looked at them). */
  images?: ImageUpload[];
  /** The files that go with the first message (checkRefs has looked at them). */
  refs?: MessageRefs;
  permissionMode?: PermissionMode;
  /** The model to start on; absent, the agent's default. */
  model?: string;
  /** The effort to start at, for an agent that takes one; absent, its default. */
  effort?: EffortLevel;
  /** <settings dir>/sessions — see sessionsDirectory in agent.ts. */
  sessionsDir: string;
  /** Present: the session gets its own git worktree of the place's folder,
      made under this folder (<settings dir>/worktrees, agentWorktree.ts). */
  worktreesDir?: string;
  /** The open specifications folder: the app keeps it level with its remote
      itself, so a worktree of it is made as it stands (agentWorktree.ts). */
  syncedRepo?: string;
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
  // Every open session counts, ended ones too: each is a tab in the pane
  // until it is closed (DELETE), and the pane shows at most this many.
  if (registry().size >= MAX_OPEN_SESSIONS) {
    throw new ChatError(409, `At most ${MAX_OPEN_SESSIONS} coding agent sessions can be open at once — close one first`);
  }
  const provider = resolveProvider(opts.agent);
  const uploads = checkImages(opts.images);
  refuseImages(provider, uploads.length);
  const id = opts.id ?? randomUUID();
  const now = opts.now ?? new Date();
  // A worktree of its own, when asked: made before anything else is kept,
  // so a folder that is no repo is refused with nothing to undo.
  let worktree: ChatWorktree | undefined;
  if (opts.worktreesDir) {
    try {
      worktree = await createWorktree({
        folder: sessionWorkDir(opts.place),
        name: opts.name,
        worktreesDir: opts.worktreesDir,
        ...(opts.syncedRepo ? { synced: opts.syncedRepo } : {}),
      });
    } catch (e) {
      if (e instanceof WorktreeError) throw new ChatError(e.status, e.message);
      throw new ChatError(500, `Could not make a worktree: ${(e as Error).message}`);
    }
  }
  const cwd = worktree?.cwd ?? sessionWorkDir(opts.place);
  // The worktree stands where the code repo stood; a worktree of the data
  // repo is the session's data repo copy, with no second folder beside it.
  const codeRepo = opts.place.codeRepo ? cwd : undefined;
  // A provider with no gate sits on its default; any other mode would
  // promise a prompt that never comes.
  const modes = provider.capabilities.permissionModes;
  const permissionMode =
    modes.length > 0 && opts.permissionMode && modes.includes(opts.permissionMode)
      ? opts.permissionMode
      : provider.defaultPermissionMode;
  // Effort only where the agent takes one; a model any agent may be handed.
  const effort = provider.capabilities.effort ? opts.effort : undefined;
  const sessionDir = join(opts.sessionsDir, id);
  let pasted: Awaited<ReturnType<typeof saveImages>>;
  try {
    pasted = await saveImages(id, sessionDir, uploads);
  } catch (e) {
    if (worktree) await discardWorktree(worktree);
    throw new ChatError(500, `Could not keep the pasted images: ${(e as Error).message}`);
  }
  const firstTurn = Boolean(opts.prompt) || pasted.given.length > 0;
  const firstRefs = firstTurn ? refsFor({ cwd, ...(worktree ? { worktree } : {}) }, opts.prompt ?? "", opts.refs) : [];
  const session: ChatSession = {
    meta: {
      id,
      name: opts.name,
      agent: provider.id,
      cwd,
      ...(worktree ? { worktree } : {}),
      dataRepo: opts.place.dataRepo,
      ...(codeRepo ? { codeRepo } : {}),
      project: resolve(opts.project ?? opts.place.dataRepo),
      startedAt: now.toISOString(),
      status: "starting",
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { effort } : {}),
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
    recordPath: join(sessionDir, "session.json"),
    images: new Map(pasted.kept),
    saving: Promise.resolve(),
  };
  registry().set(id, session);
  installShutdownHook();
  emit(session, { kind: "status", status: "starting", permissionMode }, now);
  if (firstTurn) {
    session.turn = 1;
    session.busy = true;
    emit(
      session,
      {
        kind: "user",
        id: randomUUID(),
        text: opts.prompt ?? "",
        ...(pasted.shown.length ? { images: pasted.shown } : {}),
        ...(firstRefs.length ? { refs: firstRefs } : {}),
      },
      now,
    );
  }
  // The MCP servers the session should have (src/server/agentMcp.ts).
  const mcpServers = await agentMcpServers();
  try {
    session.session = await provider.start({
      sessionId: id,
      name: opts.name,
      cwd,
      dataRepo: opts.place.dataRepo,
      ...(codeRepo ? { codeRepo } : {}),
      permissionMode,
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { effort } : {}),
      ...(firstTurn ? { prompt: withRefs(opts.prompt ?? "", firstRefs) } : {}),
      ...(pasted.given.length ? { images: pasted.given } : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
      signal: session.abort.signal,
      host: hostFor(session),
    });
  } catch (e) {
    registry().delete(id);
    if (worktree) await discardWorktree(worktree);
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw new ChatError(502, `Could not start ${provider.label}: ${(e as Error).message}`);
  }
  // A provider that failed before start() resolved has already finished
  // the session; the record then says so.
  await saveRecord(session);
  return { ...session.meta };
}

// --- The API the routes call -------------------------------------------------

/** Every session, newest first — without its context count, which only
    the open session's popover shows (getChatSession has it). */
export function listChatSessions(): ChatSessionMeta[] {
  return [...registry().values()]
    .map((s) => {
      const { context: _context, ...meta } = s.meta;
      return meta;
    })
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

/** Whether a session would take a message now; the refusal otherwise. */
function checkSendable(session: ChatSession): asserts session is ChatSession & { session: AgentSession } {
  if (isFinalStatus(session.meta.status)) throw new ChatError(409, "The session has ended");
  if (session.busy) throw new ChatError(409, "A turn is in progress — Stop it first");
  if (!session.session) throw new ChatError(409, `${session.provider.label} is still starting`);
}

/**
 * One user turn: text (a plain message or a `/command`) to the agent, with
 * the images pasted into it (specs/agents/agent-pane.feature.md "Paste an
 * image into the message"). Text may be empty when images came.
 */
export async function sendChatMessage(id: string, text: string, images?: unknown, refs?: MessageRefs): Promise<ChatEvent> {
  const session = get(id);
  const trimmed = text.trim();
  const uploads = checkImages(images);
  if (!trimmed && uploads.length === 0) throw new ChatError(400, "text is required");
  checkSendable(session);
  refuseImages(session.provider, uploads.length);
  let pasted: Awaited<ReturnType<typeof saveImages>>;
  try {
    pasted = await saveImages(id, dirname(session.recordPath), uploads);
  } catch (e) {
    throw new ChatError(500, `Could not keep the pasted images: ${(e as Error).message}`);
  }
  // The files took a moment: the session may have moved on meanwhile.
  checkSendable(session);
  for (const [imageId, kept] of pasted.kept) session.images.set(imageId, kept);
  session.turn += 1;
  session.busy = true;
  // The files that go with it: shown under the message, and told to the
  // agent in a line after the user's words.
  const paths = refsFor(session.meta, trimmed, refs);
  const event = emit(session, {
    kind: "user",
    id: randomUUID(),
    text: trimmed,
    ...(pasted.shown.length ? { images: pasted.shown } : {}),
    ...(paths.length ? { refs: paths } : {}),
  });
  if (session.meta.status === "idle") setStatus(session, "running");
  const told = withRefs(trimmed, paths);
  const sent = pasted.given.length ? session.session.send(told, pasted.given) : session.session.send(told);
  sent.catch((e: Error) => {
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

/** A session that can take a switch now: not ended, started. */
function switchable(id: string): ChatSession & { session: AgentSession } {
  const session = get(id);
  if (isFinalStatus(session.meta.status)) throw new ChatError(409, "The session has ended");
  if (session.meta.status === "starting" || !session.session) {
    throw new ChatError(409, `${session.provider.label} is still starting`);
  }
  return session as ChatSession & { session: AgentSession };
}

/** What the pane picked becomes what new sessions start on; a provider
    that cannot keep it leaves the default as it was. */
async function keepAsDefault(provider: AgentProvider, patch: AgentDefaultsPatch): Promise<void> {
  try {
    await provider.setDefaults?.(patch);
  } catch (e) {
    console.error(`[agents] ${provider.id}: saving the default ${Object.keys(patch).join(", ")}: ${(e as Error).message}`);
  }
}

/**
 * Switch a running session's model (null: the agent's own default) from its
 * next request on, and make it the agent's default for new sessions.
 */
export async function setChatModel(id: string, model: string | null): Promise<void> {
  const session = switchable(id);
  const { provider } = session;
  if (!provider.capabilities.canChangeModelMidSession || !session.session.setModel) {
    throw new ChatError(409, `${provider.label} cannot switch models in a running session — start a new one`);
  }
  try {
    await session.session.setModel(model);
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw e;
  }
  if (model) session.meta.model = model;
  else delete session.meta.model;
  emit(session, { kind: "model", model });
  void saveRecord(session);
  await keepAsDefault(provider, { model });
}

/** Switch a running session's effort (null: the agent's own default), and
    make it the agent's default for new sessions. */
export async function setChatEffort(id: string, effort: EffortLevel | null): Promise<void> {
  const session = switchable(id);
  const { provider } = session;
  if (!provider.capabilities.effort || !session.session.setEffort) {
    throw new ChatError(409, `${provider.label} has no effort setting`);
  }
  try {
    await session.session.setEffort(effort);
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw e;
  }
  if (effort) session.meta.effort = effort;
  else delete session.meta.effort;
  emit(session, { kind: "effort", effort });
  void saveRecord(session);
  await keepAsDefault(provider, { effort });
}

/**
 * Count a session's context window now (the popover's Refresh): the agent
 * answers, and the answer is shown as its own count would be. Null when the
 * agent could not say; the last count then stands.
 */
export async function refreshChatContext(id: string, detail: ContextDetail): Promise<ChatContextUsage | null> {
  const session = switchable(id);
  const { provider } = session;
  if (provider.capabilities.contextUsage !== "breakdown" || !session.session.contextUsage) {
    throw new ChatError(409, `${provider.label} does not count its context on request`);
  }
  let usage: ChatContextUsage | null;
  try {
    usage = await session.session.contextUsage(detail);
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw new ChatError(502, `${provider.label} could not count its context: ${(e as Error).message}`);
  }
  if (!usage || isFinalStatus(session.meta.status)) return usage ?? null;
  return showContext(session, usage);
}

/** The models an agent offers and what a new session starts on; null for
    an agent with no choices to make. */
export async function agentChoices(agent: ChatAgent, dataRepo: string | null): Promise<AgentChoices | null> {
  const provider = agents.get(agent);
  if (!provider) throw new ChatError(404, `No agent plugin provides "${agent}"`);
  if (!provider.choices) return null;
  let choices: AgentChoices;
  try {
    choices = await provider.choices({ dataRepo });
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw new ChatError(502, `${provider.label} could not list its models: ${(e as Error).message}`);
  }
  const connection = connections().get(agent);
  return connection ? { ...choices, connection } : choices;
}

// --- Reconnecting the agents' APIs ---------------------------------------
//
// specs/agents/agent-pane.feature.md S14: an agent whose API goes through
// a proxy is tried again when the user switches folders — a proxy that
// dropped while the user was elsewhere is woken, or the pane says it does
// not answer before a turn waits on it. The last answer per agent rides on
// its choices (AgentChoices.connection); kept on globalThis so a `bun --hot`
// reload does not forget it.

const CONNECTIONS = Symbol.for("specdriven.agentChat.connections");
function connections(): Map<ChatAgent, AgentConnection> {
  const g = globalThis as Record<symbol, unknown>;
  return (g[CONNECTIONS] ??= new Map<ChatAgent, AgentConnection>()) as Map<ChatAgent, AgentConnection>;
}

/** The tries under way, so a Retry pressed during a switch's try shares it. */
const reconnecting = new Map<ChatAgent, Promise<AgentConnection | null>>();

/**
 * Try one agent's API again from `cwd`. Null when the agent has nothing to
 * try — no hook, not set up, or a sign-in with no endpoint of its own —
 * and then any earlier answer is dropped, so the pane stops warning.
 */
export async function reconnectAgent(agent: ChatAgent, cwd: string): Promise<AgentConnection | null> {
  const provider = agents.get(agent);
  if (!provider) throw new ChatError(404, `No agent plugin provides "${agent}"`);
  const under = reconnecting.get(agent);
  if (under) return under;
  const attempt = (async (): Promise<AgentConnection | null> => {
    if (!provider.reconnect || !provider.available()) {
      connections().delete(agent);
      return null;
    }
    let found: Awaited<ReturnType<NonNullable<AgentProvider["reconnect"]>>>;
    try {
      found = await provider.reconnect({ cwd });
    } catch (e) {
      found = { ok: false, detail: (e as Error).message };
    }
    if (!found) {
      connections().delete(agent);
      return null;
    }
    const connection: AgentConnection = {
      ok: found.ok === true,
      detail: typeof found.detail === "string" ? found.detail : "",
      ...(typeof found.url === "string" && found.url ? { url: found.url } : {}),
      at: new Date().toISOString(),
    };
    connections().set(agent, connection);
    return connection;
  })().finally(() => reconnecting.delete(agent));
  reconnecting.set(agent, attempt);
  return attempt;
}

/**
 * Every agent tries its API again — the user switched folders. Not awaited
 * by the switch; `onDone` hears once all are back (the pages are told to
 * read the choices again), and a try that throws is that agent's answer.
 */
export function reconnectAgents(cwd: string, onDone?: () => void): Promise<void> {
  const tries = agents
    .list()
    .filter((p) => p.reconnect)
    .map((p) => reconnectAgent(p.id, cwd).catch(() => null));
  return Promise.all(tries).then(() => onDone?.());
}

/** For the tests: forget every answer. */
export function forgetConnections(): void {
  connections().clear();
}

/** The models an agent's API reports; null for no such agent, no hook, or no answer. */
export async function agentReportedModels(agent: ChatAgent): Promise<string[] | null> {
  const provider = agents.get(agent);
  if (!provider?.reportedModels) return null;
  const models = await provider.reportedModels();
  return Array.isArray(models) ? models.filter((m) => typeof m === "string") : null;
}

/** Make a model or effort what an agent's new sessions start on. */
export async function setAgentDefaults(agent: ChatAgent, patch: AgentDefaultsPatch): Promise<void> {
  const provider = agents.get(agent);
  if (!provider) throw new ChatError(404, `No agent plugin provides "${agent}"`);
  if (!provider.setDefaults) throw new ChatError(409, `${provider.label} keeps no default model or effort`);
  if (patch.effort !== undefined && !provider.capabilities.effort) {
    throw new ChatError(409, `${provider.label} has no effort setting`);
  }
  try {
    await provider.setDefaults(patch);
  } catch (e) {
    if (e instanceof AgentError) throw new ChatError(e.status, e.message);
    throw e;
  }
}

/**
 * End the chat and forget it: the subprocess is aborted, the record kept.
 * A worktree of its own is removed when nothing in it is uncommitted (its
 * branch stays), else kept; the answer says which.
 */
export async function endChatSession(id: string, why = "Session ended."): Promise<{ worktree?: WorktreeCleanup }> {
  const session = get(id);
  if (!isFinalStatus(session.meta.status)) {
    const saved = finish(session, "ended", why);
    session.abort.abort();
    await saved;
  }
  registry().delete(id);
  const wt = session.meta.worktree;
  if (!wt) return {};
  return { worktree: await cleanUpWorktree(wt).catch((): WorktreeCleanup => "kept") };
}

/**
 * The user switched folders (specs/agents/agent-pane.feature.md "Switching
 * folders closes the other folder's sessions"): every session started in
 * another folder ends and is forgotten, as its tab's × would — a worktree
 * with changes in it is kept. Answers how many went.
 */
export async function closeOtherProjects(project: string): Promise<number> {
  const open = resolve(project);
  const others = [...registry().values()].filter((s) => s.meta.project !== open).map((s) => s.meta.id);
  await Promise.all(others.map((id) => endChatSession(id, "The folder was switched; this session belonged to another folder.").catch(() => undefined)));
  return others.length;
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
// with it: nothing could answer them. One whose sign-in changed has its live
// sessions drop the old one (AgentSession.refresh) — without that, a session
// kept the account it started with until the app was restarted. Subscribed
// once; the registry is on globalThis, so a `bun --hot` reload must not add
// a second listener.
const WATCH = Symbol.for("specdriven.agentChat.providerWatch");
{
  const flags = globalThis as Record<symbol, unknown>;
  if (!flags[WATCH]) {
    flags[WATCH] = true;
    agents.subscribe((change) => {
      if (change.type === "added") return;
      for (const session of registry().values()) {
        if (session.meta.agent !== change.id || isFinalStatus(session.meta.status)) continue;
        if (change.type === "changed") {
          refreshSession(session);
          continue;
        }
        void finish(session, "ended", `The ${session.provider.label} plugin was switched off.`);
        session.abort.abort();
      }
    });
  }
}

/** Hand a live session the provider's new sign-in; a failure is a note, not the end. */
function refreshSession(session: ChatSession): void {
  const provider = session.session;
  if (!provider?.refresh) return;
  let pending: void | Promise<void>;
  try {
    pending = provider.refresh();
  } catch (e) {
    pending = Promise.reject(e);
  }
  void Promise.resolve(pending).catch((e: Error) => {
    if (isFinalStatus(session.meta.status)) return;
    emit(session, {
      kind: "note",
      level: "error",
      code: "api",
      text: `Could not pick up the new ${session.provider.label} sign-in: ${e.message} — start a new session.`,
    });
  });
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
