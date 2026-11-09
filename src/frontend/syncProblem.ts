// Why saved changes are not reaching the remote, while they are not
// (git-operations.md "a push that fails is shown, and tried again"). The
// server reports it with the feature listing, which every reload tick reads;
// it is kept here, outside any component, so the Sync button, the toast and
// each editor's autosave hint — in the core and in the plugin tabs alike —
// read one answer without it being handed down to all of them.

import { useSyncExternalStore } from "react";

let problem: string | null = null;
const listeners = new Set<() => void>();

/** Record what the server last reported; null once pushes go through again. */
export function setSyncProblem(next: string | null): void {
  if (next === problem) return;
  problem = next;
  for (const listener of listeners) listener();
}

export function currentSyncProblem(): string | null {
  return problem;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The push problem, re-rendering the caller when it changes. */
export function useSyncProblem(): string | null {
  return useSyncExternalStore(subscribe, currentSyncProblem, currentSyncProblem);
}

/** What the Sync button and the toast say about a failing push. */
export function syncProblemMessage(reason: string): string {
  return `Saved changes are not being pushed: ${reason}`;
}

/**
 * How an autosave hint ends: with the promise that the next sync pushes the
 * edit, or — while pushes fail — without it. An editor must not say an edit
 * is on its way to the remote when the app knows it is not.
 */
export function pushHint(reason: string | null): string {
  return reason === null
    ? "the next sync pushes it."
    : "saved on this computer only — the push is failing.";
}
