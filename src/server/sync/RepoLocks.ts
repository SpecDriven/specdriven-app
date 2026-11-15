// One-at-a-time rules for a folder's git work (specs: git operations).
//
// Three locks per folder, held independently:
//  - the index lock: one piece of work that changes the index or the
//    working tree at a time — add, commit, mv, rm, merge, checkout. Held
//    for local work only, never across the network, so a save's commit
//    waits a moment for another commit, not for a pull that is waiting on
//    the remote;
//  - the remote lock: one conversation with the remote at a time — a fetch
//    or a push. A push waits for the fetch or push before it;
//  - the tick lock: one sync tick at a time — a tick asked for while one
//    runs (the timer, a manual reload, the start-up pull) waits for it.
// A tick takes the other two once per git command inside it, never for the
// whole tick, so a save waits for one git command, not for the tick.
//
// Folders are told apart by their resolved path. Locks are never reentrant:
// nothing holding one of a folder's locks may ask for it again. The index
// lock may be taken while the remote lock is held (the bundled engine's
// pull, git/cli.ts), never the other way round.

import { resolve } from "node:path";
import { Context, Effect, Layer, Semaphore } from "effect";

export interface RepoLocksShape {
  /** Run `effect` while nothing else changes the index or working tree of `dir`. */
  readonly withIndex: <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Run `effect` while nothing else talks to the remote of `dir`. */
  readonly withRemote: <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
  static readonly layer = Layer.sync(this, () => ({
    withIndex: lockPerKey(),
    withRemote: lockPerKey(),
    withTick: lockPerKey(),
  }));
}
