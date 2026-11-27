// The open folder's spec listing — its features and the folders of the tree,
// with their descriptions and orders (specs/ui/folders.feature.md) — as read
// from `GET /api/features`. Module-level state read through
// useSyncExternalStore, like the pages' stores (src/frontend/pages/pages.ts),
// so the Specs tab can read it from its plugin while App.tsx still loads it.
//
// It stays core, not the Specs plugin's: other tabs, agent sessions and the
// palette read the features whether Specs is switched on or not
// (specs/app/plugins.feature.md "Specs is a built-in plugin").

import { useSyncExternalStore } from "react";
import type { FeatureListing } from "../../server/features";
import type { ScenarioStatus } from "../../server/parser";

export interface SpecsListing {
  features: FeatureListing[];
  folders: string[];
  /** Folder path → description, for the folders that have a display-name.txt. */
  folderDescriptions: Record<string, string>;
  /**
   * Folder path → its subfolders in order (specs/ui/folders.feature.md
   * "order folders"), for the folders that have a folder-order.txt; the top
   * level's under `specs`. A move writes the new order here first, so the
   * tree shows it while the save is out.
   */
  folderOrders: Record<string, string[]>;
  /**
   * Folder path → its features' file names in order (specs/ui/
   * folders.feature.md "order features"), for the folders that have a
   * feature-order.txt. Written first on a move, like `folderOrders`.
   */
  featureOrders: Record<string, string[]>;
}

const EMPTY: SpecsListing = {
  features: [],
  folders: [],
  folderDescriptions: {},
  folderOrders: {},
  featureOrders: {},
};

let state: SpecsListing = EMPTY;
const listeners = new Set<() => void>();

function set(next: SpecsListing) {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

/** A value, or a function of the current one — React's setState shape. */
type Update<T> = T | ((prev: T) => T);

function field<K extends keyof SpecsListing>(key: K) {
  return (update: Update<SpecsListing[K]>) => {
    const prev = state[key];
    const next =
      typeof update === "function" ? (update as (p: SpecsListing[K]) => SpecsListing[K])(prev) : update;
    if (next !== prev) set({ ...state, [key]: next });
  };
}

export const setFeatures = field("features");
export const setFolders = field("folders");
export const setFolderDescriptions = field("folderDescriptions");
export const setFolderOrders = field("folderOrders");
export const setFeatureOrders = field("featureOrders");

/** Takes a whole listing as the server answered it. */
export function setListing(listing: SpecsListing) {
  set({
    features: listing.features,
    folders: listing.folders,
    folderDescriptions: listing.folderDescriptions,
    folderOrders: listing.folderOrders,
    featureOrders: listing.featureOrders,
  });
}

/** Back to nothing listed — a fresh App, where `useState([])` used to start. */
export function resetListing() {
  set(EMPTY);
}

export function specsListing(): SpecsListing {
  return state;
}

/**
 * A listed scenario's status — what a palette hit or a Recent entry shows
 * beside its name. One the listing does not know reads as proposed.
 */
export function scenarioStatus(fileName: string, s: { name: string; version: number }): ScenarioStatus {
  return (
    state.features
      .find((f) => f.fileName === fileName)
      ?.scenarios.find((x) => x.name === s.name && x.version === s.version)?.status ?? "proposed"
  );
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The listing, re-rendering as it changes. */
export function useSpecsListing(): SpecsListing {
  return useSyncExternalStore(subscribe, specsListing, specsListing);
}
