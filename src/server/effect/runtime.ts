// The app's one Effect runtime, and the way Promise code uses it. Built
// once, on first use, from every service the server runs on Effect: the
// storage core (src/server/persistence) and the per-folder git locks
// (src/server/sync/RepoLocks.ts). This is where the services are put
// together, so it is the one file here that names them.
//
// A program's ending reaches the Promise caller through bridge.ts, and the
// caller's active span travels into the program (Tracing.ts), so spans
// started inside nest under it.
//
// Nothing here imports a Promise facade (fsx.ts, state.ts, run.ts, git/, …):
// they import this file (tests/importCycles.test.ts).

import { context as otelContext, ROOT_CONTEXT } from "@opentelemetry/api";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { PersistenceLive } from "../persistence/layer";
import { RepoLocks } from "../sync/RepoLocks";
import { settle, type Throwable } from "./bridge";
import { SpanContext } from "./Tracing";

/** Every service of the app runtime, as the app runs them. */
export const AppLive = Layer.mergeAll(PersistenceLive, RepoLocks.layer);

/** What a program run through the bridge may depend on. */
export type App = Layer.Success<typeof AppLive>;

let runtime: ManagedRuntime.ManagedRuntime<App, never> | undefined;

function live(): ManagedRuntime.ManagedRuntime<App, never> {
  return (runtime ??= ManagedRuntime.make(AppLive));
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
