// The special folders' client side (specs/app/roadmap.feature.md, specs/app
// /tasks.feature.md, specs/app/engineering-notebook.feature.md): what each
// folder's tab is called and can do, one listing store per folder read from
// `GET /api/<folder>`, and the two settings a page's header reads beside its
// own folder's switch. Module-level state read through useSyncExternalStore,
// like the other modules' stores (src/frontend/testing.ts), so App.tsx holds
// nothing of it — the page editor (PagesPane.tsx) holds the open page.

import { useSyncExternalStore } from "react";
import { ListTodo, Map as MapIcon, NotebookPen, type LucideIcon } from "lucide-react";
import { PROJECT_PAGE, isProjectPage } from "../../server/pageFolders";
import type { PageListing, ProjectListing } from "../../server/pages";

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
  /**
   * Whether its pages keep an order of their own, dragged into place, and
   * its subfolders a ⋯ menu like the Specs tree's folders — the tasks
   * (specs/app/tasks.feature.md "Reorder tasks by dragging", "Task folder
   * menu") and the roadmap's pages (specs/app/roadmap.feature.md "Reorder
   * roadmap pages"). The server keeps the order (src/server/pageOrder.ts).
   */
  ordered?: boolean;
  /**
   * Whether its subfolders are projects (specs/app/tasks.feature.md
   * "Projects group tasks"): each one headed by its name and owner, opening
   * its own page — the tasks only. Elsewhere a subfolder is just a folder.
   */
  projects?: boolean;
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
  ordered: true,
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
  ordered: true,
  projects: true,
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
  /** An ordered tab's subfolders, repo-relative — empty ones included, so a
      folder just made has a row before a page lands in it. */
  folders: string[];
  /** The tasks' projects — their subfolders — each with its name and owner. */
  projects: ProjectListing[];
  /** Whether `GET /api/<folder>` has answered since the last reset. */
  loaded: boolean;
}

const EMPTY: PagesState = { pages: [], supersededBy: {}, folders: [], projects: [], loaded: false };

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
        folders?: string[];
        projects?: ProjectListing[];
      };
      set({
        pages: Array.isArray(data.pages) ? data.pages : [],
        supersededBy: data.supersededBy ?? {},
        folders: Array.isArray(data.folders) ? data.folders : [],
        projects: Array.isArray(data.projects) ? data.projects : [],
        loaded: true,
      });
    },
    reset() {
      set(EMPTY);
    },
    upsert(listing) {
      // A project's page names its project: the header follows its heading
      // and its owner, as a task's row follows its own.
      const j = state.projects.findIndex((p) => p.fileName === listing.fileName);
      if (j !== -1) {
        const was = state.projects[j]!;
        if (was.name === listing.name && (was.assigned ?? "") === (listing.assigned ?? "")) return;
        const { assigned: _was, ...rest } = was;
        const projects = [...state.projects];
        projects[j] = { ...rest, name: listing.name, ...(listing.assigned ? { assigned: listing.assigned } : {}) };
        set({ ...state, projects });
        return;
      }
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

/**
 * Pages grouped by the subfolder under their own folder, top level first,
 * each group in the order the server listed it. `folders` — repo-relative,
 * as an ordered tab's listing names them — adds a group for each subfolder
 * that holds no page yet.
 */
export function pageGroups(
  pages: PageListing[],
  folders: string[] = [],
): { dir: string; pages: PageListing[] }[] {
  const groups = new Map<string, PageListing[]>();
  for (const folder of folders) {
    const dir = folder.split("/").slice(1).join("/");
    if (dir) groups.set(dir, []);
  }
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

/**
 * Whether a file is a project's own page rather than one of the tab's pages
 * (specs/app/tasks.feature.md "Projects group tasks") — the header it gets
 * is the project's: no Done button, no calendar chip.
 */
export function isProjectPageOf(tab: PageTab, fileName: string): boolean {
  return Boolean(tab.projects) && isProjectPage({ folder: tab.folder, label: tab.noun, projects: true }, fileName);
}

/** A project's page, in its folder: `tasks/launch` -> `tasks/launch/project.md`. */
export function projectPageOf(folder: string): string {
  return `${folder}/${PROJECT_PAGE}`;
}

/** The repo-relative folder a page is in: `tasks/sub/a.md` -> `tasks/sub`. */
export function pageFolderOf(fileName: string): string {
  return fileName.slice(0, fileName.lastIndexOf("/"));
}

/**
 * Where a page dropped on a row of a group lands, as `POST
 * /api/<folder>/:file/move` takes it (specs/app/tasks.feature.md "Reorder
 * tasks by dragging"): the page it goes before, or null for after the
 * group's last. Undefined when the drop would leave it where it is.
 */
export function dropPlacement(
  group: PageListing[],
  dragged: string,
  target: string,
  after: boolean,
): string | null | undefined {
  if (dragged === target) return undefined;
  const others = group.map((p) => p.fileName).filter((f) => f !== dragged);
  const at = others.indexOf(target);
  if (at === -1) return undefined;
  const before = others[after ? at + 1 : at] ?? null;
  const from = group.findIndex((p) => p.fileName === dragged);
  if (from !== -1 && (group[from + 1]?.fileName ?? null) === before) return undefined;
  return before;
}

/**
 * Move up / Move down from a task's ⋯ menu: the page it then goes before
 * (null: last), or undefined at the top or the bottom of its group already.
 */
export function stepPlacement(
  group: PageListing[],
  fileName: string,
  step: -1 | 1,
): string | null | undefined {
  const at = group.findIndex((p) => p.fileName === fileName);
  if (at === -1) return undefined;
  if (step === -1) return at === 0 ? undefined : group[at - 1]!.fileName;
  if (at === group.length - 1) return undefined;
  return group[at + 2]?.fileName ?? null;
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
 * the Google Calendar switch behind a task's calendar chip, and whether an
 * agent is there to propose an estimate — one that answers a single no-tools
 * turn, src/server/estimate.ts (specs/app/tasks.feature.md "Add task to
 * Google Calendar"). Fed from `GET /api/state` at mount and on
 * every settings change.
 */
export interface PageSettings {
  googleCalendar: boolean;
  canEstimate: boolean;
  /** The read-only site (src/server/readOnlyMode.ts): pages are shown, never edited. */
  readOnly: boolean;
}

let settings: PageSettings = { googleCalendar: false, canEstimate: false, readOnly: false };
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
      canEstimate: state.canEstimate === true,
      readOnly: state.readOnly === true,
    };
    if (
      next.googleCalendar === settings.googleCalendar &&
      next.canEstimate === settings.canEstimate &&
      next.readOnly === settings.readOnly
    ) {
      return;
    }
    settings = next;
    for (const l of settingsListeners) l();
  },
};

export function usePageSettings(): PageSettings {
  return useSyncExternalStore(pageSettings.subscribe, pageSettings.get, pageSettings.get);
}
