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
//
// The locks are also how the app leaves a folder's git work in order when
// it shuts down (src/server/shutdown.ts): `close` lets no new tick begin
// and waits for the running ones, then does the same for the index and the
// remote. Work asked for after that fails with ShuttingDown, so a tick cut
// short ends at its next git command instead of starting it.

import { resolve } from "node:path";
import { Context, Data, Duration, Effect, Layer, Option, Semaphore } from "effect";
import type { Throwable } from "../effect/bridge";

/** Git work was asked for on a folder after the app began to shut down. */
export class ShuttingDown extends Data.TaggedError("ShuttingDown")<{}> implements Throwable {
  override get message(): string {
    return "SpecDriven is shutting down";
  }

  toThrowable(): unknown {
    return new Error(this.message);
  }
}

/** Runs `effect` while it alone holds the folder's lock; fails with ShuttingDown once the locks are closed. */
type WithLock = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ShuttingDown, R>;

export interface RepoLocksShape {
  /** Run `effect` while nothing else changes the index or working tree of `dir`. */
  readonly withIndex: WithLock;
  /** Run `effect` while nothing else talks to the remote of `dir`. */
  readonly withRemote: WithLock;
  /** Run a sync tick for `dir` while no other tick for it runs. */
  readonly withTick: WithLock;
  /**
   * Shutdown: let no more git work begin on any folder, and wait up to
   * `waitMs` for the work that runs to end — the ticks first, which may
   * still take the other two locks to finish, then the index and the
   * remote. Answers whether everything ended in time; either way the locks
   * are closed for good when this completes.
   */
  readonly close: (waitMs: number) => Effect.Effect<boolean>;
}

/** A lock per key, made on first use, that can be closed. */
function lockPerKey() {
  const locks = new Map<string, Semaphore.Semaphore>();
  let closed = false;
  const stillOpen = Effect.suspend(() => (closed ? Effect.fail(new ShuttingDown()) : Effect.void));
  const withLock: WithLock = (dir, effect) =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(new ShuttingDown());
      const key = resolve(dir);
      let lock = locks.get(key);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      // Asked again once the lock is had: work that waited while the locks
      // were closed does not begin.
      return Semaphore.withPermit(lock, Effect.andThen(stillOpen, effect));
    });
  return {
    withLock,
    /** Let nothing more begin. */
    shut: () => {
      closed = true;
    },
    /** Wait for the work holding a lock to end, and keep every lock. */
    idle: Effect.suspend(() =>
      Effect.forEach([...locks.values()], (lock) => Semaphore.take(lock, 1), { concurrency: "unbounded", discard: true }),
    ),
  };
}

export class RepoLocks extends Context.Service<RepoLocks, RepoLocksShape>()("specdriven/sync/RepoLocks") {
  static readonly layer = Layer.sync(this, () => {
    const index = lockPerKey();
    const remote = lockPerKey();
    const ticks = lockPerKey();
    const shutAll = Effect.sync(() => {
      ticks.shut();
      index.shut();
      remote.shut();
    });
    const settle = Effect.gen(function* () {
      ticks.shut();
      yield* ticks.idle;
      index.shut();
      remote.shut();
      yield* Effect.all([index.idle, remote.idle], { concurrency: "unbounded", discard: true });
    });
    return {
      withIndex: index.withLock,
      withRemote: remote.withLock,
      withTick: ticks.withLock,
      close: (waitMs) =>
        settle.pipe(Effect.timeoutOption(Duration.millis(waitMs)), Effect.map(Option.isSome), Effect.ensuring(shutAll)),
    };
  });
}
