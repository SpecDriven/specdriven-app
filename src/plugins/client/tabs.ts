// The browser half's extension point for a module tab (roadmap/plugin-
// architecture.md "Extension points"): what a plugin registers to own a
// sidebar tab and the main pane, and what App.tsx renders from. App keeps
// one generic "which plugin view is open" state; everything module-specific
// — the urls, the sidebar, the pane, the shortcut, the palette entries, the
// store's lifecycle — comes from the registered tab.

import type { ComponentType, ReactNode } from "react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import type { Disposer } from "../kernel";
import type { Crumb } from "../../frontend/Breadcrumbs";
import type { ConfirmOptions, PickOptions, PromptOptions, PromptResult } from "../../frontend/ModalPrompts";
import type { PaletteGroup, PaletteItem } from "../../frontend/CommandPalette";
import type { FeatureListing } from "../../server/features";
import type { ProjectMember } from "../../server/members";

export type Prompt = (opts: PromptOptions) => Promise<string | null>;
export type Confirm = (opts: ConfirmOptions) => Promise<boolean>;
/** A prompt with a radio group: the text together with the picked value. */
export type PromptWithChoice = (opts: PromptOptions) => Promise<PromptResult | null>;
/** A choice from a filtered list — the folder a task moves to, say. */
export type Pick = (opts: PickOptions) => Promise<string | null>;

/** What App hands a tab's components: the shared state and dialogs. */
export interface TabApp {
  features: FeatureListing[];
  members: ProjectMember[];
  /** The Assignments setting: whether the module shows "Assigned" chips. */
  assignments: boolean;
  repoCrumb: Crumb;
  autosaveSeconds: number;
  prompt: Prompt;
  promptWithChoice: PromptWithChoice;
  confirm: Confirm;
  pick: Pick;
  /** Opens the Settings page — where the GitHub sign-in lives, say. */
  openSettings: () => void;
  /** Open a feature page, pushing its url. */
  openFeature: (fileName: string) => void;
  /** A feature the module just wrote: re-read the listing, then open it. */
  featureCreated: (fileName: string) => Promise<void>;
  /** Open the code gen session dialog; absent while code gen is off. */
  startSession?: () => void;
  /** Copy an app url (a path) as a shareable link. */
  copyLink: (path: string) => void;
  /** The path last copied, for a "Copied" tick. */
  copied: string | null;
  /** Leave the pane for home — the open view's thing is gone. */
  goHome: () => void;
  /** The read-only site (src/server/readOnlyMode.ts): nothing is created, renamed or deleted. */
  readOnly: boolean;
}

/** Open one of the tab's views; `push` adds a history entry. */
export type Navigate<V> = (view: V, opts?: { push?: boolean }) => void;

/** How a view is being opened. */
export interface OpenViewOptions {
  /** Add a history entry for it. */
  push?: boolean;
  /**
   * Opened from a link, after the folder was pulled for it: why the pull
   * failed, or null — a miss is then said as what it is
   * (specs/ui/navigation.feature.md "a link opens on synced data").
   */
  pullProblem?: string | null;
}

/** A palette hit from the tab's own search — the store, not the server index. */
export interface PaletteHit<V> {
  id: string;
  label: string;
  sub?: ReactNode;
  href?: string;
  view: V;
  /** The hit's own group, over the tab's — Specs' scenarios beside its features. */
  group?: PaletteGroup;
  /** The hit's own icon, over the tab's — a scenario's status, say. */
  icon?: ReactNode;
  /** What alt-Enter opens instead — a scenario's card on its feature's page. */
  altView?: V;
}

/** How the palette's Recent list shows a view that was open. */
export interface RecentItem<V> {
  label: string;
  /** Absent, none — not even the tab's title. */
  sub?: ReactNode;
  icon?: ReactNode;
  /** What alt-Enter opens instead. */
  altView?: V;
}

/** A key, or a palette command, of a tab's own. */
export interface TabShortcut {
  id: string;
  keys: string | string[];
  label: string;
  run(): void;
  /** The cheat sheet's section; "Navigate" when absent. */
  group?: string;
  /** Only while this holds — Specs' imports while their switch is on, say. */
  when?(): boolean;
  /** Fires while typing in a field; absent is yes. */
  inFields?: boolean;
  /** Turns the sidebar to the tab first; absent is yes. */
  reveal?: boolean;
  /** The palette row's icon; a search glass when absent. */
  icon?: ReactNode;
}

export interface TabPlugin<V = unknown> {
  /** The tab's id: the sidebar tab, the `go-<id>` shortcut, the palette scope. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** Where the tab sits after the core tabs; lower first. */
  order: number;
  /** The `g` chord that opens the tab, `g e` say. */
  shortcut?: string;
  route: {
    /** The view a url names, or null when the url is not the tab's. */
    match(pathname: string): V | null;
    /** The url of a view — the inverse of match. */
    path(view: V): string;
    /** A key that changes with the view, for React to reset on. */
    key(view: V): string;
    /** The window title for a view, read from the tab's store. */
    title(view: V): string;
    /**
     * The view the tab opens on. Null for a tab with no home view of its own
     * — Specs, whose door is the folder's README (specs/app/plugins.feature.md
     * "Specs is a built-in plugin"): its rail icon, its `g` chord and its tab
     * turn the sidebar to it and leave another tab's view for home.
     */
    home: V | null;
    /**
     * Turn a view that names no one thing — the tab itself, `/models` — into
     * the one it opens (the first model), or null when there is nothing to
     * open: a deep link then goes home, and the tab has no rail icon and no
     * `g` chord (specs/app/tasks.feature.md "A bare folder url opens that
     * tab"). Absent, every view opens as it is.
     */
    resolve?(view: V): V | null;
  };
  /**
   * Whether picking the tab in the sidebar's tab bar also opens its home
   * view. Absent is yes — the tab is the module's door. A list-only tab
   * (a special folder's pages, specs/app/roadmap.feature.md) says no: the
   * tab bar just turns the sidebar, and on a small screen the drawer stays
   * open for a row to be picked.
   */
  opensOnSelect?: boolean;
  /**
   * A tab that opens its views itself, loading each before it shows — Specs
   * reads the feature's file first, and a missed link leaves a note. App
   * hands it a view in place of holding it; true when the tab took it.
   * Absent, App holds the view and pushes its url.
   */
  open?(view: V, opts: OpenViewOptions): boolean;
  /**
   * The tab's own "new" — a task, a case, an issue: what `c` creates while
   * the tab is the sidebar, so the key never makes a feature from there.
   * Absent, `c` is quiet on the tab.
   */
  create?: {
    label: string;
    run(app: TabApp, navigate: Navigate<V>): void;
    /**
     * What `c` makes while one of the tab's views has the pane, over any
     * tab's "new" — a scenario on a feature's page. `run` null keeps `c`
     * quiet there; null leaves it to the shown tab's create.
     */
    inView?(view: V): { label: string; run: (() => void) | null } | null;
  };
  Sidebar: ComponentType<{ view: V | null; app: TabApp; navigate: Navigate<V> }>;
  Pane: ComponentType<{ view: V; app: TabApp; navigate: Navigate<V> }>;
  /**
   * The tab's own dialogs, rendered while the tab is on whatever the pane
   * shows — an import into a spec folder opens from the tree or the palette
   * while the pane is the folder's README, where `Pane` is not mounted.
   */
  Overlay?: ComponentType<{ app: TabApp }>;
  palette?: {
    group: PaletteGroup;
    /** The palette opened from this tab searches the tab's own data — its
        store, or its own server route. */
    search?(query: string, signal: AbortSignal): PaletteHit<V>[] | Promise<PaletteHit<V>[]>;
    /**
     * The palette searches this tab when the tab on screen offers no search
     * of its own — Specs' features, from a list tab with none.
     */
    fallback?: boolean;
    /** Commands the palette offers while the tab is mounted. */
    commands?(host: {
      prompt: Prompt;
      promptWithChoice: PromptWithChoice;
      confirm: Confirm;
      navigate: Navigate<V>;
    }): PaletteItem[];
  };
  /**
   * Keys of the tab's own beyond its `g` chord — ⇧⌘F searches the code
   * repository's files; `[]` for a command only the palette offers. App
   * turns the sidebar to the tab, then runs it; the key works while typing,
   * and the command palette lists it.
   */
  shortcuts?: TabShortcut[];
  /**
   * Crumbs a feature page carries back into the module — an Event Model
   * whose slice links the feature, say. App makes each a link to the view.
   */
  featureCrumbs?(fileName: string): { label: ReactNode; title: string; view: V }[];
  /**
   * What a code gen session started while the view is open bundles beyond
   * the picked specs: names the plugin's host half turns into prompt
   * sections (src/plugins/host/services.ts SessionParts) — the Event
   * Models plugin's model file — and how the session dialog names each.
   * Null when the view bundles nothing.
   */
  session?(view: V): { refs: string[]; labels: string[] } | null;
  /**
   * The name the command palette's Recent list shows for a view that was
   * open, or null for a view not worth remembering. Absent, the tab's views
   * are not remembered.
   */
  recent?(view: V): string | RecentItem<V> | null;
  /**
   * The file a coding agent session started from the view attaches — the
   * Files tab's open file, Specs' open feature. Absent, none.
   */
  current?(view: V): string | null;
  /** The tab's store, so App re-renders titles when it changes. */
  subscribe?(listener: () => void): () => void;
}

/**
 * A registry App renders from: add is reversible, and React subscribes.
 * Items sort by `rank` when the registry was given one — the profile's
 * order, for the tabs (specs/app/plugins.feature.md "The profile lists
 * enabled plugins in tab order") — and by their own `order` otherwise.
 */
export class Registry<T extends { id: string; order?: number }> {
  private items: T[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly rank?: (item: T) => number | undefined) {}

  add(item: T): Disposer {
    if (this.items.some((x) => x.id === item.id)) {
      throw new Error(`"${item.id}" is already registered`);
    }
    this.items = this.sorted([...this.items, item]);
    this.notify();
    return () => {
      this.items = this.items.filter((x) => x !== item);
      this.notify();
    };
  }

  /** Tell the subscribers to look again, the list unchanged. */
  touch(): void {
    this.items = [...this.items];
    this.notify();
  }

  /** Re-sort after the ranks changed — the profile was reordered, say. */
  resort(): void {
    const next = this.sorted([...this.items]);
    if (next.some((item, i) => item !== this.items[i])) {
      this.items = next;
      this.notify();
    }
  }

  private sorted(items: T[]): T[] {
    const key = (item: T) => this.rank?.(item) ?? item.order ?? 0;
    return items.sort((a, b) => key(a) - key(b));
  }

  /** The current items, a stable array until the next change. */
  list = (): T[] => this.items;

  get(id: string): T | undefined {
    return this.items.find((x) => x.id === id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/** The registry's items, re-rendering as they change. */
export function useRegistry<T extends { id: string; order?: number }>(registry: Registry<T>): T[] {
  return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
}

const noop = () => () => {};

/**
 * A counter that ticks with the tab's store, for effects that read the store
 * through the tab (the window title) to depend on. Null for no tab.
 */
export function useTabStore(tab: TabPlugin | null): number {
  const subscribe = tab?.subscribe ?? noop;
  return useSyncExternalStore(
    (listener) => {
      let n = 0;
      return subscribe(() => {
        n += 1;
        ticks.set(subscribe, n);
        listener();
      });
    },
    () => ticks.get(subscribe) ?? 0,
    () => 0,
  );
}
const ticks = new WeakMap<object, number>();

/**
 * A counter that ticks with every listed tab's store — what App reads the
 * tabs' crumbs, rail icons and session bundles through.
 */
export function useTabStores(list: TabPlugin[]): number {
  const cell = useMemo(() => ({ n: 0 }), [list]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = list.map((t) =>
        (t.subscribe ?? noop)(() => {
          cell.n += 1;
          listener();
        }),
      );
      return () => offs.forEach((off) => off());
    },
    [list, cell],
  );
  return useSyncExternalStore(subscribe, () => cell.n, () => 0);
}

/**
 * Whether a tab has anything to open: its home resolves to a view. A tab
 * with no home view always has its door — home, with its sidebar.
 */
export function tabReachable(tab: TabPlugin): boolean {
  const { home, resolve } = tab.route;
  return home === null || !resolve || resolve(home) !== null;
}

/** Where a tab's door leads: its home view's url, or home for a tab with none. */
export function tabHref(tab: TabPlugin): string {
  return tab.route.home === null ? "/" : tab.route.path(tab.route.home);
}

/** Which plugin view has the main pane. */
export interface PluginView {
  tab: string;
  view: unknown;
}

declare module "../kernel" {
  interface Services {
    tabs: Registry<TabPlugin>;
  }
  interface Events {
    /** The data folder is about to change: land what an open editor holds
        in the folder it was typed in, and seal it against later saves. */
    "data/leaving": () => void | Promise<void>;
    /** The data folder changed: forget the old one's data and load the new. */
    "data/changed": () => void | Promise<void>;
    /** The reload tick, with the plugin view that has the pane: refresh what
        is on screen, unless an editor is dirty. A listener that answers a
        promise is waited for — Sync's progress lasts until it has finished —
        and one that fails is logged, without stopping the others. */
    "reload/tick": (open: PluginView | null) => void | Promise<void>;
    /** The app's settings changed (`GET /api/state`'s payload) — a switch a
        module reads beside its own, the Google Calendar one say. */
    "settings/changed": (state: Record<string, unknown>) => void;
  }
}
