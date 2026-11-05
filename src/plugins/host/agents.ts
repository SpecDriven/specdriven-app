// The agent extension point (specs/agents/agent-plugins.feature.md): a
// plugin's host half registers an AgentProvider, and the coding agent pane
// (src/server/agentChat.ts) drives whatever is registered. The core names
// no agent; Claude, Codex and Pi are providers like any a future plugin
// brings. What a provider gets is an AgentHost — the only way into the
// session's event log and state — and what it gives back is an
// AgentSession: send, interrupt, change mode, close.
//
// The registry hangs off globalThis like the session registry: `bun --hot`
// swaps modules but keeps globalThis, so a reload re-registers over the
// same providers instead of beside them.

import type { Disposer } from "../kernel";
import type {
  AgentCapabilities,
  AgentChoices,
  AgentDefaultsPatch,
  AgentDescriptor,
  AgentImage,
  EffortLevel,
  AgentOutput,
  ChatAccount,
  ChatStatus,
  NoteCode,
  PermissionMode,
  PermissionSuggestion,
  SlashCommandInfo,
} from "../../server/agentTypes";
import { byRank } from "../../server/agentTypes";

export interface AgentProvider {
  id: string;
  label: string;
  description: string;
  /** Lower first; Claude 10, Codex 20, Pi 30. Default 100. */
  rank?: number;
  /** The command the provider needs on PATH. */
  cli?: string;
  available(): boolean;
  /** The 502 text, and the pane's empty-state copy, while !available(). */
  missingMessage: string;
  capabilities: AgentCapabilities;
  defaultPermissionMode: PermissionMode;
  loginHint?: AgentDescriptor["loginHint"];
  /** Spawn; resolves once the subprocess is requested. Readiness arrives
      through host.ready, failure through host.failed. A rejection is a
      session that never started (a 502 with its words). */
  start(opts: AgentStartOptions): Promise<AgentSession>;
  /** One no-tools turn, no record, no permissions (src/server/estimate.ts). */
  oneShot?(req: OneShotRequest): Promise<OneShotResult>;
  /** The models the pane offers, and the model and effort a new session
      starts on; absent, the pane offers no model or effort. */
  choices?(ctx: { dataRepo: string | null }): Promise<AgentChoices>;
  /** Make a model or effort the pane picked what new sessions start on. */
  setDefaults?(patch: AgentDefaultsPatch): Promise<void>;
}

export interface AgentStartOptions {
  sessionId: string;
  name: string;
  cwd: string;
  dataRepo: string;
  codeRepo?: string;
  permissionMode: PermissionMode;
  /** The model the pane picked; absent, the agent's default (choices().model). */
  model?: string;
  /** The effort the pane picked; absent, the agent's default. */
  effort?: EffortLevel;
  /** The first turn; the core has echoed it as the `user` event and counted turn 1. */
  prompt?: string;
  /** Images pasted with the first turn; only for a provider whose
      capabilities.images is true. */
  images?: AgentImage[];
  /** Fires on end and on shutdown. */
  signal: AbortSignal;
  host: AgentHost;
}

export interface AgentReadyInfo {
  agentSessionId?: string;
  model?: string;
  effort?: EffortLevel;
  account?: ChatAccount;
  tools?: string[];
  commands?: SlashCommandInfo[];
  permissionMode?: PermissionMode;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; remember: boolean }
  | { behavior: "deny"; message: string };

export interface PermissionOutcome {
  decision: PermissionDecision;
  /** Who settled it: the user, a Stop (or the provider withdrawing it), or the session's end. */
  via: "user" | "interrupt" | "ended";
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  title?: string;
  /** The provider withdrew the question (an interrupt, a dying turn). */
  signal?: AbortSignal;
}

/** What the core lends a provider: the only way into the event log and session state. */
export interface AgentHost {
  /** The agent's own output: text, tool rows, results, notes. */
  emit(body: AgentOutput): void;
  note(level: "info" | "error", code: NoteCode, text: string): void;
  /** The session is ready to type into: starting → running|idle. Later
      calls refresh what the pane shows (a model, an account, commands). */
  ready(info: AgentReadyInfo): void;
  /** Refresh the session's facts; `quiet` keeps it off the event log. */
  update(info: Partial<AgentReadyInfo>, opts?: { quiet?: boolean }): void;
  /** The agent began a turn the pane did not send (Pi agent_start, Codex turn/started). Idempotent. */
  turnStarted(): void;
  /** The turn is over: open cards close, the composer frees. */
  turnEnded(): void;
  /** Raise a permission card and wait for its answer. */
  requestPermission(req: PermissionRequest): Promise<PermissionOutcome>;
  /** The process is gone, normally. */
  ended(text: string): void;
  /** The process is gone, or never came. */
  failed(text: string, code?: "ended" | "spawn_failed"): void;
  status(): ChatStatus;
  busy(): boolean;
  turn(): number;
  permissionMode(): PermissionMode;
}

export interface AgentSession {
  /** One user turn. A rejection means the turn never started: the core
      notes the words and frees the composer. `text` may be empty when
      images came; images come only where capabilities.images is true. */
  send(text: string, images?: AgentImage[]): Promise<void>;
  interrupt(): Promise<void>;
  /** Throw an AgentError(409, …) to refuse. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Switch the model from the next request on (null: the agent's own
      default); capabilities.canChangeModelMidSession says it is there.
      Throw an AgentError(409, …) to refuse. */
  setModel?(model: string | null): Promise<void>;
  /** Switch the effort from the next request on (null: the agent's own
      default); capabilities.effort says it is there. */
  setEffort?(effort: EffortLevel | null): Promise<void>;
  /** Kill the child; must be safe to call from an exit hook (no await). */
  close(): void;
  /** The agent's sign-in changed (AgentRegistry.changed): drop what the
      session holds of the old one — its credentials, the account the pane
      shows — and pick up the new. A turn under way may finish first;
      absent, the session keeps what it started with. */
  refresh?(): void | Promise<void>;
}

export interface OneShotRequest {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /** A JSON schema the answer must fit, when the provider can hold it to one. */
  schema?: Record<string, unknown>;
  /** The model to answer with, as the agent's CLI names it; absent, the agent's own default. */
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OneShotResult {
  text: string;
  structured?: unknown;
  isError: boolean;
}

/** An HTTP-shaped refusal from a provider: the route answers with `status`. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentChange {
  /** "changed": what the provider is or who it is signed in as moved on. */
  type: "added" | "removed" | "changed";
  id: string;
}

export interface AgentRegistry {
  /** The same id again (a `bun --hot` reload) replaces the provider and warns. */
  register(provider: AgentProvider): Disposer;
  get(id: string): AgentProvider | undefined;
  /**
   * The provider's sign-in or setup changed — an account signed in or out,
   * its CLI fetched: open pages re-read the descriptors, and its live
   * sessions refresh (AgentSession.refresh). An id not registered is nothing.
   */
  changed(id: string): void;
  /** By rank, then id. */
  list(): AgentProvider[];
  describe(): AgentDescriptor[];
  /** The lowest-ranked available provider. */
  default(): AgentProvider | undefined;
  /** A provider that answers one-shot turns: the preferred one when it does, else the first by rank. */
  oneShot(preferred?: string): AgentProvider | undefined;
  subscribe(fn: (change: AgentChange) => void): Disposer;
}

export const DEFAULT_RANK = 100;

export function describeProvider(p: AgentProvider): AgentDescriptor {
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    ...(p.cli ? { cli: p.cli } : {}),
    available: p.available(),
    missingMessage: p.missingMessage,
    plugin: pluginOf(p),
    capabilities: p.capabilities,
    defaultPermissionMode: p.defaultPermissionMode,
    rank: p.rank ?? DEFAULT_RANK,
    ...(p.loginHint ? { loginHint: p.loginHint } : {}),
  };
}

/** The plugin a provider came from, stamped by the registry at register time. */
const PLUGIN = Symbol.for("specdriven.agents.plugin");
function pluginOf(p: AgentProvider): string {
  return ((p as unknown as Record<symbol, unknown>)[PLUGIN] as string | undefined) ?? "core";
}

export function createAgentRegistry(): AgentRegistry {
  const providers = new Map<string, AgentProvider>();
  const listeners = new Set<(change: AgentChange) => void>();
  const notify = (change: AgentChange) => {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch {
        // A listener's failure is not the registry's.
      }
    }
  };
  const sorted = () => [...providers.values()].sort((a, b) => byRank(describeProvider(a), describeProvider(b)));
  return {
    register(provider) {
      if (!provider.id) throw new Error("an agent provider needs an id");
      const earlier = providers.get(provider.id);
      // The same plugin registering twice is a reload worth a word; another
      // plugin taking the id over (the demo's simulation) is by design.
      if (earlier && pluginOf(earlier) === pluginOf(provider)) {
        console.warn(`[agents] "${provider.id}" registered again — replacing the earlier provider`);
      }
      providers.set(provider.id, provider);
      notify({ type: "added", id: provider.id });
      return () => {
        if (providers.get(provider.id) !== provider) return;
        providers.delete(provider.id);
        notify({ type: "removed", id: provider.id });
      };
    },
    get: (id) => providers.get(id),
    changed(id) {
      if (providers.has(id)) notify({ type: "changed", id });
    },
    list: sorted,
    describe: () => sorted().map(describeProvider),
    default: () => sorted().find((p) => p.available()),
    oneShot(preferred) {
      const can = (p: AgentProvider | undefined) => p && p.oneShot && p.available() ? p : undefined;
      return can(preferred ? providers.get(preferred) : undefined) ?? sorted().find((p) => can(p));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Stamp the plugin a provider belongs to, for its descriptor. */
export function fromPlugin<T extends AgentProvider>(provider: T, plugin: string): T {
  (provider as unknown as Record<symbol, unknown>)[PLUGIN] = plugin;
  return provider;
}

const REGISTRY = Symbol.for("specdriven.agents.registry");

/** The one registry: `bun --hot` keeps globalThis, so it survives a reload. */
export const agents: AgentRegistry = (() => {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY]) g[REGISTRY] = createAgentRegistry();
  return g[REGISTRY] as AgentRegistry;
})();

declare module "../kernel" {
  interface Services {
    agents: AgentRegistry;
  }
}
