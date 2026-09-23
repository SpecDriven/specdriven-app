// The browser half's extension point for a module tab (roadmap/plugin-
// architecture.md "Extension points"): what a plugin registers to own a
// sidebar tab and the main pane, and what App.tsx renders from. App keeps
// one generic "which plugin view is open" state; everything module-specific
// — the urls, the sidebar, the pane, the shortcut, the palette entries, the
// store's lifecycle — comes from the registered tab.

import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import type { Disposer } from "../kernel";
import type { Crumb } from "../../frontend/Breadcrumbs";
import type { ConfirmOptions, PromptOptions } from "../../frontend/ModalPrompts";
import type { PaletteGroup, PaletteItem } from "../../frontend/CommandPalette";
import type { FeatureListing } from "../../server/features";
import type { ProjectMember } from "../../server/members";

export type Prompt = (opts: PromptOptions) => Promise<string | null>;
export type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/** What App hands a tab's components: the shared state and dialogs. */
export interface TabApp {
  features: FeatureListing[];
  members: ProjectMember[];
  /** The Assignments setting: whether the module shows "Assigned" chips. */
  assignments: boolean;
  repoCrumb: Crumb;
  autosaveSeconds: number;
  prompt: Prompt;
  confirm: Confirm;
  /** Opens the Settings dialog — where the GitHub sign-in lives, say. */
  openSettings: () => void;
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
  };
  Sidebar: ComponentType<{ view: V | null; app: TabApp; navigate: Navigate<V> }>;
  Pane: ComponentType<{ view: V; app: TabApp; navigate: Navigate<V> }>;
  palette?: {
    group: PaletteGroup;
    /** The palette opened from this tab searches the tab's own data. */
    search?(query: string): PaletteHit<V>[];
    /** Commands the palette offers while the tab is mounted. */
    commands?(host: { prompt: Prompt; confirm: Confirm; navigate: Navigate<V> }): PaletteItem[];
  };
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
    /** The data folder changed: forget the old one's data and load the new. */
    "data/changed": () => void | Promise<void>;
    /** The reload tick, with the plugin view that has the pane: refresh what
        is on screen, unless an editor is dirty. */
    "reload/tick": (open: PluginView | null) => void;
  }
}
