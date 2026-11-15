// How an Effect program's ending reaches code that awaits a Promise. The
// Promise functions keep their contract: a failure rejects with the error
// the function always threw (toThrowable), a defect with the thrown value
// itself, never with an Effect wrapper.
//
// No service and no layer is named here, so a facade that needs none of
// them — run.ts — goes through this file alone and does not bring the app
// runtime (runtime.ts) and the storage core with it.

import { Effect, Exit } from "effect";
import type { Cause } from "effect";

/** What a typed failure hands to code that awaits a Promise. */
export interface Throwable {
  toThrowable(): unknown;
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

/** A run's result, or the error it stands for, thrown. */
export function settle<A>(exit: Exit.Exit<A, Throwable>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw thrown(exit.cause);
}

/** Run a program that depends on no service and hand its result to a Promise caller. */
export async function runAlone<A>(effect: Effect.Effect<A, Throwable>): Promise<A> {
  return settle(await Effect.runPromiseExit(effect));
}
