// The Files tab's text search (specs/app/code-search.feature.md "Find text
// in the repository"): what was typed, the three switches, and the results
// as the server streams them — a file with its matches per line, then the
// totals. A new query drops the one still running. One store for the app,
// read through useSyncExternalStore; nothing is kept between repositories.

import type { FileMatches, SearchSummary } from "../../server/codeSearch";
import type { Fetch } from "./filesStore";

export type SearchSwitch = "caseSensitive" | "wholeWord" | "regex";

export interface SearchState {
  /** The search field is showing in the sidebar. */
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** "searching" from the first key until the server's last line. */
  status: "idle" | "searching" | "done" | "error";
  /** Files with a match, in path order, as far as they have arrived. */
  files: FileMatches[];
  matches: number;
  /** The server stopped at its limit: there may be more. */
  truncated: boolean;
  error: string | null;
  /** Bumped to ask the field to take the focus (⇧⌘F while it is open). */
  focus: number;
}

const EMPTY: Pick<SearchState, "status" | "files" | "matches" | "truncated" | "error"> = {
  status: "idle",
  files: [],
  matches: 0,
  truncated: false,
  error: null,
};

/** The line under the field: how many results, or why there are none. */
export function searchStatus(state: SearchState): string {
  if (!state.query) return "";
  if (state.status === "error") return state.error ?? "The search failed";
  const count = `${state.matches.toLocaleString("en-US")} ${state.matches === 1 ? "result" : "results"} in ${
    state.files.length
  } ${state.files.length === 1 ? "file" : "files"}`;
  if (state.status === "searching") return state.matches === 0 ? "Searching…" : `${count}…`;
  if (state.status !== "done") return "";
  if (state.matches === 0) return "No results";
  return state.truncated ? `The first ${count} — narrow the search to see the rest` : count;
}

export function createSearchStore(fetchFn: Fetch = (input, init) => fetch(input, init), delayMs = 200) {
  let state: SearchState = { open: false, query: "", caseSensitive: false, wholeWord: false, regex: false, focus: 0, ...EMPTY };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: AbortController | null = null;
  /** The search in flight; awaited by tests. */
  let settled: Promise<void> = Promise.resolve();

  const set = (next: Partial<SearchState>) => {
    state = { ...state, ...next };
    for (const l of listeners) l();
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    running?.abort();
    running = null;
  };

  async function search(controller: AbortController): Promise<void> {
    const live = () => running === controller;
    const params = new URLSearchParams({ q: state.query });
    if (state.caseSensitive) params.set("case", "1");
    if (state.wholeWord) params.set("word", "1");
    if (state.regex) params.set("regex", "1");
    try {
      const res = await fetchFn(`/api/files/search?${params}`, { signal: controller.signal });
      if (!live()) return;
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (live()) set({ ...EMPTY, status: "error", error: typeof body?.error === "string" ? body.error : `Search failed (${res.status})` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const found: FileMatches[] = [];
      let matches = 0;
      let rest = "";
      let end: (SearchSummary & { error?: string }) | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (!live()) return;
        rest += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = rest.split("\n");
        rest = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          const row = JSON.parse(line) as (FileMatches & { done?: undefined }) | (SearchSummary & { done: true; error?: string });
          if (row.done) end = row;
          else {
            found.push(row);
            matches += row.matches.length;
          }
        }
        // One render per chunk, however many files it carried.
        if (!end) set({ files: [...found], matches });
        if (done || end) break;
      }
      if (end?.error) set({ ...EMPTY, status: "error", error: end.error });
      else set({ status: "done", files: found, matches, truncated: end?.truncated ?? false, error: null });
    } catch (e) {
      if (live()) set({ ...EMPTY, status: "error", error: (e as Error).message });
    } finally {
      if (live()) running = null;
    }
  }

  /** Run the search for what the field holds, now. */
  function run(): Promise<void> {
    cancel();
    if (!state.query) {
      set({ ...EMPTY });
      return (settled = Promise.resolve());
    }
    const controller = new AbortController();
    running = controller;
    set({ ...EMPTY, status: "searching" });
    return (settled = search(controller));
  }

  /** ...or once the typing pauses. */
  function schedule(): void {
    cancel();
    if (!state.query) {
      set({ ...EMPTY });
      return;
    }
    set({ status: "searching", error: null });
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: (): SearchState => state,

    /** Show the search field and hand it the focus. */
    show(): void {
      set({ open: true, focus: state.focus + 1 });
    },

    /** Put the search away: the tree shows again, the query is dropped. */
    hide(): void {
      cancel();
      set({ open: false, query: "", ...EMPTY });
    },

    setQuery(query: string): void {
      if (query === state.query) return;
      set({ query });
      schedule();
    },

    /** Flip a switch and search again. */
    toggle(which: SearchSwitch): void {
      set({ [which]: !state[which] });
      if (state.query) void run();
    },

    run,

    /** The search in flight, for a test to wait on. */
    idle: (): Promise<void> => settled,

    /** Forget everything: the repository is going away. */
    reset(): void {
      cancel();
      set({ open: false, query: "", caseSensitive: false, wholeWord: false, regex: false, ...EMPTY });
    },
  };
}

export type SearchStore = ReturnType<typeof createSearchStore>;

/** The app's one store. */
export const fileSearch = createSearchStore();
