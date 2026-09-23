// The special folders' client side (specs/app/roadmap.feature.md, specs/app
// /tasks.feature.md, specs/app/engineering-notebook.feature.md): what each
// folder's tab is called and can do, one listing store per folder read from
// `GET /api/<folder>`, and the two settings a page's header reads beside its
// own folder's switch. Module-level state read through useSyncExternalStore,
// like the other modules' stores (src/frontend/testing.ts), so App.tsx holds
// nothing of it — the page editor (PagesPane.tsx) holds the open page.

import { useSyncExternalStore } from "react";
import { ListTodo, Map as MapIcon, NotebookPen, type LucideIcon } from "lucide-react";
import type { PageListing } from "../../server/pages";

/** One special folder's tab: what it is called and what its pages can do. */
export interface PageTab {
  /** The data repo's folder — the tab's id, and its `/api/<folder>` routes. */
  folder: "roadmap" | "tasks" | "notebook";
  /** The tab's label, the breadcrumb above one of its pages, and the palette
      group its pages fall under. */
  title: "Roadmap" | "Tasks" | "Notebook";
  /** What one of its pages is called, in buttons and messages. */
  noun: string;
  /** What the tab says when the folder holds nothing yet. */
  empty: string;
  /** Whether its pages can be ticked off — a task is done or it is not
      (specs/app/tasks.feature.md); a roadmap page is neither. */
  done: boolean;
  /** Whether its pages can be put on the calendar — a task, with an
      estimate of its time (specs/app/tasks.feature.md); a page cannot. */
  calendar?: boolean;
  /**
   * Whether its pages are dated entries, listed newest first and grouped by
   * month, each signed and chipped with its kind — the engineering notebook
   * (specs/app/engineering-notebook.feature.md). The other tabs list their
   * pages by subfolder, in name order.
   */
  dated?: boolean;
  icon: LucideIcon;
  /** The `g` chord that opens the tab on its first page. */
  shortcut: string;
  /** Where the tab sits among the plugins' tabs: first, in this order. */
  order: number;
}

export const ROADMAP_TAB: PageTab = {
  folder: "roadmap",
  title: "Roadmap",
  noun: "page",
  empty: "No roadmap pages yet",
  done: false,
  icon: MapIcon,
  shortcut: "g r",
  order: 10,
};

export const TASKS_TAB: PageTab = {
  folder: "tasks",
  title: "Tasks",
  noun: "task",
  empty: "No tasks yet",
  done: true,
  calendar: true,
  icon: ListTodo,
  shortcut: "g t",
  order: 20,
};

export const NOTEBOOK_TAB: PageTab = {
  folder: "notebook",
  title: "Notebook",
  noun: "entry",
  empty:
    "No entries yet. The notebook is a shared, dated log of what you notice about the way you work and what you decide to do about it.",
  done: false,
  dated: true,
  icon: NotebookPen,
  shortcut: "g n",
  order: 30,
};

/** One folder's listing, as its sidebar tab and palette show it. */
export interface PagesState {
  /** The pages — the notebook's newest first, as the server lists them. */
  pages: PageListing[];
  /** For each superseded notebook entry, the entry that replaced it
      (specs/app/engineering-notebook.feature.md); empty elsewhere. */
  supersededBy: Record<string, PageListing>;
  /** Whether `GET /api/<folder>` has answered since the last reset. */
  loaded: boolean;
}

const EMPTY: PagesState = { pages: [], supersededBy: {}, loaded: false };

export interface PagesStore {
  subscribe(listener: () => void): () => void;
  /** The listing outside React — what a bare `/tasks` resolves its first
      page from, in the same tick `load()` filled the store. */
  state(): PagesState;
  load(): Promise<void>;
  /** Forget everything — another data folder, or the switch went off. */
  reset(): void;
  /**
   * Put a page's fresh listing in place of the stale one — what a save
   * brought back — so the row and the window title follow a heading edit
   * before the next reload. A page the list does not hold is left out: the
   * next load places it.
   */
  upsert(listing: PageListing): void;
}

export function createPagesStore(folder: string): PagesStore {
  let state = EMPTY;
  const listeners = new Set<() => void>();
  const set = (next: PagesState) => {
    state = next;
    for (const l of listeners) l();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    state: () => state,
    async load() {
      const res = await fetch(`/api/${folder}`).catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json().catch(() => ({}))) as {
        pages?: PageListing[];
        supersededBy?: Record<string, PageListing>;
      };
      set({
        pages: Array.isArray(data.pages) ? data.pages : [],
        supersededBy: data.supersededBy ?? {},
        loaded: true,
      });
    },
    reset() {
      set(EMPTY);
    },
    upsert(listing) {
      const i = state.pages.findIndex((p) => p.fileName === listing.fileName);
      if (i === -1 || pageListingMetaEqual(state.pages[i]!, listing)) return;
      const pages = [...state.pages];
      pages[i] = listing;
      set({ ...state, pages });
    },
  };
}

/** A store's listing, re-rendering as it changes. */
export function usePages(store: PagesStore): PagesState {
  return useSyncExternalStore(store.subscribe, store.state, store.state);
}

/**
 * Whether two listings agree on the fields the sidebar and the pane header
 * show. Autosave uses this so a tick that only tidied whitespace does not
 * replace the listing — and so a Done marker the tick did not carry cannot
 * be mistaken for "nothing changed" and left stale on the row.
 */
export function pageListingMetaEqual(a: PageListing, b: PageListing): boolean {
  return (
    a.name === b.name &&
    (a.assigned ?? "") === (b.assigned ?? "") &&
    Boolean(a.done) === Boolean(b.done) &&
    (a.estimate ?? 0) === (b.estimate ?? 0) &&
    // A notebook entry's fields count too: a kind edited in the markdown must
    // not read as "nothing changed" and leave a stale chip on the row
    // (specs/app/engineering-notebook.feature.md).
    (a.author ?? "") === (b.author ?? "") &&
    (a.date ?? "") === (b.date ?? "") &&
    (a.kind ?? "") === (b.kind ?? "") &&
    (a.supersedes?.url ?? "") === (b.supersedes?.url ?? "") &&
    (a.supersedes?.title ?? "") === (b.supersedes?.title ?? "")
  );
}

/** The listing fields of a page response, without its content. */
export function pageListingOf(page: PageListing): PageListing {
  return {
    fileName: page.fileName,
    name: page.name,
    ...(page.assigned ? { assigned: page.assigned } : {}),
    ...(page.estimate ? { estimate: page.estimate } : {}),
    ...(page.done ? { done: true } : {}),
    // A notebook entry's own fields, or the header would show the kind chip
    // of an entry it is not looking at
    // (specs/app/engineering-notebook.feature.md).
    ...(page.author ? { author: page.author } : {}),
    ...(page.date ? { date: page.date } : {}),
    ...(page.kind ? { kind: page.kind } : {}),
    ...(page.supersedes ? { supersedes: page.supersedes } : {}),
  };
}

/** Pages grouped by the subfolder under their own folder, top level first. */
export function pageGroups(pages: PageListing[]): { dir: string; pages: PageListing[] }[] {
  const groups = new Map<string, PageListing[]>();
  for (const page of pages) {
    const dir = page.fileName.split("/").slice(1, -1).join("/");
    const list = groups.get(dir) ?? [];
    list.push(page);
    groups.set(dir, list);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, pages: list }));
}

/** A page row's tooltip: its name, and whatever else the row only hints at. */
export function pageRowTitle(page: PageListing): string {
  const parts = [page.name];
  if (page.done) parts.push("done");
  if (page.assigned) parts.push(`assigned to ${page.assigned}`);
  // A notebook entry is signed and dated rather than assigned
  // (specs/app/engineering-notebook.feature.md).
  if (page.author) parts.push(`by ${page.author}`);
  if (page.date) parts.push(page.date);
  return parts.join(" — ");
}

/**
 * The app settings a page's header reads beside its own folder's switch:
 * the Google Calendar switch behind a task's calendar chip, and whether the
 * `claude` CLI is there to propose an estimate (specs/app/tasks.feature.md
 * "Add task to Google Calendar"). Fed from `GET /api/state` at mount and on
 * every settings change.
 */
export interface PageSettings {
  googleCalendar: boolean;
  canEstimate: boolean;
}

let settings: PageSettings = { googleCalendar: false, canEstimate: false };
const settingsListeners = new Set<() => void>();

export const pageSettings = {
  subscribe(listener: () => void): () => void {
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
    };
  },
  get: (): PageSettings => settings,
  /** Take the switches from a `GET /api/state` payload. */
  apply(state: Record<string, unknown>): void {
    const next = {
      googleCalendar: state.googleCalendar === true,
      canEstimate: state.canRunAgentPane === true,
    };
    if (next.googleCalendar === settings.googleCalendar && next.canEstimate === settings.canEstimate) {
      return;
    }
    settings = next;
    for (const l of settingsListeners) l();
  },
};

export function usePageSettings(): PageSettings {
  return useSyncExternalStore(pageSettings.subscribe, pageSettings.get, pageSettings.get);
}
