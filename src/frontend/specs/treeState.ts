// The feature tree's own state — which folders are folded, which outlines
// are open, the folder picked, a drag under way, the open row menu, the
// scenarios picked and the filter — kept apart from App.tsx so the Specs
// tab's sidebar (specs/app/plugins.feature.md "Specs is a built-in plugin")
// reads one store rather than a dozen pieces of App state. Module-level and
// read through useSyncExternalStore, like the listing (./listing.ts).

import { useSyncExternalStore } from "react";
import type { ScenarioStatus } from "../../server/parser";
import { NO_FILTER, type TreeFilter } from "../treeFilter";

export interface TreeState {
  /** Folder paths whose subtree is collapsed in the sidebar. */
  collapsed: Set<string>;
  /**
   * Feature files whose scenario outline is expanded in the sidebar
   * (specs/ui/navigation.feature.md "Scenario navigation"). Folders default to
   * open because a repo has few of them; scenario outlines are many, so they
   * default to closed and this tracks the ones opened — the mirror image of
   * `collapsed`. Kept for the session, like the folder state.
   */
  outlined: Set<string>;
  /** Folder highlighted by a click; "+ New folder" creates inside it. */
  selectedFolder: string | null;
  /** File name of the feature being dragged, if any. */
  dragging: string | null;
  /**
   * Scenarios picked in the sidebar tree (specs/ui/navigation.feature.md
   * "delete several scenarios at once"): ⌘/Ctrl-click toggles a row,
   * Shift-click picks the range from the anchor. Keyed by treeScenarioKey.
   */
  treePicks: Set<string>;
  /** Sidebar entry whose "⋯" menu is open (file name), if any. */
  treeMenu: string | null;
  /** Folder path the drag is hovering over ("" = top level). */
  dropTarget: string | null;
  /**
   * The sibling feature row a dragged feature would land beside (specs/ui/
   * folders.feature.md "order features"), and on which edge. A feature
   * dragged over a row in another folder drops into that folder instead.
   */
  featureDropAt: { fileName: string; after: boolean } | null;
  /**
   * A scenario being dragged — a row of the sidebar outline or a card of the
   * feature page (specs/ui/navigation.feature.md "reorder scenarios by
   * dragging them in the tree", "drag a scenario to another feature") — and
   * the row or card edge it would land on, in its own feature or another.
   * Apart from `dragging`, so the folders' drop zones never take it for a
   * feature.
   */
  scenarioDrag: { file: string; name: string; version: number; status: ScenarioStatus } | null;
  scenarioDropAt: { file: string; name: string; version: number; after: boolean } | null;
  /** The feature row a scenario dragged out of another feature is over. */
  scenarioDropInto: string | null;
  /**
   * A folder being dragged among its siblings (specs/ui/folders.feature.md
   * "order folders"), and the sibling row edge it would land on. Apart from
   * `dragging` too: a folder never drops into a folder, only beside one.
   */
  folderDrag: { parent: string; path: string } | null;
  folderDropAt: { path: string; after: boolean } | null;
  /** The sidebar's filter, and its menu. */
  filter: TreeFilter;
  filterMenuOpen: boolean;
}

function initial(): TreeState {
  return {
    collapsed: new Set(),
    outlined: new Set(),
    selectedFolder: null,
    dragging: null,
    treePicks: new Set(),
    treeMenu: null,
    dropTarget: null,
    featureDropAt: null,
    scenarioDrag: null,
    scenarioDropAt: null,
    scenarioDropInto: null,
    folderDrag: null,
    folderDropAt: null,
    filter: NO_FILTER,
    filterMenuOpen: false,
  };
}

let state: TreeState = initial();
const listeners = new Set<() => void>();

/** A value, or a function of the current one — React's setState shape. */
type Update<T> = T | ((prev: T) => T);

function field<K extends keyof TreeState>(key: K) {
  return (update: Update<TreeState[K]>) => {
    const prev = state[key];
    const next = typeof update === "function" ? (update as (p: TreeState[K]) => TreeState[K])(prev) : update;
    if (Object.is(next, prev)) return;
    state = { ...state, [key]: next };
    for (const l of listeners) l();
  };
}

export const setCollapsed = field("collapsed");
export const setOutlined = field("outlined");
export const setSelectedFolder = field("selectedFolder");
export const setDragging = field("dragging");
export const setTreePicks = field("treePicks");
export const setTreeMenu = field("treeMenu");
export const setDropTarget = field("dropTarget");
export const setFeatureDropAt = field("featureDropAt");
export const setScenarioDrag = field("scenarioDrag");
export const setScenarioDropAt = field("scenarioDropAt");
export const setScenarioDropInto = field("scenarioDropInto");
export const setFolderDrag = field("folderDrag");
export const setFolderDropAt = field("folderDropAt");
export const setFilter = field("filter");
export const setFilterMenuOpen = field("filterMenuOpen");

/** Nothing folded, picked or dragged — a fresh App, where its own state used to start. */
export function resetTreeState(): void {
  state = initial();
  for (const l of listeners) l();
}

export function treeState(): TreeState {
  return state;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The tree's state, re-rendering as it changes. */
export function useTreeState(): TreeState {
  return useSyncExternalStore(subscribe, treeState, treeState);
}
