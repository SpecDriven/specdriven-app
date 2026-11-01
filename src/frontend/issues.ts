// The GitHub issues module's client store (specs/app/github-issues.feature
// .md): the list GET /api/issues answers for the chosen state filter, plus
// the issues opened one by one with their comments, kept current by the
// mutations below — each applies what the server (and so GitHub) returns —
// and by the app's reload tick. Module-level state read through
// useSyncExternalStore, like the test management store
// (src/frontend/testing.ts), so App.tsx holds only which view is open.
// The pure helpers at the bottom — titles, keys, palette search — take the
// snapshot as an argument, so they test without a DOM or a server.

import { useSyncExternalStore } from "react";
import type { GitHubRepo, Issue, IssueComment, IssueState } from "../server/issues";
import { toast } from "./Toasts";
import { issuesPath, type IssuesRoute } from "../plugins/builtin/issues/route";

export type { GitHubRepo, Issue, IssueComment, IssueState };

// Demo mode (src/server/demo.ts): the demo reads the app's own public repo's
// issues so its Issues tab has something real to show, but cannot change
// them — a visitor is signed in to nothing, so every write would be an
// anonymous one on someone else's repository. The server refuses them
// (src/server/api.ts withIssues readOnlyInDemo); this flag takes the
// affordances off the screen too, so nothing offers an edit that cannot work.
let readOnly = false;

/** Told by App.tsx once /api/state reports demo mode. */
export function setIssuesReadOnly(on: boolean): void {
  if (readOnly === on) return;
  readOnly = on;
  set({ ...state, readOnly: on });
}

/** One issue opened in the pane: the issue itself and its comments. */
export interface IssueDetail {
  issue: Issue;
  comments: IssueComment[];
}

export interface IssuesStore {
  /** The repository the issues belong to; null until the list has answered. */
  repo: GitHubRepo | null;
  /** The list's state filter — what GET /api/issues was last asked for. */
  filter: IssueState;
  issues: Issue[];
  /** Issues opened in the pane, by number; a list refresh keeps them. */
  details: Record<number, IssueDetail>;
  /** Whether GET /api/issues has answered since the last reset. */
  loaded: boolean;
  /** Whether a list load is under way. */
  loading: boolean;
  error: string | null;
  /** Read-only: the issues show, but nothing offers to change them (demo). */
  readOnly: boolean;
}

export const EMPTY_ISSUES: IssuesStore = {
  repo: null,
  filter: "open",
  issues: [],
  details: {},
  loaded: false,
  loading: false,
  error: null,
  readOnly: false,
};

let state: IssuesStore = EMPTY_ISSUES;
const listeners = new Set<() => void>();
/** Editors with an unsaved draft; a refresh must not overwrite them. */
const dirtyKeys = new Set<string>();

function set(next: IssuesStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useIssues(): IssuesStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** For tests and the odd imperative read. */
export function issuesState(): IssuesStore {
  return state;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Run a mutation; a failure is a toast, and the caller gets null. */
async function attempt<T>(work: () => Promise<T>, failure: string): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    toast.error(`${failure}: ${(e as Error).message}`);
    return null;
  }
}

/** The store with one issue merged into the list (where it fits the filter) and its detail. */
export function applyIssue(store: IssuesStore, issue: Issue): IssuesStore {
  const fits = store.filter === "all" || store.filter === issue.state;
  const rest = store.issues.filter((i) => i.number !== issue.number);
  const issues = fits
    ? [issue, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : rest;
  const detail = store.details[issue.number];
  const details = detail ? { ...store.details, [issue.number]: { ...detail, issue } } : store.details;
  return { ...store, issues, details };
}

/** The store with one comment appended to an opened issue. */
export function applyComment(store: IssuesStore, number: number, comment: IssueComment): IssuesStore {
  const detail = store.details[number];
  if (!detail) return store;
  const issue = { ...detail.issue, comments: detail.issue.comments + 1 };
  return {
    ...store,
    issues: store.issues.map((i) => (i.number === number ? issue : i)),
    details: { ...store.details, [number]: { issue, comments: [...detail.comments, comment] } },
  };
}

export const issues = {
  /** Watch the store outside React — the plugin tab hands this to App. */
  subscribe,
  /** GET /api/issues for a state filter into the store; the pane shows `error` when it fails. */
  async load(filter: IssueState = state.filter): Promise<void> {
    set({ ...state, filter, loading: true });
    try {
      const data = await call<{ repo: GitHubRepo; state: IssueState; issues: Issue[] }>(
        `/api/issues?state=${filter}`,
      );
      // A slower answer for an older filter must not overwrite a newer one.
      if (state.filter !== filter) return;
      set({ ...state, repo: data.repo, issues: data.issues, loaded: true, loading: false, error: null });
    } catch (e) {
      if (state.filter !== filter) return;
      set({ ...state, loaded: true, loading: false, error: (e as Error).message });
    }
  },
  /** The reload tick's refresh: skipped while an editor holds an unsaved draft. */
  async refresh(): Promise<void> {
    if (dirtyKeys.size > 0 || state.loading) return;
    await issues.load();
    const open = Object.keys(state.details).map(Number);
    await Promise.all(open.map((n) => issues.open(n, { quiet: true })));
  },
  /** Forget everything — the data repo changed, or the tab went away.
      Read-only is the mode the app runs in, not data, so it survives. */
  reset(): void {
    dirtyKeys.clear();
    set({ ...EMPTY_ISSUES, readOnly });
  },
  /** Editors report their unsaved state here (see refresh). */
  setDirty(key: string, dirty: boolean): void {
    if (dirty) dirtyKeys.add(key);
    else dirtyKeys.delete(key);
  },

  /** GET one issue with its comments into `details`. */
  async open(number: number, opts: { quiet?: boolean } = {}): Promise<IssueDetail | null> {
    try {
      const detail = await call<IssueDetail>(`/api/issues/${number}`);
      set({ ...state, details: { ...state.details, [number]: detail } });
      return detail;
    } catch (e) {
      if (!opts.quiet) toast.error(`Could not load issue #${number}: ${(e as Error).message}`);
      return null;
    }
  },

  create(input: { title: string; body?: string }) {
    return attempt(async () => {
      const { issue } = await call<{ issue: Issue }>("/api/issues", {
        method: "POST",
        body: JSON.stringify(input),
      });
      set(applyIssue({ ...state, details: { ...state.details, [issue.number]: { issue, comments: [] } } }, issue));
      return issue;
    }, "Could not create the issue");
  },

  update(number: number, input: { title?: string; body?: string; state?: "open" | "closed"; stateReason?: string }) {
    return attempt(async () => {
      const { issue } = await call<{ issue: Issue }>(`/api/issues/${number}`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      set(applyIssue(state, issue));
      return issue;
    }, "Could not update the issue");
  },

  close(number: number, reason: "completed" | "not_planned" = "completed") {
    return issues.update(number, { state: "closed", stateReason: reason });
  },

  reopen(number: number) {
    return issues.update(number, { state: "open" });
  },

  comment(number: number, body: string) {
    return attempt(async () => {
      const { comment } = await call<{ comment: IssueComment }>(`/api/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      set(applyComment(state, number, comment));
      return comment;
    }, "Could not add the comment");
  },
};

// --- Pure helpers -----------------------------------------------------------------------

/** The window title's tail for a view. */
export function issuesTitle(view: IssuesRoute, store: Pick<IssuesStore, "issues" | "details">): string {
  switch (view.kind) {
    case "list":
      return "Issues";
    case "new":
      return "New issue";
    case "issue": {
      const issue = store.details[view.number]?.issue ?? store.issues.find((i) => i.number === view.number);
      return issue ? `#${issue.number} ${issue.title}` : `Issue #${view.number}`;
    }
  }
}

/** The error boundary's key: a view's identity, so a crash resets on navigation. */
export function issuesKey(view: IssuesRoute): string {
  return view.kind === "issue" ? `issues:${view.number}` : `issues:${view.kind}`;
}

export interface IssuesHit {
  number: number;
  label: string;
  sub?: string;
  href: string;
  view: IssuesRoute;
}

/**
 * The palette's search over the loaded issues (specs/search.feature.md):
 * every word of the query must appear in the number, title or body — or
 * the query is the number itself, `#12` or `12`. Matched client-side, since
 * the server's full-text index knows only markdown.
 */
export function searchIssues(query: string, store: Pick<IssuesStore, "issues">, limit = 20): IssuesHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: IssuesHit[] = [];
  for (const issue of store.issues) {
    const hay = `#${issue.number} ${issue.title} ${issue.body}`.toLowerCase();
    if (!words.every((w) => hay.includes(w) || w === String(issue.number))) continue;
    hits.push({
      number: issue.number,
      label: issue.title,
      sub: `#${issue.number} · ${issue.state}`,
      href: issuesPath({ kind: "issue", number: issue.number }),
      view: { kind: "issue", number: issue.number },
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** A label's colours from GitHub's hex, readable on light and dark alike. */
export function labelStyle(color: string): { background: string; color: string; borderColor: string } {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : "9e9e9e";
  return {
    background: `#${hex}26`,
    color: `var(--text-1)`,
    borderColor: `#${hex}80`,
  };
}
