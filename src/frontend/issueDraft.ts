import { useSyncExternalStore } from "react";
import type { GitHubRepo } from "../server/issues";

// The new-issue draft (specs/app/github-issues.feature.md "A new issue is
// kept as a draft until it is created"): what the user types into the New
// issue form is saved as they type, one draft per repository, so a create
// GitHub refuses — a lapsed sign-in, the network gone, a rate limit — or a
// slip off the form loses nothing. Opening the form again brings the draft
// back; only a successful create (or Discard) clears it.
//
// Like the other per-person habits (src/frontend/spellCheckPref.ts) it lives
// on this device, in localStorage: an unsent issue belongs to the person at
// the keyboard, not to the project, and must survive a reload or an app
// restart without touching the data repo.

export interface IssueDraft {
  title: string;
  body: string;
  /** ISO time of the last save. */
  savedAt: string;
}

/** The storage the drafts live in — localStorage, or a stand-in in tests. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "sd-issue-draft:";
/** Fired on window when a draft changes, so the list's notice follows. */
const EVENT = "sd-issue-draft-change";

/** One key per repository, host included: an Enterprise repo of the same name is another repo. */
export function draftKey(repo: Pick<GitHubRepo, "host" | "owner" | "name">): string {
  return `${PREFIX}${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
}

function storage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage unavailable (private mode): no drafts, the form still works.
    return null;
  }
}

/** The repository's draft, or null when there is none (or it is unreadable). */
export function readIssueDraft(
  repo: Pick<GitHubRepo, "host" | "owner" | "name"> | null,
  store: DraftStorage | null = storage(),
): IssueDraft | null {
  if (!repo || !store) return null;
  try {
    const raw = store.getItem(draftKey(repo));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<IssueDraft>;
    const title = typeof value.title === "string" ? value.title : "";
    const body = typeof value.body === "string" ? value.body : "";
    if (!title.trim() && !body.trim()) return null;
    return { title, body, savedAt: typeof value.savedAt === "string" ? value.savedAt : "" };
  } catch {
    return null;
  }
}

/** Save what the form holds; a blank form is no draft, so it clears the saved one. */
export function saveIssueDraft(
  repo: Pick<GitHubRepo, "host" | "owner" | "name"> | null,
  draft: { title: string; body: string },
  store: DraftStorage | null = storage(),
  now: Date = new Date(),
): void {
  if (!repo || !store) return;
  try {
    if (!draft.title.trim() && !draft.body.trim()) store.removeItem(draftKey(repo));
    else store.setItem(draftKey(repo), JSON.stringify({ title: draft.title, body: draft.body, savedAt: now.toISOString() }));
  } catch {
    // Quota or private mode: the draft just won't outlive the form.
  }
  changed();
}

/** Forget the repository's draft — the issue was created, or the user discarded it. */
export function clearIssueDraft(
  repo: Pick<GitHubRepo, "host" | "owner" | "name"> | null,
  store: DraftStorage | null = storage(),
): void {
  if (!repo || !store) return;
  try {
    store.removeItem(draftKey(repo));
  } catch {
    // Nothing to do.
  }
  changed();
}

// --- Watching ----------------------------------------------------------------------------

let version = 0;
function changed(): void {
  version++;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  // Another window of the app saving a draft for the same repo shows up too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) {
      version++;
      listener();
    }
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The repository's draft, kept current as it is saved, created or discarded. */
export function useIssueDraft(repo: GitHubRepo | null): IssueDraft | null {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  // Re-read on every change; parsing one small JSON value is cheap.
  void v;
  return readIssueDraft(repo);
}
