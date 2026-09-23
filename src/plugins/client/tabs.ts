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
import type { ConfirmOptions, PromptOptions, PromptResult } from "../../frontend/ModalPrompts";
import type { PaletteGroup, PaletteItem } from "../../frontend/CommandPalette";
import type { FeatureListing } from "../../server/features";
import type { ProjectMember } from "../../server/members";

export type Prompt = (opts: PromptOptions) => Promise<string | null>;
export type Confirm = (opts: ConfirmOptions) => Promise<boolean>;
/** A prompt with a radio group: the text together with the picked value. */
export type PromptWithChoice = (opts: PromptOptions) => Promise<PromptResult | null>;

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
  /** Opens the Settings dialog — where the GitHub sign-in lives, say. */
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
}

/** Open one of the tab's views; `push` adds a history entry. */
export type Navigate<V> = (view: V, opts?: { push?: boolean }) => void;

/** A palette hit from the tab's own search — the store, not the server index. */
export interface PaletteHit<V> {
  id: string;
  label: string;
  sub?: ReactNode;
  href?: string;
  view: V;
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
    /** The view the tab opens on. */
    home: V;
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
  Sidebar: ComponentType<{ view: V | null; app: TabApp; navigate: Navigate<V> }>;
  Pane: ComponentType<{ view: V; app: TabApp; navigate: Navigate<V> }>;
  palette?: {
    group: PaletteGroup;
    /** The palette opened from this tab searches the tab's own data — its
        store, or its own server route. */
    search?(query: string, signal: AbortSignal): PaletteHit<V>[] | Promise<PaletteHit<V>[]>;
    /** Commands the palette offers while the tab is mounted. */
    commands?(host: {
      prompt: Prompt;
      promptWithChoice: PromptWithChoice;
      confirm: Confirm;
      navigate: Navigate<V>;
    }): PaletteItem[];
  };
  /**
   * Crumbs a feature page carries back into the module — an Event Model
   * whose slice links the feature, say. App makes each a link to the view.
   */
  featureCrumbs?(fileName: string): { label: ReactNode; title: string; view: V }[];
  /**
   * What a code gen session started while the view is open bundles beyond
   * the picked specs: model files for the prompt, and how the session dialog
   * names each. Null when the view bundles nothing.
   */
  session?(view: V): { models: string[]; labels: string[] } | null;
  /**
   * The name the command palette's Recent list shows for a view that was
   * open, or null for a view not worth remembering. Absent, the tab's views
   * are not remembered.
   */
  recent?(view: V): string | null;
  /** The tab's store, so App re-renders titles when it changes. */
  subscribe?(listener: () => void): () => void;
}

/** A registry App renders from: add is reversible, and React subscribes. */
export class Registry<T extends { id: string; order?: number }> {
  private items: T[] = [];
  private readonly listeners = new Set<() => void>();

  add(item: T): Disposer {
    if (this.items.some((x) => x.id === item.id)) {
      throw new Error(`"${item.id}" is already registered`);
    }
    this.items = [...this.items, item].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.notify();
    return () => {
      this.items = this.items.filter((x) => x !== item);
      this.notify();
    };
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

/** Whether a tab has anything to open: its home resolves to a view. */
export function tabReachable(tab: TabPlugin): boolean {
  return !tab.route.resolve || tab.route.resolve(tab.route.home) !== null;
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
        is on screen, unless an editor is dirty. */
    "reload/tick": (open: PluginView | null) => void;
    /** The app's settings changed (`GET /api/state`'s payload) — a switch a
        module reads beside its own, the Google Calendar one say. */
    "settings/changed": (state: Record<string, unknown>) => void;
  }
}
