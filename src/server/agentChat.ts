// Coding agent pane (specs/agents/coding-agent-ui.feature.md): the app drives
// a live coding agent session itself, for developers who have a CLI but not
// Claude Code Desktop. Two agents share this machinery:
//
//   Claude — one long-lived `query()` from the Claude Agent SDK per chat, in
//   streaming-input mode, the only mode in which permission requests,
//   interrupts and mode changes reach us, spawning the developer's own
//   `claude` binary with the code repo as its working directory.
//
//   Pi — `pi --mode rpc` over JSON lines (src/server/piChat.ts,
//   specs/agents/integration-with-pi-dev-agent.feature.md). Pi runs its own
//   tools and has no permission protocol, so those sessions offer no
//   permission mode and never raise a permission card.
//
// Either way every message the agent produces becomes an event in an
// in-memory log with a sequence number; the browser reads the log over a
// one-way stream and, on reconnect, asks for everything after the last
// sequence it saw.
//
// Node APIs only (src/server/run.ts): this module also runs inside Electron.
// The Claude SDK itself is imported lazily, on the first session, so booting
// the server, `bun test` and the desktop shell never pay for it.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_BIN, PANE_AGENT, PI_PANE_AGENT, sessionWorkDir } from "./agent";
import type { SessionPlace } from "./agent";
import { writeTextFile } from "./fsx";
import { PiClient, mapPiEvent, newPiStream, piCommands, piState } from "./piChat";
import type { PiEvent, PiStreamContext } from "./piChat";
import { which } from "./run";

/** Which agent a pane session runs (specs/agents/claude.feature.md,
    specs/agents/integration-with-pi-dev-agent.feature.md). */
export type ChatAgent = "claude" | "pi";
export const CHAT_AGENTS: readonly ChatAgent[] = ["claude", "pi"];

export function normalizeChatAgent(value: unknown): ChatAgent | null {
  return (CHAT_AGENTS as readonly unknown[]).includes(value) ? (value as ChatAgent) : null;
}

/** The permission modes the pane offers; the SDK knows more (dontAsk, auto). */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export function normalizePermissionMode(value: unknown): PermissionMode | null {
  return (PERMISSION_MODES as readonly unknown[]).includes(value) ? (value as PermissionMode) : null;
}

/**
 * Where a session is in its life:
 *   starting → (init) → idle ⇄ running ⇄ awaiting_input, and finally ended
 *   or error. `awaiting_input` means Claude asked for a permission (or a
 *   clarifying question) and waits for the pane's answer.
 */
export type ChatStatus = "starting" | "idle" | "running" | "awaiting_input" | "ended" | "error";

const FINAL: ReadonlySet<ChatStatus> = new Set(["ended", "error"]);

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

export interface ChatSessionMeta {
  id: string;
  name: string;
  /** Which agent drives the chat. */
  agent: ChatAgent;
  /** The folder the agent works in: the code repo, else the data repo. */
  cwd: string;
  dataRepo: string;
  codeRepo?: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt?: string;
  status: ChatStatus;
  /** The agent's own session id — Claude Code's, or pi's — once it says it. */
  agentSessionId?: string;
  model?: string;
  /** Pi has none of these: its sessions sit on "bypassPermissions" and
      refuse a change (see setChatPermissionMode). */
  permissionMode: PermissionMode;
  /** Sequence number of the last event in the log. */
  lastSeq: number;
}

/** One block of an assistant turn the pane renders. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type ChatEventBody =
  | {
      kind: "status";
      status: ChatStatus;
      agentSessionId?: string;
      model?: string;
      permissionMode?: PermissionMode;
      tools?: string[];
      commands?: SlashCommandInfo[];
    }
  /** What the pane sent — echoed from the request, never from the SDK's replays. */
  | { kind: "user"; id: string; text: string }
  | { kind: "text_delta"; messageId: string; index: number; text: string }
  | {
      kind: "assistant";
      messageId: string;
      turn: number;
      blocks: AssistantBlock[];
      parentToolUseId: string | null;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      parentToolUseId: string | null;
    }
  | {
      kind: "permission_request";
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions: PermissionUpdate[];
      title?: string;
    }
  | {
      kind: "permission_resolved";
      requestId: string;
      behavior: "allow" | "deny";
      via: "user" | "interrupt" | "ended";
    }
  | {
      kind: "result";
      turn: number;
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      durationMs: number;
      numTurns: number;
      text?: string;
      denials: number;
    }
  | { kind: "mode"; permissionMode: PermissionMode }
  | {
      kind: "note";
      level: "info" | "error";
      code: "init" | "compact" | "stderr" | "ended" | "spawn_failed" | "interrupted" | "api";
      text: string;
    };

export type ChatEvent = ChatEventBody & { seq: number; at: string };

/** An HTTP-shaped failure: the route turns `status` into the response code. */
export class ChatError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The prompt side of a streaming query: an async iterable the SDK pulls
 * from, that we push into as the user types. Closing it ends Claude's input.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) throw new Error("input closed");
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.done = true;
    this.wake();
  }

  get closed(): boolean {
    return this.done;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/** What we need of the SDK's Query — narrow, so a test can hand in a fake. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
}

export type QueryFactory = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryLike | Promise<QueryLike>;

// Injection seam (src/server/agent.ts setDesktopRunner): tests never spawn
// Claude; null restores the SDK.
let queryFactory: QueryFactory | null = null;

export function setQueryFactory(factory: QueryFactory | null): QueryFactory | null {
  const previous = queryFactory;
  queryFactory = factory;
  return previous;
}

const sdkFactory: QueryFactory = async ({ prompt, options }) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query({ prompt, options });
};

/** Live sessions at once — each is a Claude subprocess. */
export const MAX_LIVE_SESSIONS = 8;

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

interface ChatSession {
  meta: ChatSessionMeta;
  log: ChatEvent[];
  listeners: Set<(event: ChatEvent) => void>;
  input: InputQueue<SDKUserMessage>;
  query: QueryLike | null;
  /** Pi sessions only: the RPC client in place of the SDK query. */
  pi: PiClient | null;
  abort: AbortController;
  pending: Map<string, PendingPermission>;
  /** A user message is in and its result is not yet out. */
  busy: boolean;
  /** Claude Code sends `init` with every turn; only the first is news. */
  initSeen: boolean;
  turn: number;
  commands: SlashCommandInfo[];
  recordPath: string;
  /** Record writes queue up here — two in flight would tear the file. */
  saving: Promise<void>;
  /** The last few stderr lines, for the error note when the CLI dies. */
  stderrTail: string[];
  /** Streaming state for mapSdkMessage. */
  stream: StreamContext;
  /** Streaming state for mapPiEvent. */
  piStream: PiStreamContext;
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
  return [...registry().values()].filter((s) => !FINAL.has(s.meta.status));
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
  if (FINAL.has(status)) session.meta.endedAt = new Date().toISOString();
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
    agent: m.agent === "pi" ? PI_PANE_AGENT : PANE_AGENT,
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

export interface CreateChatOptions {
  place: SessionPlace;
  name: string;
  /** Default: Claude. */
  agent?: ChatAgent;
  /** Sent as the first user message, before the pane says anything. */
  prompt?: string;
  permissionMode?: PermissionMode;
  /** <settings dir>/sessions — see sessionsDirectory in agent.ts. */
  sessionsDir: string;
  id?: string;
  now?: Date;
}

/**
 * Start one chat: spawn the agent on the work dir and begin pumping its
 * messages into the event log. Resolves as soon as the subprocess is
 * requested; the ready status follows on the stream.
 */
export async function createChatSession(opts: CreateChatOptions): Promise<ChatSessionMeta> {
  if (live().length >= MAX_LIVE_SESSIONS) {
    throw new ChatError(409, `At most ${MAX_LIVE_SESSIONS} coding agent sessions can run at once — end one first`);
  }
  const id = opts.id ?? randomUUID();
  const now = opts.now ?? new Date();
  const cwd = sessionWorkDir(opts.place);
  const agent = opts.agent ?? "claude";
  // Pi runs its own tools with no gate of any kind; saying "default" would
  // promise a prompt that never comes.
  const permissionMode = agent === "pi" ? "bypassPermissions" : (opts.permissionMode ?? "default");
  const session: ChatSession = {
    meta: {
      id,
      name: opts.name,
      agent,
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
    input: new InputQueue(),
    query: null,
    pi: null,
    abort: new AbortController(),
    pending: new Map(),
    busy: false,
    initSeen: false,
    turn: 0,
    commands: [],
    recordPath: join(opts.sessionsDir, id, "session.json"),
    saving: Promise.resolve(),
    stderrTail: [],
    stream: { messageId: null },
    piStream: newPiStream(),
  };
  registry().set(id, session);
  installShutdownHook();
  emit(session, { kind: "status", status: "starting", permissionMode }, now);

  if (agent === "pi") {
    startPi(session, opts, now);
    await saveRecord(session);
    return { ...session.meta };
  }

  // A dev server started from inside a Claude Code terminal inherits the
  // marker that makes a nested `claude` refuse to start; the chat is not
  // nested in any sense that matters.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const options: Options = {
    cwd,
    pathToClaudeCodeExecutable: which(CLAUDE_BIN) ?? undefined,
    includePartialMessages: true,
    permissionMode,
    // Lets the pane's mode select switch to bypass later; nothing bypasses
    // unless the user picks it.
    allowDangerouslySkipPermissions: true,
    abortController: session.abort,
    canUseTool: (toolName, input, ctx) => requestPermission(session, toolName, input, ctx),
    // Claude Code's own system prompt, CLAUDE.md, skills and project
    // commands — the point is a session like the one the CLI would open.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    // With a code repo the specs live elsewhere; let Claude read them.
    ...(opts.place.codeRepo ? { additionalDirectories: [opts.place.dataRepo] } : {}),
    env,
    stderr: (data) => {
      const line = data.trim();
      if (!line) return;
      session.stderrTail = [...session.stderrTail, line].slice(-5);
    },
  };

  if (opts.prompt) {
    session.turn = 1;
    session.busy = true;
    session.input.push(userMessage(opts.prompt));
    emit(session, { kind: "user", id: randomUUID(), text: opts.prompt }, now);
  }

  try {
    session.query = await (queryFactory ?? sdkFactory)({ prompt: session.input, options });
  } catch (e) {
    registry().delete(id);
    throw new ChatError(502, `Could not start Claude: ${(e as Error).message}`);
  }
  await saveRecord(session);
  void pump(session);
  void ready(session);
  return { ...session.meta };
}

/**
 * Claude Code answers control requests as soon as it is up, but sends its
 * `init` message only with the first turn — so the first answer is what
 * says the session is ready to type into, and it brings the "/" commands.
 */
async function ready(session: ChatSession): Promise<void> {
  try {
    const commands = await session.query!.supportedCommands();
    if (FINAL.has(session.meta.status)) return;
    session.commands = commands.map(commandInfo);
  } catch {
    // The names in init will do when it comes.
  }
  if (session.meta.status === "starting") {
    setStatus(session, session.busy ? "running" : "idle", {
      permissionMode: session.meta.permissionMode,
      commands: session.commands,
    });
  }
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** Read Claude's messages until it exits or we abort it. */
async function pump(session: ChatSession): Promise<void> {
  try {
    for await (const msg of session.query!) {
      handleMessage(session, msg);
    }
    if (!FINAL.has(session.meta.status)) await finish(session, "ended", "Claude exited.");
  } catch (e) {
    // Our own abort (end/shutdown) also ends the generator with an error.
    if (FINAL.has(session.meta.status)) return;
    const tail = session.stderrTail.join("\n");
    await finish(
      session,
      "error",
      tail ? `${(e as Error).message}\n${tail}` : (e as Error).message,
      session.meta.agentSessionId ? "ended" : "spawn_failed",
    );
  }
}

function handleMessage(session: ChatSession, msg: SDKMessage): void {
  if (msg.type === "system" && msg.subtype === "init") {
    const first = !session.initSeen;
    session.initSeen = true;
    session.meta.agentSessionId = msg.session_id;
    session.meta.model = msg.model;
    const mode = normalizePermissionMode(msg.permissionMode);
    if (mode) session.meta.permissionMode = mode;
    // Normally the readiness probe has the commands already; if it did not
    // answer, the names from init stand until the control request does.
    if (session.commands.length === 0) {
      session.commands = msg.slash_commands.map((name) => ({ name, description: "", argumentHint: "" }));
      void loadCommands(session);
    }
    void saveRecord(session);
    // Later inits only refresh the meta above.
    if (!first) return;
  }
  if (msg.type === "system" && msg.subtype === "commands_changed") {
    session.commands = msg.commands.map(commandInfo);
    emit(session, { kind: "status", status: session.meta.status, commands: session.commands });
    return;
  }
  for (const body of mapSdkMessage(msg, { turn: session.turn }, session.stream)) {
    emit(session, body);
  }
  if (msg.type === "system" && msg.subtype === "init") {
    setStatus(session, session.busy ? "running" : "idle", {
      agentSessionId: msg.session_id,
      model: msg.model,
      permissionMode: session.meta.permissionMode,
      tools: msg.tools,
      commands: session.commands,
    });
  }
  if (msg.type === "result") {
    session.busy = false;
    if (!FINAL.has(session.meta.status)) setStatus(session, "idle");
  }
}

function commandInfo(c: SlashCommand): SlashCommandInfo {
  return { name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "" };
}

async function loadCommands(session: ChatSession): Promise<void> {
  try {
    const commands = await session.query!.supportedCommands();
    if (FINAL.has(session.meta.status)) return;
    session.commands = commands.map(commandInfo);
    emit(session, { kind: "status", status: session.meta.status, commands: session.commands });
  } catch {
    // The names from init stand.
  }
}

// --- Pi (specs/agents/integration-with-pi-dev-agent.feature.md) -------------
//
// `pi --mode rpc` in place of the SDK query: commands out on stdin, events in
// on stdout (src/server/piChat.ts). Pi has no permission protocol and no
// control channel — a turn is a `prompt` command, a stop is `abort`, and the
// session ends when the process does.

/** Spawn pi for this session and wire its events into the log. */
function startPi(session: ChatSession, opts: CreateChatOptions, now: Date): void {
  session.pi = new PiClient({
    cwd: session.meta.cwd,
    name: session.meta.name,
    onEvent: (event) => handlePiEvent(session, event),
    onStderr: (line) => {
      session.stderrTail = [...session.stderrTail, line].slice(-5);
    },
    onExit: (code, error) => void piExited(session, code, error),
  });
  // The prompt can go before pi has read a byte: the pipe holds it until its
  // RPC loop starts.
  if (opts.prompt) {
    session.turn = 1;
    session.busy = true;
    session.pi.send({ type: "prompt", message: opts.prompt });
    emit(session, { kind: "user", id: randomUUID(), text: opts.prompt }, now);
  }
  void piReady(session);
}

/**
 * Pi answers commands as soon as its RPC loop is up, so the first answer is
 * what says the session is ready to type into — and it brings the model, pi's
 * own session id and the "/" commands.
 */
async function piReady(session: ChatSession): Promise<void> {
  const client = session.pi!;
  const [state, commands] = await Promise.all([
    client.request({ type: "get_state" }),
    client.request({ type: "get_commands" }),
  ]);
  if (FINAL.has(session.meta.status)) return;
  const info = piState(state.data);
  if (info.model) session.meta.model = info.model;
  if (info.sessionId) session.meta.agentSessionId = info.sessionId;
  session.commands = piCommands(commands.data);
  emit(session, {
    kind: "note",
    level: "info",
    code: "init",
    text: `Pi · ${info.model ?? "no model"} · ${session.meta.cwd}`,
  });
  // The one thing a Claude user must not assume here.
  emit(session, {
    kind: "note",
    level: "info",
    code: "init",
    text: "Pi runs its own tools — SpecDriven cannot gate them, so nothing asks for permission.",
  });
  void saveRecord(session);
  if (session.meta.status === "starting") {
    setStatus(session, session.busy ? "running" : "idle", {
      ...(session.meta.model ? { model: session.meta.model } : {}),
      ...(session.meta.agentSessionId ? { agentSessionId: session.meta.agentSessionId } : {}),
      permissionMode: session.meta.permissionMode,
      commands: session.commands,
    });
  }
}

function handlePiEvent(session: ChatSession, event: PiEvent): void {
  if (FINAL.has(session.meta.status)) return;
  if (event.type === "agent_start") {
    session.busy = true;
    if (session.meta.status === "idle") setStatus(session, "running");
  }
  for (const body of mapPiEvent(event, { turn: session.turn }, session.piStream)) {
    emit(session, body);
  }
  if (event.type === "agent_settled") {
    session.busy = false;
    if (!FINAL.has(session.meta.status)) setStatus(session, "idle");
  }
}

/** Pi is gone: an exit code of its own, or an Error where it never started. */
function piExited(session: ChatSession, code: number | null, error?: Error): Promise<void> {
  if (FINAL.has(session.meta.status)) return Promise.resolve();
  const tail = session.stderrTail.join("\n");
  const detail = (text: string) => (tail ? `${text}\n${tail}` : text);
  if (error) {
    return finish(session, "error", detail(`Could not start Pi: ${error.message}`), "spawn_failed");
  }
  if (code === 0 || code === null) return finish(session, "ended", "Pi exited.");
  return finish(session, "error", detail(`Pi exited with code ${code}.`));
}

export interface StreamContext {
  /** The API message id the current stream_event deltas belong to. */
  messageId: string | null;
}

/**
 * The SDK message → our events. Pure apart from `stream`, which remembers
 * which message the partial deltas belong to (a delta names its block
 * index, not its message). Messages the pane has no use for map to nothing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  ctx: { turn: number },
  stream: StreamContext = { messageId: null },
): ChatEventBody[] {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return [
          {
            kind: "note",
            level: "info",
            code: "init",
            text: `Claude Code ${msg.claude_code_version} · ${msg.model} · ${msg.cwd}`,
          },
        ];
      }
      if (msg.subtype === "compact_boundary") {
        const m = msg.compact_metadata;
        return [
          {
            kind: "note",
            level: "info",
            code: "compact",
            text: `Context compacted (${m.trigger}) — ${m.pre_tokens} tokens before.`,
          },
        ];
      }
      return [];
    }
    case "stream_event": {
      const ev = msg.event;
      if (ev.type === "message_start") {
        stream.messageId = ev.message.id;
        return [];
      }
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        return [
          {
            kind: "text_delta",
            messageId: stream.messageId ?? "",
            index: ev.index,
            text: ev.delta.text,
          },
        ];
      }
      return [];
    }
    case "assistant": {
      const blocks: AssistantBlock[] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") blocks.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      const events: ChatEventBody[] = [];
      if (blocks.length > 0) {
        events.push({
          kind: "assistant",
          messageId: msg.message.id,
          turn: ctx.turn,
          blocks,
          parentToolUseId: msg.parent_tool_use_id,
        });
      }
      if (msg.error) {
        events.push({ kind: "note", level: "error", code: "api", text: `API error: ${msg.error}` });
      }
      return events;
    }
    case "user": {
      // Only tool results are Claude's news; the rest is our own input
      // coming back (replays, synthetic turns).
      if ("isReplay" in msg && msg.isReplay) return [];
      const content = msg.message.content;
      if (typeof content === "string") return [];
      const events: ChatEventBody[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        events.push({
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: flattenResult(block.content),
          isError: block.is_error === true,
          parentToolUseId: msg.parent_tool_use_id,
        });
      }
      return events;
    }
    case "result": {
      const text =
        msg.subtype === "success" ? msg.result : msg.errors.filter(Boolean).join("\n");
      return [
        {
          kind: "result",
          turn: ctx.turn,
          subtype: msg.subtype,
          isError: msg.is_error,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          ...(text ? { text } : {}),
          denials: msg.permission_denials.length,
        },
      ];
    }
    default:
      return [];
  }
}

/** A tool result's content as one string: text joined, images named. */
function flattenResult(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text") return p.text ?? "";
        return `[${p.type}]`;
      }
      return JSON.stringify(part);
    })
    .join("\n");
}

/** The SDK asks; the pane answers (specs: "permission card"). */
function requestPermission(
  session: ChatSession,
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string },
): Promise<PermissionResult> {
  if (FINAL.has(session.meta.status)) {
    return Promise.resolve({ behavior: "deny", message: "The session has ended" });
  }
  const requestId = randomUUID();
  return new Promise<PermissionResult>((resolve) => {
    session.pending.set(requestId, {
      toolName,
      input,
      suggestions: ctx.suggestions ?? [],
      resolve,
    });
    emit(session, {
      kind: "permission_request",
      requestId,
      toolName,
      input,
      suggestions: ctx.suggestions ?? [],
      ...(ctx.title ? { title: ctx.title } : {}),
    });
    setStatus(session, "awaiting_input");
    // The SDK withdrew the question (an interrupt, a dying turn).
    ctx.signal.addEventListener("abort", () => {
      if (!session.pending.has(requestId)) return;
      resolvePending(session, requestId, { behavior: "deny", message: "Cancelled" }, "interrupt");
    });
  });
}

function resolvePending(
  session: ChatSession,
  requestId: string,
  result: PermissionResult,
  via: "user" | "interrupt" | "ended",
): void {
  const pending = session.pending.get(requestId);
  if (!pending) return;
  session.pending.delete(requestId);
  pending.resolve(result);
  emit(session, { kind: "permission_resolved", requestId, behavior: result.behavior, via });
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
  session.input.close();
  session.pi?.close();
  return saveRecord(session);
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

export function isFinalStatus(status: ChatStatus): boolean {
  return FINAL.has(status);
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
  if (FINAL.has(session.meta.status)) throw new ChatError(409, "The session has ended");
  if (session.busy) throw new ChatError(409, "A turn is in progress — Stop it first");
  session.turn += 1;
  session.busy = true;
  if (session.pi) session.pi.send({ type: "prompt", message: trimmed });
  else session.input.push(userMessage(trimmed));
  const event = emit(session, { kind: "user", id: randomUUID(), text: trimmed });
  if (session.meta.status === "idle") setStatus(session, "running");
  return event;
}

export interface PermissionAnswer {
  requestId: string;
  behavior: "allow" | "deny";
  /** Deny: why — Claude reads it. */
  message?: string;
  /** Allow: the input to run with (AskUserQuestion answers go here). */
  updatedInput?: Record<string, unknown>;
  /** Allow: also apply the SDK's suggested rule, so it stops asking. */
  remember?: boolean;
}

export function answerPermission(id: string, answer: PermissionAnswer): void {
  const session = get(id);
  const pending = session.pending.get(answer.requestId);
  if (!pending) throw new ChatError(404, "no such permission request — it may have been answered");
  const result: PermissionResult =
    answer.behavior === "allow"
      ? {
          behavior: "allow",
          updatedInput: answer.updatedInput ?? pending.input,
          ...(answer.remember && pending.suggestions.length > 0
            ? { updatedPermissions: pending.suggestions }
            : {}),
        }
      : { behavior: "deny", message: answer.message?.trim() || "Denied in SpecDriven" };
  resolvePending(session, answer.requestId, result, "user");
}

/** Stop the current turn; the agent stays up for the next message. */
export async function interruptChat(id: string): Promise<void> {
  const session = get(id);
  if (session.meta.status !== "running" && session.meta.status !== "awaiting_input") {
    throw new ChatError(409, "Nothing is running");
  }
  denyAllPending(session, "interrupt", "Interrupted by the user");
  emit(session, { kind: "note", level: "info", code: "interrupted", text: "Stopped." });
  if (session.pi) {
    // Pi answers `abort` only once it is idle again; the turn's own
    // `agent_settled` is what puts the session back to idle.
    await session.pi.request({ type: "abort" });
    return;
  }
  await session.query!.interrupt();
}

export async function setChatPermissionMode(id: string, mode: PermissionMode): Promise<void> {
  const session = get(id);
  if (FINAL.has(session.meta.status)) throw new ChatError(409, "The session has ended");
  if (session.meta.agent === "pi") {
    throw new ChatError(409, "Pi has no permission modes — it runs its own tools");
  }
  if (session.meta.status === "starting") throw new ChatError(409, "Claude is still starting");
  await session.query!.setPermissionMode(mode);
  session.meta.permissionMode = mode;
  emit(session, { kind: "mode", permissionMode: mode });
  void saveRecord(session);
}

/** End the chat and forget it: the subprocess is aborted, the record kept. */
export async function endChatSession(id: string): Promise<void> {
  const session = get(id);
  if (!FINAL.has(session.meta.status)) {
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
    if (!FINAL.has(session.meta.status)) {
      saves.push(finish(session, "ended", "SpecDriven is shutting down."));
      session.abort.abort();
    }
  }
  registry().clear();
  await Promise.all(saves);
}

// `exit` handlers cannot await; aborting is synchronous and the SDK kills
// the child on it. Installed once, the first time a session starts, so a
// server that never opens the pane is untouched.
const HOOK = Symbol.for("specdriven.agentChat.exitHook");
function installShutdownHook(): void {
  const flags = globalThis as Record<symbol, unknown>;
  if (flags[HOOK]) return;
  flags[HOOK] = true;
  process.on("exit", () => {
    for (const session of registry().values()) {
      if (FINAL.has(session.meta.status)) continue;
      session.abort.abort();
      session.pi?.close();
    }
  });
}
