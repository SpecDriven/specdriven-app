// Per-request identity (specs/app/spec-proposals.feature.md). Everywhere else
// the app works as one identity — the GitHub sign-in it holds (auth.ts
// getAuth), which authors its commits and signs its edits
// (specs/app/specs-authorship.feature.md). The proposals service serves many
// visitors from one process, so a proposal runs inside actAs(): for the
// length of that call, and every await under it, getAuth answers the record
// given here instead of the stored one — the bot's token as the credential,
// the visitor's login, name and noreply email as the identity. Nothing is
// stored, and a request without actAs sees the process-wide sign-in as before.

import { AsyncLocalStorage } from "node:async_hooks";
import type { TokenRecord } from "./tokenStore";

const store = new AsyncLocalStorage<TokenRecord>();

/** Run fn with getAuth answering `record`. */
export function actAs<T>(record: TokenRecord, fn: () => Promise<T>): Promise<T> {
  return store.run(record, fn);
}

/** The identity actAs set for the current call, or undefined outside one. */
export function actingAs(): TokenRecord | undefined {
  return store.getStore();
}
