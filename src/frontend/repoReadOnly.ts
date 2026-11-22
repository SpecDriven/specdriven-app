// A spec folder that cannot be pushed to opens read only (git-operations.md
// "a spec folder that cannot be pushed to opens read only", issue #467):
// the folder has no remote, or its remote turned this computer down. The
// server asks the remote (src/server/git/index.ts writeAccessOf) when the
// folder opens — the page waits for that answer at /api/repo-access — and
// again now and then, reported with the feature listing on every tick. It
// is kept here, outside any component, like the push problem
// (syncProblem.ts), so the sidebar, the editors and the plugin tabs read one
// answer.

import { useSyncExternalStore } from "react";

export type RepoReadOnly =
  | { kind: "no-remote" }
  | { kind: "denied"; remote: string; reason: string };

let current: RepoReadOnly | null = null;
const listeners = new Set<() => void>();

/** What the server's answer says, or null for anything that is not a reason to stop editing. */
export function parseRepoReadOnly(data: unknown): RepoReadOnly | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.kind === "no-remote") return { kind: "no-remote" };
  if (d.kind === "denied") {
    return {
      kind: "denied",
      remote: typeof d.remote === "string" ? d.remote : "",
      reason: typeof d.reason === "string" ? d.reason : "",
    };
  }
  return null;
}

function same(a: RepoReadOnly | null, b: RepoReadOnly | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Record what the server last said; null once the folder may be edited. */
export function setRepoReadOnly(next: RepoReadOnly | null): void {
  if (same(next, current)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function currentRepoReadOnly(): RepoReadOnly | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Why the open folder is read only, re-rendering the caller when it changes. */
export function useRepoReadOnly(): RepoReadOnly | null {
  return useSyncExternalStore(subscribe, currentRepoReadOnly, currentRepoReadOnly);
}

/** Whether what git said is a credential problem, fixed in Settings → Git access. */
export function fixedInSettings(why: RepoReadOnly): boolean {
  return why.kind === "denied" && /authentication required|sign in with GitHub|personal access token|gh auth login/i.test(why.reason);
}

/** The remote as people read it: `owner/repo` on its host, without the scheme or `.git`. */
export function remoteLabel(remote: string): string {
  const scp = remote.match(/^[^@/]+@([^:/]+):(.+)$/);
  const text = scp ? `${scp[1]}/${scp[2]}` : remote.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?/i, "");
  return text.replace(/\.git\/?$/, "").replace(/\/+$/, "") || remote;
}

/** One line for the sidebar chip's tooltip. */
export function readOnlySummary(why: RepoReadOnly): string {
  return why.kind === "no-remote"
    ? "Read only — this folder's git repository has no remote, so changes made here would reach no one"
    : `Read only — you cannot push to ${remoteLabel(why.remote) || "its remote"}`;
}
