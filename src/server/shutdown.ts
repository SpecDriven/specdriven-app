// Leaving the app in order (specs/ui/ui.feature.md "Quitting the app ends
// its work in order"). Both ways out go through `shutdown`: a signal to the
// web server (src/index.ts) and the desktop app's quit (src/electron/main.ts).
//
// A shutdown is a list of stages. The steps of a stage run side by side, a
// stage begins when the one before it is over, and every step has a time
// limit: a step that fails or runs past its limit is reported and the
// shutdown goes on, so nothing here can keep the app from ending.
//
//  1. Nothing new begins, and what runs gets a moment to end: the reload
//     timer, the plugin watchers and the document sync bridge stop; the
//     agent sessions end and their records are saved; each folder's git
//     locks close once the work holding them is done (sync/RepoLocks.ts).
//  2. A command still running — a git that hangs — is stopped. The locks
//     are closed by now, so the tick it belonged to starts no other.
//  3. The Effect runtime is disposed: what still waits on it is
//     interrupted, and its services let go of what they hold.
//  4. The last spans and log lines are flushed.
//
// The limits add up to under the five seconds a hosted worker's gateway
// waits after SIGTERM before it kills the worker (src/gateway/workers.ts).

import { Duration, Effect, Option } from "effect";
import { endAllChatSessions } from "./agentChat";
import { stopBackgroundWork } from "./api";
import { runAlone } from "./effect/bridge";
import { stopCommands } from "./effect/command";
import { dispose, run } from "./effect/runtime";
import { RepoLocks } from "./sync/RepoLocks";
import { getLogger, shutdownTelemetry } from "./telemetry";

export interface Step {
  /** What the log calls it. */
  name: string;
  /** Milliseconds it may take before the shutdown goes on without it. */
  limitMs: number;
  work: () => void | Promise<void>;
}

/** Steps that run side by side. */
export type Stage = readonly Step[];

export interface StepReport {
  name: string;
  ms: number;
  /** "gave up": still running at its limit, and left behind. */
  outcome: "done" | "failed" | "gave up";
  error?: string;
}

export interface ShutdownLimits {
  /** What running work gets to end by itself. */
  graceMs: number;
  /** What a stopped command gets to exit on SIGTERM before SIGKILL. */
  killMs: number;
  disposeMs: number;
  flushMs: number;
}

export const SHUTDOWN_LIMITS: ShutdownLimits = { graceMs: 2000, killMs: 500, disposeMs: 500, flushMs: 1000 };

/** One step, held to its limit; it answers with how it went and never fails. */
function attempt(step: Step): Effect.Effect<StepReport> {
  return Effect.suspend(() => {
    const began = Date.now();
    const report = (outcome: StepReport["outcome"], error?: unknown): StepReport => ({
      name: step.name,
      ms: Date.now() - began,
      outcome,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    });
    return Effect.tryPromise({ try: async () => step.work(), catch: (e) => e }).pipe(
      Effect.timeoutOption(Duration.millis(step.limitMs)),
      Effect.match({
        onSuccess: (ended) => report(Option.isSome(ended) ? "done" : "gave up"),
        onFailure: (e) => report("failed", e),
      }),
    );
  });
}

/** Run the stages in order, each one's steps side by side, and say how every step went. */
export function leave(stages: readonly Stage[]): Effect.Effect<StepReport[]> {
  return Effect.map(
    Effect.forEach(stages, (stage) => Effect.forEach(stage, attempt, { concurrency: "unbounded" })),
    (reports) => reports.flat(),
  );
}

/** The app's own shutdown, as the head of this file tells it. */
export function appStages(limits: ShutdownLimits = SHUTDOWN_LIMITS): Stage[] {
  const log = getLogger("shutdown");
  return [
    [
      { name: "background work", limitMs: limits.graceMs, work: stopBackgroundWork },
      { name: "agent sessions", limitMs: limits.graceMs, work: endAllChatSessions },
      {
        name: "git work",
        // The locks time their own wait and close either way; the step's
        // limit is only there for a runtime that does not answer.
        limitMs: limits.graceMs + 250,
        work: async () => {
          const ended = await run(RepoLocks.use((locks) => locks.close(limits.graceMs)));
          if (!ended) log.warn(`git work was still running after ${limits.graceMs} ms; it is being stopped`);
        },
      },
    ],
    [
      {
        name: "running commands",
        limitMs: limits.killMs + 250,
        work: async () => {
          const stopped = await runAlone(stopCommands(limits.killMs));
          if (stopped > 0) log.warn(`stopped ${stopped} command(s) that were still running`);
        },
      },
    ],
    [{ name: "runtime", limitMs: limits.disposeMs, work: dispose }],
    [{ name: "telemetry", limitMs: limits.flushMs, work: shutdownTelemetry }],
  ];
}

let leaving: Promise<StepReport[]> | null = null;

/**
 * Shut the app down. Asked for again while it runs — a second signal's
 * handler, a second quit — it is the same shutdown. Resolves once every
 * stage is over, and never rejects; the caller ends the process then.
 */
export function shutdown(): Promise<StepReport[]> {
  return (leaving ??= (async () => {
    const log = getLogger("shutdown");
    const began = Date.now();
    const stages = appStages();
    const reports: StepReport[] = [];
    // The flush is the last stage, so what the stages before it took is
    // logged ahead of it and goes out with the rest.
    const flush = stages.pop()!;
    reports.push(...(await runAlone(leave(stages))));
    for (const r of reports) {
      if (r.outcome === "failed") log.warn(`${r.name} did not stop cleanly: ${r.error}`);
      if (r.outcome === "gave up") log.warn(`${r.name} was still stopping after ${r.ms} ms; left behind`);
    }
    log.info(`shut down in ${Date.now() - began} ms`);
    reports.push(...(await runAlone(leave([flush]))));
    return reports;
  })());
}

/** For the signal handlers: a `bun --hot` reload re-runs the entry point, and the handlers must be installed once. */
const SIGNALS = Symbol.for("specdriven.shutdown.signals");

/**
 * End the process in order on SIGINT and SIGTERM (the web server; the
 * desktop app quits through Electron's will-quit instead). `first` runs at
 * once — the entry point stops listening there — then the shutdown, then
 * the process exits with the conventional 128+signal code. A second signal
 * does not wait: it exits there and then.
 */
export function shutdownOnSignals(first: () => void): void {
  const slot = globalThis as Record<symbol, unknown>;
  const installed = slot[SIGNALS] !== undefined;
  // Replaced on a hot reload, so the handlers below act for the code that runs now.
  slot[SIGNALS] = { first, shutdown };
  if (installed) return;
  let asked = false;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      if (asked) process.exit(code);
      asked = true;
      const now = slot[SIGNALS] as { first: () => void; shutdown: () => Promise<unknown> };
      try {
        now.first();
      } catch {
        // The shutdown below matters more than what the entry point wanted first.
      }
      void now.shutdown().finally(() => process.exit(code));
    });
  }
}
