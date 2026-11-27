// A module-level store for the state that leaves App.tsx with the feature
// page and the editor (specs/app/plugins.feature.md "Specs is a built-in
// plugin"), like the listing (./listing.ts) and the tree's state
// (./treeState.ts). A field's setter takes what a `useState` setter takes,
// so the code that set App's state sets the store under the same name.
//
// A reader re-renders through a state update of its own rather than
// useSyncExternalStore, which renders at once and apart from every
// `useState` update made beside it: opening a feature sets this store and
// App's own state in one go, after a fetch, and they must show in the same
// render, as they did when all of it was App's state.

import { useLayoutEffect, useReducer } from "react";

/** A value, or a function of the current one — React's setState shape. */
export type Update<T> = T | ((prev: T) => T);

export interface Store<S> {
  /** The state as it stands. */
  get(): S;
  /** The setter of one field; an unchanged value notifies no one. */
  field<K extends keyof S>(key: K): (update: Update<S[K]>) => void;
  /** Back to the initial state — a fresh App, where its own state used to start. */
  reset(): void;
  subscribe(listener: () => void): () => void;
  /** The state, re-rendering as it changes. */
  use(): S;
}

/** A store starting from `initial()`, which `reset` calls again. */
export function createStore<S extends object>(initial: () => S): Store<S> {
  let state = initial();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  const get = () => state;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get,
    field(key) {
      return (update) => {
        const prev = state[key];
        const next = typeof update === "function" ? (update as (p: typeof prev) => typeof prev)(prev) : update;
        if (Object.is(next, prev)) return;
        state = { ...state, [key]: next };
        notify();
      };
    },
    reset() {
      state = initial();
      notify();
    },
    subscribe,
    use() {
      const [, rerender] = useReducer((n: number) => n + 1, 0);
      const rendered = state;
      useLayoutEffect(() => {
        // Set between this render and the subscription: render again.
        if (state !== rendered) rerender();
        return subscribe(rerender);
      }, []);
      return state;
    },
  };
}
