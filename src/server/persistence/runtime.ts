// Where the storage core's Effect programs are run for code that awaits
// Promises. The services are built once, on first use, from PersistenceLive
// — Node's file system underneath, which serves Bun and Electron alike —
// and `run` is the bridge every Promise facade (fsx.ts, automerge/store.ts,
// state.ts, tokenStore.ts, secrets.ts) goes through.
//
// The bridge keeps the facades' contract: a failure rejects with the error
// the function always threw (errors.ts toThrowable), never with an Effect
// wrapper, and a span started here nests under the caller's active span.
//
// Nothing in this folder imports a facade — the facades import this file,
// and a path back would be a load-order cycle (tests/importCycles.test.ts).

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { context as otelContext } from "@opentelemetry/api";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import type { Cause } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SecretStores, TokenStore } from "./Credentials";
import { DocStore } from "./DocStore";
import type { Throwable } from "./errors";
import { HomePaths } from "./HomePaths";
import { Settings } from "./Settings";
import { SpanContext } from "./Tracing";

/**
 * Every service of the storage core, on the file system and home paths
 * `platform` provides — Node's and the process's for the app, a temp
 * directory and fixed paths for a test.
 */
export const persistenceOn = <E, R>(platform: Layer.Layer<FileSystem | HomePaths, E, R>) =>
  Layer.mergeAll(DocStore.layer, Settings.layer, TokenStore.layer, SecretStores.layer).pipe(
    Layer.provideMerge(platform),
  );

/** The storage core as the app runs it: Node's file system, the process's own home. */
export const PersistenceLive = persistenceOn(Layer.mergeAll(NodeFileSystem.layer, HomePaths.layer));

/** What an Effect run through the bridge may depend on. */
export type Persistence = Layer.Success<typeof PersistenceLive>;

let runtime: ManagedRuntime.ManagedRuntime<Persistence, never> | undefined;

function live(): ManagedRuntime.ManagedRuntime<Persistence, never> {
  return (runtime ??= ManagedRuntime.make(PersistenceLive));
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

/** Run a storage program and hand its result, or the error it stands for, to a Promise caller. */
export async function run<A>(effect: Effect.Effect<A, Throwable, Persistence>): Promise<A> {
  const inSpan = Effect.provideService(effect, SpanContext, otelContext.active());
  return settle(await live().runPromiseExit(inSpan));
}

/** `run` for a program that never waits — a registry change, a lookup. */
export function runSync<A>(effect: Effect.Effect<A, Throwable, Persistence>): A {
  return settle(live().runSyncExit(effect));
}
