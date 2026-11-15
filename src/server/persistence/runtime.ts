// Where the storage core's Effect programs are run for code that awaits
// Promises. The services are built once, on first use, as part of the app
// runtime (src/server/effect/runtime.ts) — Node's file system underneath,
// which serves Bun and Electron alike — and `run` is the bridge every
// Promise facade (fsx.ts, automerge/store.ts, state.ts, tokenStore.ts,
// secrets.ts) goes through.
//
// The bridge keeps the facades' contract: a failure rejects with the error
// the function always threw (errors.ts toThrowable), never with an Effect
// wrapper, and a span started here nests under the caller's active span.
//
// Nothing in this folder imports a facade — the facades import this file,
// and a path back would be a load-order cycle (tests/importCycles.test.ts).

export { run, runSync } from "../effect/runtime";
export { persistenceOn, PersistenceLive, type Persistence } from "./layer";
