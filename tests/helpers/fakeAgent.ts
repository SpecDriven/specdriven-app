// A fake AgentProvider (src/plugins/host/agents.ts) for the engine tests:
// every session it starts exposes the AgentHost it was lent, so a test
// plays the agent's side — emits output, raises a permission card, ends a
// turn, dies — and reads what the engine made of it.

import type {
  AgentHost,
  AgentProvider,
  AgentSession,
  AgentStartOptions,
} from "../../src/plugins/host/agents";
import type { AgentCapabilities, PermissionMode } from "../../src/server/agentTypes";

export interface FakeSession extends AgentSession {
  host: AgentHost;
  opts: AgentStartOptions;
  sent: string[];
  interrupts: number;
  modes: PermissionMode[];
  closed: boolean;
  /** How often the engine handed it a changed sign-in (AgentSession.refresh). */
  refreshes: number;
}

export interface FakeProviderOptions extends Partial<Omit<AgentProvider, "start" | "capabilities">> {
  capabilities?: Partial<AgentCapabilities>;
  /** start() rejects with this. */
  startError?: Error;
  /** send() rejects with this. */
  sendError?: Error;
  /** Call host.ready() as soon as start() runs. Default true. */
  readyAtStart?: boolean;
  /** Give the sessions no refresh(), as a provider that predates it. */
  noRefresh?: boolean;
  /** refresh() rejects with this. */
  refreshError?: Error;
}

export function fakeProvider(options: FakeProviderOptions = {}): { provider: AgentProvider; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const id = options.id ?? "fake";
  const label = options.label ?? "Fake";
  const provider: AgentProvider = {
    id,
    label,
    description: options.description ?? "A fake agent",
    rank: options.rank ?? 50,
    ...(options.cli ? { cli: options.cli } : {}),
    available: options.available ?? (() => true),
    missingMessage: options.missingMessage ?? `${label} CLI not found`,
    capabilities: {
      permissionModes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "rule",
      oneShot: false,
      ...options.capabilities,
    },
    defaultPermissionMode: options.defaultPermissionMode ?? "default",
    ...(options.loginHint ? { loginHint: options.loginHint } : {}),
    ...(options.oneShot ? { oneShot: options.oneShot } : {}),
    async start(opts) {
      if (options.startError) throw options.startError;
      const session: FakeSession = {
        host: opts.host,
        opts,
        sent: [],
        interrupts: 0,
        modes: [],
        closed: false,
        refreshes: 0,
        async send(text) {
          if (options.sendError) throw options.sendError;
          session.sent.push(text);
        },
        async interrupt() {
          session.interrupts += 1;
        },
        async setPermissionMode(mode) {
          session.modes.push(mode);
        },
        close() {
          session.closed = true;
        },
        ...(options.noRefresh
          ? {}
          : {
              async refresh() {
                session.refreshes += 1;
                if (options.refreshError) throw options.refreshError;
              },
            }),
      };
      opts.signal.addEventListener("abort", () => session.close(), { once: true });
      sessions.push(session);
      if (options.readyAtStart !== false) queueMicrotask(() => opts.host.ready({ model: "fake-1", commands: [] }));
      return session;
    },
  };
  return { provider, sessions };
}
