// The feature open in the pane — its file, what was read of it, the scenario
// highlighted on its page and the one open in the editor — kept apart from
// App.tsx so the Specs tab (src/plugins/builtin/specs/client.tsx) reads it
// from its plugin: the window title, the Recent list, and in time the page
// and the editor themselves. App.tsx still opens the feature and sets all of
// this, under the names its own state had.

import type { Feature, Scenario } from "../../server/parser";
import { titleFromFileName } from "../../server/parser";
import { pageScenario, type EditState } from "./scenarioEdit";
import { createStore } from "./store";

export interface OpenFeatureState {
  /** The open feature's file name; null on home. */
  selected: string | null;
  /** The open feature as last read, with its drafts. */
  feature: Feature | null;
  /** A feature is being fetched — the skeleton shows until it lands. */
  featureLoading: boolean;
  /** The scenario card highlighted on the feature's page (the keyboard's). */
  selectedScenario: number | null;
  /** An edit the page holds that a refresh must not replace. */
  dirty: boolean;
  /** The scenario open in the editor pane. */
  editing: EditState | null;
  /**
   * A scenario deep link asks for that scenario's page (specs/ui/
   * navigation.feature.md "open a scenario link"). The pane opens from an
   * effect rather than straight from the navigation: any pane the link
   * replaced closes first, so the new one starts a fresh editor session.
   */
  paneRequest: {
    scenario: Scenario;
    /** Search terms to mark in the pane (specs/search.feature.md), when a hit opened it. */
    terms: string[] | null;
  } | null;
  /**
   * The words marked in the open scenario editor (specs/search.feature.md):
   * the terms of the search hit that opened it, gone when the pane closes.
   */
  searchTerms: string[] | null;
}

const store = createStore<OpenFeatureState>(() => ({
  selected: null,
  feature: null,
  featureLoading: false,
  selectedScenario: null,
  dirty: false,
  editing: null,
  paneRequest: null,
  searchTerms: null,
}));

export const setSelected = store.field("selected");
export const setFeature = store.field("feature");
export const setFeatureLoading = store.field("featureLoading");
export const setSelectedScenario = store.field("selectedScenario");
export const setDirty = store.field("dirty");
export const setEditing = store.field("editing");
export const setPaneRequest = store.field("paneRequest");
export const setSearchTerms = store.field("searchTerms");

/** Nothing open — a fresh App, where its own state used to start. */
export const resetOpenFeature = store.reset;
export const openFeatureState = store.get;
export const subscribeOpenFeature = store.subscribe;
/** The open feature's state, re-rendering as it changes. */
export const useOpenFeature = store.use;

/**
 * The window title's page part (specs/ui/navigation.feature.md): the open
 * feature, and the scenario open in the pane; null while none is read.
 */
export function openFeatureTitle(): string | null {
  const { selected, feature, editing } = store.get();
  if (!feature || !selected) return null;
  const name = feature.name || titleFromFileName(selected);
  const scenario = pageScenario(editing, feature.scenarios);
  return scenario ? `${name} · ${scenario.name} v${scenario.version}` : name;
}
