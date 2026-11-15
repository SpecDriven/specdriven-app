// One-at-a-time rules for a folder's git work (specs: git operations).
//
// Two locks per folder, held independently:
//  - the repo lock: one git operation that commits or talks to the remote
//    at a time — a save's commit waits for a tick's pull instead of racing
//    it for the index;
//  - the tick lock: one sync tick at a time — a tick asked for while one
//    runs (the timer, a manual reload, the start-up pull) waits for it and
//    then runs.
// A tick takes the repo lock once per git operation inside it, never for
// the whole tick, so a save waits for one git command, not for the tick.
//
// Folders are told apart by their resolved path. Locks are never reentrant:
// nothing holding a folder's repo lock may ask for it again.

import { resolve } from "node:path";
import { Context, Effect, Layer, Semaphore } from "effect";

export interface RepoLocksShape {
  /** Run `effect` while no other committing or remote git operation runs on `dir`. */
  readonly withRepo: <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Run a sync tick for `dir` while no other tick for it runs. */
  readonly withTick: <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A lock per key, made on first use. */
function lockPerKey() {
  const locks = new Map<string, Semaphore.Semaphore>();
  return <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const key = resolve(dir);
      let lock = locks.get(key);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      return Semaphore.withPermit(lock, effect);
    });
}

export class RepoLocks extends Context.Service<RepoLocks, RepoLocksShape>()("specdriven/sync/RepoLocks") {
  static readonly layer = Layer.sync(this, () => ({ withRepo: lockPerKey(), withTick: lockPerKey() }));
}
