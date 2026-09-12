// Which git engines a push/pull test runs on.
//
// Every engine-parameterised test costs a full fixture plus a real
// commit/push, so running all three triples the slowest tests in the suite
// for coverage that only changes when src/server/git/{cli,gh,js}.ts change.
// Locally one engine is enough to catch a broken flow; CI sets
// SPECDRIVEN_ALL_ENGINES=1 so every push still proves all three work.
//
// The default is pinned rather than left to currentEngine(), which picks from
// what happens to be installed — the matrix must not vary by machine.

import type { GitEngine } from "../../src/server/git";

const ALL: GitEngine[] = ["cli", "gh", "js"];

/** The default single engine: plain system git, which the other two build on. */
const DEFAULT: GitEngine = "cli";

/** True when the full matrix was asked for (CI, or a git-engine change). */
export function allEngines(): boolean {
  return process.env.SPECDRIVEN_ALL_ENGINES === "1";
}

/**
 * The engines to parameterise over: all three under SPECDRIVEN_ALL_ENGINES=1,
 * otherwise just the default one.
 */
export function gitEngines(): GitEngine[] {
  return allEngines() ? ALL : [DEFAULT];
}
