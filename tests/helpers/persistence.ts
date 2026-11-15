// The storage core's services (src/server/persistence) for a test: Node's
// file system and fixed home paths, so nothing reads the process's
// environment. Each run builds the services afresh.

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { Effect, Exit, Layer, Option } from "effect";
import { HomePaths } from "../../src/server/persistence/HomePaths";
import { persistenceOn, type Persistence } from "../../src/server/persistence/runtime";

export interface TestHome {
  /** Stands in for ~/.specdriven. */
  appHome: string;
  /** Stands in for the user's home directory; the app home when left out. */
  userHome?: string;
  /** The desktop app's rule: the home settings file is the only one. */
  homeSettingsOnly?: boolean;
}

/** Run a storage program on fresh services and return how it ended. */
export function exitOf<A, E>(effect: Effect.Effect<A, E, Persistence>, home: TestHome): Promise<Exit.Exit<A, E>> {
  const layer = persistenceOn(Layer.mergeAll(NodeFileSystem.layer, HomePaths.fixed(home)));
  return Effect.runPromiseExit(Effect.provide(effect, layer));
}

/** The value a run succeeded with; a failed run fails the test with its cause. */
export function valueOf<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`expected success, got ${String(exit.cause)}`);
}

/** The typed error a run failed with, or null when it succeeded or died. */
export function errorOf<A, E>(exit: Exit.Exit<A, E>): E | null {
  return Exit.isFailure(exit) ? Option.getOrNull(Exit.findErrorOption(exit)) : null;
}
