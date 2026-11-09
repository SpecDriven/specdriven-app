// The coding agent pane's contract types (specs/agents/agent-pane.feature.md,
// specs/agents/agent-plugins.feature.md): what the engine
// (src/server/agentChat.ts), the providers behind it (src/plugins/host/
// agents.ts) and the browser (src/frontend/agentChat.ts) all speak. Nothing
// here imports server-only code, and nothing names an agent: a provider is
// a plugin's, and the core only knows its descriptor.

/** A provider id — "claude", "codex", "pi", or whatever a plugin registers. */
export type ChatAgent = string;

/** The permission modes the pane offers, in its order; the Claude SDK knows
    one more (dontAsk). "default" is the SDK's name for asking every time. */
export type PermissionMode = "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "auto",
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
 *   starting → (ready) → idle ⇄ running ⇄ awaiting_input, and finally ended
 *   or error. `awaiting_input` means the agent asked for a permission (or a
 *   clarifying question) and waits for the pane's answer.
 */
export type ChatStatus = "starting" | "idle" | "running" | "awaiting_input" | "ended" | "error";

const FINAL: ReadonlySet<ChatStatus> = new Set(["ended", "error"]);

export function isFinalStatus(status: ChatStatus): boolean {
  return FINAL.has(status);
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

/** How a session is signed in and billed, when the agent says. "plan" is a
    subscription, "api" pay-per-token, "provider" a cloud or gateway
    backend, "none" nobody. */
export interface ChatAccount {
  billing: "plan" | "api" | "provider" | "none";
  /** Short chip text: "Claude Max", "API billing", "Not logged in". */
  label: string;
  /** Tooltip: who is signed in and where the credential came from. */
  detail: string;
}

/** A "remember this" rule the agent suggests with a permission request and
    the pane may send back with "Allow always"; its shape is the provider's. */
export type PermissionSuggestion = Record<string, unknown>;

/** A session's own git worktree (src/server/agentWorktree.ts): a checkout
    of the picked folder's repo on a new branch, where the agent works. */
export interface ChatWorktree {
  /** The folder the pane picked; the session is shown as working there. */
  folder: string;
  /** The top of that folder's repo, which owns the worktree. */
  repo: string;
  /** The worktree's top folder. */
  path: string;
  /** Where the agent works: the picked folder's place inside the worktree. */
  cwd: string;
  /** The branch made for the session. */
  branch: string;
  /** The branch it was made from, when one was checked out. */
  base?: string;
}

// --- Context usage -------------------------------------------------------------

/** One thing a context slice is made of: an MCP tool, a memory file, a skill. */
export interface ContextItem {
  name: string;
  /** Where it comes from: the MCP server, "Project", a skill's source. */
  detail?: string;
  tokens: number;
}

/**
 * One row of an agent's context breakdown, as the session popover's meter
 * and legend show it. `used` rows fill the window; `buffer` is the reserve
 * the agent keeps for compaction; `free` is what is left; `deferred` rows
 * (tool schemas loaded on demand) are listed but not counted.
 */
export interface ContextSlice {
  /** A stable key the pane colours by, Claude Code's own where it has one:
      "system_prompt", "system_tools", "mcp_tools", "memory_files",
      "skills", "messages", "autocompact_buffer", "free_space", or whatever
      an agent adds. */
  id: string;
  /** The row's words, as the agent names it ("MCP tools"). */
  label: string;
  tokens: number;
  kind: "used" | "buffer" | "free" | "deferred";
  /** What a `used` row is made of; the popover lists them under the row. */
  items?: ContextItem[];
}

/**
 * How full a session's context window is (specs/agents/agent-pane.feature.md
 * S10): the agent's own count, refreshed after every turn. The percentage is
 * the pane's to work out — `maxTokens` is null when the agent does not say
 * how big its window is.
 */
export interface ChatContextUsage {
  /** ISO 8601: when the agent counted. */
  at: string;
  /** The model the count is for. */
  model?: string;
  /** Tokens in the window now. */
  totalTokens: number;
  /** The window's size, or null when the agent does not say. */
  maxTokens: number | null;
  /** The count at which the agent compacts the conversation on its own. */
  autoCompactAt?: number;
  /** The breakdown, for an agent that gives one. */
  slices?: ContextSlice[];
  /** "estimate": from the last response and local counts; "measured": every
      category counted by the API. */
  detail: "estimate" | "measured";
}

export type ContextDetail = "summary" | "full";

export function normalizeContextDetail(value: unknown): ContextDetail {
  return value === "full" ? "full" : "summary";
}

export interface ChatSessionMeta {
  id: string;
  name: string;
  /** Which provider drives the chat. */
  agent: ChatAgent;
  /** The folder the agent works in: the code repo, else the data repo —
      or, with a worktree, the folder's place inside it. */
  cwd: string;
  /** The session's own worktree, when it was started with one. */
  worktree?: ChatWorktree;
  dataRepo: string;
  codeRepo?: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt?: string;
  status: ChatStatus;
  /** The agent's own session id — Claude Code's, pi's, Codex's thread id —
      once it says it. */
  agentSessionId?: string;
  model?: string;
  /** The reasoning effort the session runs at, when its agent has one;
      absent is the agent's own default. */
  effort?: EffortLevel;
  /** The login and billing source, once a provider that has one says. */
  account?: ChatAccount;
  /** A provider with no permission gate sits on its default and refuses a
      change (see setChatPermissionMode). */
  permissionMode: PermissionMode;
  /** How full the context window is, once the agent has said. The session
      list leaves it out (listChatSessions); one session's answer has it. */
  context?: ChatContextUsage;
  /** Sequence number of the last event in the log. */
  lastSeq: number;
}

// --- Pasted images ------------------------------------------------------------

/** The image types every agent reads (the Claude API's list). */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function normalizeImageMediaType(value: unknown): ImageMediaType | null {
  return (IMAGE_MEDIA_TYPES as readonly unknown[]).includes(value) ? (value as ImageMediaType) : null;
}

/** The largest image a message carries, in bytes: the Claude API refuses
    one whose base64 is over 5 MB, and base64 is 4/3 of the bytes. The pane
    scales a bigger paste down before it gets here. */
export const MAX_IMAGE_BYTES = 3_750_000;

/** Images in one message at most. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * Coding agent sessions open at once — a tab each in the pane
 * (specs/agents/agent-pane.feature.md "Each session has its own tab"). An
 * ended session holds its tab, and its slot, until it is closed.
 */
export const MAX_OPEN_SESSIONS = 5;

/** An image as the pane sends it: the bytes, base64. */
export interface ImageUpload {
  mediaType: ImageMediaType;
  data: string;
  /** The pasted file's name, when it had one. */
  name?: string;
}

/** An image as a `user` event shows it: where to fetch it, not its bytes. */
export interface ChatImage {
  id: string;
  mediaType: ImageMediaType;
  /** GET this for the bytes (src/server/api.ts). */
  url: string;
  name?: string;
}

/** An image as a provider gets it: the bytes, and the file the engine kept
    them in (an agent that reads images from disk takes the path). */
export interface AgentImage {
  mediaType: ImageMediaType;
  /** Base64, no data: prefix. */
  data: string;
  /** Absolute path of the saved copy. */
  path: string;
}

/** One block of an assistant turn the pane renders. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type NoteCode = "init" | "compact" | "stderr" | "ended" | "spawn_failed" | "interrupted" | "api";

export type ChatEventBody =
  | {
      kind: "status";
      status: ChatStatus;
      agentSessionId?: string;
      model?: string;
      effort?: EffortLevel;
      account?: ChatAccount;
      permissionMode?: PermissionMode;
      tools?: string[];
      commands?: SlashCommandInfo[];
    }
  /** What the pane sent — echoed from the request, never from a replay. */
  | { kind: "user"; id: string; text: string; images?: ChatImage[] }
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
      suggestions: PermissionSuggestion[];
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
  /** The pane switched the model (null: the agent's own default). */
  | { kind: "model"; model: string | null }
  /** The pane switched the effort (null: the agent's own default). */
  | { kind: "effort"; effort: EffortLevel | null }
  /** The agent counted its context window (AgentHost.context). The log keeps
      only the newest one. */
  | { kind: "context"; context: ChatContextUsage }
  | { kind: "note"; level: "info" | "error"; code: NoteCode; text: string };

export type ChatEvent = ChatEventBody & { seq: number; at: string };

/** What a provider may put in the log itself: the agent's own output. The
    rest — status, the user's text, permission cards, mode changes — is the
    engine's (src/plugins/host/agents.ts AgentHost). */
export type AgentOutput = Exclude<
  ChatEventBody,
  {
    kind:
      | "status"
      | "user"
      | "permission_request"
      | "permission_resolved"
      | "mode"
      | "model"
      | "effort"
      | "context";
  }
>;

export interface PermissionAnswer {
  requestId: string;
  behavior: "allow" | "deny";
  /** Deny: why — the agent reads it. */
  message?: string;
  /** Allow: the input to run with (AskUserQuestion answers go here). */
  updatedInput?: Record<string, unknown>;
  /** Allow: also apply the suggested rule, so it stops asking. */
  remember?: boolean;
}

// --- What a provider says of itself -----------------------------------------

export interface AgentCapabilities {
  /** The modes the pane may pick; [] means no permission gate at all. */
  permissionModes: readonly PermissionMode[];
  /** The chip's tooltip when there is no gate ("Pi runs its own tools…"). */
  noPermissionsNote?: string;
  canInterrupt: boolean;
  /** Whether the mode changes while a turn runs (Codex: from the next turn). */
  canChangeModeMidSession: boolean;
  /** Whether the header shows a billing chip. */
  hasAccount: boolean;
  /** What "Allow always" means: a rule the agent keeps, this session only, or nothing to offer. */
  rememberPermissions: "rule" | "session" | "none";
  /** Whether the provider answers one no-tools turn (src/server/estimate.ts). */
  oneShot: boolean;
  /** Whether a running session switches model when the pane asks
      (AgentSession.setModel); absent is no. */
  canChangeModelMidSession?: boolean;
  /** Whether the agent takes a reasoning effort (AgentStartOptions.effort,
      AgentSession.setEffort); absent is no. */
  effort?: boolean;
  /** Whether a message may carry images (AgentSession.send's images,
      AgentStartOptions.images); absent is no. */
  images?: boolean;
  /** What the agent says of its context window (AgentHost.context):
      "breakdown" — the count by category, and a fresh one on request
      (AgentSession.contextUsage); "totals" — the count and the window's
      size alone; absent — nothing. */
  contextUsage?: "breakdown" | "totals";
}

// --- Model and effort --------------------------------------------------------

/** How hard the agent thinks, as Claude Code names the levels. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** An effort level, or null when the value is none. */
export function normalizeEffort(value: unknown): EffortLevel | null {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value) ? (value as EffortLevel) : null;
}

/** Letters, digits and the punctuation model ids use — `opus`,
    `claude-sonnet-4-5[1m]`, `us.anthropic.claude-…:0`, an inference
    profile's arn — with no spaces. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/;

/** A model alias or id, trimmed, or null when the value is none. */
export function normalizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return MODEL_ID.test(model) ? model : null;
}

/** One entry of an agent's model menu. */
export interface AgentModelOption {
  /** What the agent takes as a model: an alias such as `opus`, or an id. */
  value: string;
  /** The model id the value stands for now (an alias's target), so a
      session that reports the id still finds its entry. */
  resolvedModel?: string;
  displayName: string;
  description?: string;
  /** The effort levels this model takes; absent is "the agent decides"
      (every level offered), [] is none. */
  efforts?: EffortLevel[];
}

/** What the pane offers for an agent: its models, and what a new session
    starts on (null: the agent's own default). */
export interface AgentChoices {
  models: AgentModelOption[];
  model: string | null;
  effort: EffortLevel | null;
  /** The sign-in a new session would start under, for an agent with an
      account (capabilities.hasAccount): the pane header's API / ACNT chip
      before any session has said which (specs/agents/agent-pane.feature.md
      S13). Absent from an agent that cannot say without a session. */
  account?: ChatAccount;
  /** What the agent's API answered when the app last tried it — on a
      folder switch, or the pane's Retry (specs/agents/agent-pane.feature.md
      S14). The core adds it; absent until a try, and for an agent with
      nothing to try (an account sign-in). */
  connection?: AgentConnection;
}

/** One try of an agent's API: whether it answered, in words, and when. */
export interface AgentConnection {
  ok: boolean;
  /** "Reachable", or why not: "Could not reach http://localhost:6655: …". */
  detail: string;
  /** The API's address, for the pane's words. */
  url?: string;
  at: string;
}

/** A change to the defaults a new session starts on; null clears one. */
export interface AgentDefaultsPatch {
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface AgentDescriptor {
  id: string;
  label: string;
  description: string;
  /** The command the provider needs on PATH. */
  cli?: string;
  /** The CLI was found and the app is not hosted. */
  available: boolean;
  /** The 502 text, and the pane's empty-state copy, while !available. */
  missingMessage: string;
  /** The plugin that supplies it: "agent-claude", "core", or "demo". */
  plugin: string;
  capabilities: AgentCapabilities;
  defaultPermissionMode: PermissionMode;
  /** Lower first; Claude 10, Codex 20, Pi 30. */
  rank: number;
  /** Shown under a failed turn that looks like a sign-in problem. */
  loginHint?: { text: string; command?: string };
}

/** A marketplace plugin that would supply an agent, not installed. */
export interface AgentOffer {
  plugin: string;
  marketplace: string;
  label: string;
  description: string;
  cli: string;
  cliFound: boolean;
}

const NO_CAPABILITIES: AgentCapabilities = {
  permissionModes: [],
  canInterrupt: false,
  canChangeModeMidSession: false,
  hasAccount: false,
  rememberPermissions: "none",
  oneShot: false,
};

/** A descriptor for a record whose plugin is gone: a name, no modes, no
    Stop, and a new session refused. */
export function fallbackDescriptor(id: string): AgentDescriptor {
  const label = id ? id.charAt(0).toUpperCase() + id.slice(1) : "Agent";
  return {
    id,
    label,
    description: `No plugin provides "${id}"`,
    available: false,
    missingMessage: `No agent plugin provides "${id}" — install it from Settings → Plugins`,
    plugin: "",
    capabilities: NO_CAPABILITIES,
    defaultPermissionMode: "default",
    rank: Number.MAX_SAFE_INTEGER,
  };
}

/** Sort: rank, then id — the order the pane lists agents in. */
export const byRank = (a: AgentDescriptor, b: AgentDescriptor): number =>
  a.rank - b.rank || a.id.localeCompare(b.id);

// --- MCP servers -------------------------------------------------------------

/**
 * An MCP server the core asks a provider to start beside the agent
 * (src/server/agentMcp.ts): a command to run over stdio, with the
 * environment it needs. The provider hands it to its agent the way that
 * agent takes MCP servers; a provider that cannot ignores it.
 */
export interface AgentMcpServer {
  /** The server's name as the agent lists its tools (`mcp__<name>__<tool>`). */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
