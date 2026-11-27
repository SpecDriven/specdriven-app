// Code gen sessions (specs/agents/claude.feature.md): the specs checked in
// the tree, and the scenarios checked on their cards, go into a named
// session that runs the coding agent. Kept apart from App.tsx like the open
// feature (./openFeature.ts): the tree and the feature page check and
// uncheck, and the session dialogs — the shell's — read what is checked.

import { createStore } from "./store";

/** Per file, the whole spec ("all") or a set of scenario keys. */
export type SpecSelection = Map<string, "all" | Set<string>>;

const store = createStore<{ specSelection: SpecSelection }>(() => ({ specSelection: new Map() }));

export const setSpecSelection = store.field("specSelection");
/** Nothing checked — a fresh App, where its own state used to start. */
export const resetSpecSelection = store.reset;
export const specSelection = (): SpecSelection => store.get().specSelection;
/** What is checked, re-rendering as it changes. */
export const useSpecSelection = (): SpecSelection => store.use().specSelection;

/**
 * A scenario's identity within its file: the `<name>@v<version>` heading
 * syntax, used as both a publish-progress and a selection key.
 */
export const scenarioKey = (s: { name: string; version: number }): string => `${s.name}@v${s.version}`;

// The spec's own checkbox: none or some scenarios → the whole spec;
// the whole spec → cleared.
export const toggleSpecSelected = (fileName: string): void =>
  setSpecSelection((prev) => {
    const next = new Map(prev);
    if (next.get(fileName) === "all") next.delete(fileName);
    else next.set(fileName, "all");
    return next;
  });

// A scenario's checkbox on its card: unchecking one of a whole-spec
// selection keeps the rest; checking the last missing one promotes back to
// the whole spec. `all` is every scenario the file has, so "the whole
// spec" and "all of its scenarios" stay the same selection.
export const toggleScenarioSelected = (
  fileName: string,
  all: { name: string; version: number }[],
  key: string,
): void =>
  setSpecSelection((prev) => {
    const next = new Map(prev);
    const entry = next.get(fileName);
    const picked = new Set(entry === "all" ? all.map(scenarioKey) : (entry ?? []));
    if (picked.has(key)) picked.delete(key);
    else picked.add(key);
    if (picked.size === 0) next.delete(fileName);
    else if (all.every((s) => picked.has(scenarioKey(s)))) next.set(fileName, "all");
    else next.set(fileName, picked);
    return next;
  });

/** True when this scenario is in the session selection. */
export const scenarioSelected = (fileName: string, s: { name: string; version: number }): boolean => {
  const entry = specSelection().get(fileName);
  return entry === "all" || (entry instanceof Set && entry.has(scenarioKey(s)));
};
