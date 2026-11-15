// The repeating sync tick as one fiber: wait the interval, run the tick,
// wait again. A tick runs to its end once begun — interrupting the loop
// (a changed frequency, a stop) ends it after the running tick, never in
// the middle of a commit — and the loops of one scheduler share a permit,
// so a loop started while an interrupted one finishes its tick waits for it
// instead of starting a second tick beside it. A tick that fails or dies is
// the tick's business (it logs); the loop goes on.

import { Effect, Semaphore } from "effect";

/**
 * Wait `ms` on a timer that does not keep the process alive, as the
 * interval this loop replaced did not: a script or test that set the
 * reload frequency still exits when its work is done.
 */
const nap = (ms: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms);
    timer.unref?.();
    return Effect.sync(() => clearTimeout(timer));
  });

export function tickEvery<R>(
  ms: number,
  tick: Effect.Effect<void, unknown, R>,
  oneAtATime: Semaphore.Semaphore,
): Effect.Effect<never, never, R> {
  const once = Semaphore.withPermit(oneAtATime, Effect.uninterruptible(Effect.asVoid(Effect.exit(tick))));
  return Effect.forever(Effect.andThen(nap(ms), once));
}
