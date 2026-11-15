// The app's one Effect runtime, and the bridge Promise code goes through to
// use it. Built once, on first use, from every service the server runs on
// Effect: the storage core (src/server/persistence) and the sync services
// (src/server/sync — commands with a time limit, per-folder git locks).
//
// The bridge keeps the Promise functions' contract: a failure rejects with
// the error the function always threw (persistence/errors.ts toThrowable),
// a defect with the thrown value itself, never with an Effect wrapper; and
// the caller's active span travels into the program (Tracing.ts), so spans
// started inside nest under it.
//
// Nothing here imports a Promise facade (fsx.ts, state.ts, run.ts, git/, …):
// they import this file (tests/importCycles.test.ts).

import { context as otelContext, ROOT_CONTEXT } from "@opentelemetry/api";
import { Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";
import type { Cause } from "effect";
import type { Throwable } from "../persistence/errors";
import { PersistenceLive } from "../persistence/layer";
import { SpanContext } from "../persistence/Tracing";
import { Commands } from "../sync/Commands";
import { RepoLocks } from "../sync/RepoLocks";

/** Every service of the app runtime, as the app runs them. */
export const AppLive = Layer.mergeAll(PersistenceLive, Commands.layer, RepoLocks.layer);

/** What a program run through the bridge may depend on. */
export type App = Layer.Success<typeof AppLive>;

let runtime: ManagedRuntime.ManagedRuntime<App, never> | undefined;

function live(): ManagedRuntime.ManagedRuntime<App, never> {
  return (runtime ??= ManagedRuntime.make(AppLive));
}

/** What a failed run throws to a Promise caller: the first failure, else the first defect. */
function thrown(cause: Cause.Cause<Throwable>): unknown {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return reason.error.toThrowable();
  }
  for (const reason of cause.reasons) {
    if (reason._tag === "Die") return reason.defect;
  }
  return new Error("The operation was interrupted");
}

function settle<A>(exit: Exit.Exit<A, Throwable>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw thrown(exit.cause);
}

/** Seed the program with the caller's active span. */
const inCallerSpan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, SpanContext, otelContext.active());

/** Run a program and hand its result, or the error it stands for, to a Promise caller. */
export async function run<A>(effect: Effect.Effect<A, Throwable, App>): Promise<A> {
  return settle(await live().runPromiseExit(inCallerSpan(effect)));
}

/** `run` for a program that never waits — a registry change, a lookup. */
export function runSync<A>(effect: Effect.Effect<A, Throwable, App>): A {
  return settle(live().runSyncExit(effect));
}

/**
 * Start a program that runs on its own — a loop — and hand back its fiber.
 * It outlives whatever started it, so its spans are roots of their own, not
 * children of the request that happened to start it.
 */
export function fork<A>(effect: Effect.Effect<A, never, App>): Fiber.Fiber<A, never> {
  return live().runFork(Effect.provideService(effect, SpanContext, ROOT_CONTEXT));
}

/** Interrupt a fiber `fork` started, without waiting for it to end. */
export function interrupt(fiber: Fiber.Fiber<unknown, unknown>): void {
  Effect.runFork(Fiber.interrupt(fiber));
}

/**
 * A Promise function as an Effect, called with the program's span active.
 * A fiber that waited — for a lock, say — may be resumed from another
 * fiber's async context, so the span is put back explicitly: telemetry.ts
 * withSpan and the loggers inside `thunk` then see the caller's span. A
 * rejection is a defect, which the bridge rethrows as it was thrown.
 */
export const promised = <A>(thunk: () => Promise<A>): Effect.Effect<A> =>
  Effect.flatMap(Effect.service(SpanContext), (span) => Effect.promise(() => otelContext.with(span, thunk)));
