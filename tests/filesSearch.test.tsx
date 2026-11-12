// Automates specs/app/code-search.feature.md in the browser half: the
// search store reading the server's stream, the result rows' markup, the
// palette's file search, the ⇧⌘F key the tab registers, and the store's
// "go to this line" request. Pure helpers and static markup; the stores
// run against a stand-in fetch.

import { test, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileMatches } from "../src/server/codeSearch";
import { createFilesStore } from "../src/frontend/files/filesStore";
import { FilesSearchField, FilesSearchResults, resultRows, spaClick } from "../src/frontend/files/FilesSearch";
import { filesTab, findFiles, markedPath } from "../src/frontend/files/plugin";
import { createSearchStore, fileSearch, searchStatus } from "../src/frontend/files/searchStore";

const README: FileMatches = {
  path: "README.md",
  matches: [{ line: 3, col: 5, length: 5, text: "Say hello to the world.", start: 4, end: 9 }],
};
const INDEX: FileMatches = {
  path: "src/index.ts",
  matches: [
    { line: 1, col: 26, length: 5, text: 'export const greeting = "Hello";', start: 25, end: 30 },
    { line: 3, col: 12, length: 5, text: "function helloWorld() {}", start: 9, end: 14 },
  ],
  more: true,
};

/** A response whose body arrives in the given chunks, as the server streams it. */
function streamed(chunks: string[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) return controller.error(new DOMException("aborted", "AbortError"));
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        else controller.close();
      },
    }),
  );
}

const lines = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");

afterEach(() => {
  fileSearch.reset();
});

// --- The store ------------------------------------------------------------------

test("a search asks the server with its switches and shows the files as they arrive", async () => {
  const urls: string[] = [];
  const body = lines(README, INDEX, { done: true, files: 2, matches: 3, scanned: 5, truncated: false, ms: 4 });
  // The stream is cut mid-line: a line is read once it is whole.
  const cut = body.indexOf("src/index");
  const store = createSearchStore(async (url, init) => {
    urls.push(url);
    return streamed([body.slice(0, cut), body.slice(cut)], init?.signal);
  }, 0);
  const seen: number[] = [];
  store.subscribe(() => seen.push(store.getState().files.length));
  store.setQuery("hello");
  expect(store.getState().status).toBe("searching");
  expect(searchStatus(store.getState())).toBe("Searching…");
  store.toggle("caseSensitive");
  await store.idle();
  expect(urls.at(-1)).toBe("/api/files/search?q=hello&case=1");
  expect(store.getState()).toMatchObject({ status: "done", matches: 3, truncated: false, error: null });
  expect(store.getState().files.map((f) => f.path)).toEqual(["README.md", "src/index.ts"]);
  // The first file showed before the second had arrived.
  expect(seen).toContain(1);
  expect(searchStatus(store.getState())).toBe("3 results in 2 files");
  store.toggle("wholeWord");
  store.toggle("regex");
  await store.idle();
  expect(urls.at(-1)).toBe("/api/files/search?q=hello&case=1&word=1&regex=1");
});

test("typing waits for a pause, and a new query drops the one still running", async () => {
  const asked: { url: string; signal: AbortSignal }[] = [];
  const store = createSearchStore(async (url, init) => {
    asked.push({ url, signal: init!.signal! });
    return streamed([lines(README, { done: true, files: 1, matches: 1, scanned: 5, truncated: false, ms: 1 })], init?.signal);
  }, 10);
  store.setQuery("h");
  store.setQuery("he");
  store.setQuery("hel");
  // Nothing was asked while the keys kept coming.
  expect(asked).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 30));
  await store.idle();
  expect(asked.map((a) => a.url)).toEqual(["/api/files/search?q=hel"]);
  // Enter searches at once; the search before it is aborted.
  void store.run();
  void store.run();
  await store.idle();
  expect(asked).toHaveLength(3);
  expect(asked[1]!.signal.aborted).toBe(true);
  expect(store.getState()).toMatchObject({ status: "done", matches: 1 });
});

test("the line under the field says no results, the limit, or why the search failed", async () => {
  const none = createSearchStore(async () => streamed([lines({ done: true, files: 0, matches: 0, scanned: 5, truncated: false, ms: 1 })]), 0);
  none.setQuery("zzz");
  await none.run();
  expect(searchStatus(none.getState())).toBe("No results");

  const capped = createSearchStore(async () => streamed([lines(README, { done: true, files: 1, matches: 1, scanned: 2, truncated: true, ms: 1 })]), 0);
  capped.setQuery("hello");
  await capped.run();
  expect(searchStatus(capped.getState())).toBe("The first 1 result in 1 file — narrow the search to see the rest");

  const refused = createSearchStore(
    async () => new Response(JSON.stringify({ error: "Not a regular expression: Unterminated group" }), { status: 400 }),
    0,
  );
  refused.setQuery("hello(");
  await refused.run();
  expect(refused.getState()).toMatchObject({ status: "error", files: [] });
  expect(searchStatus(refused.getState())).toBe("Not a regular expression: Unterminated group");

  const offline = createSearchStore(async () => {
    throw new Error("Failed to fetch");
  }, 0);
  offline.setQuery("hello");
  await offline.run();
  expect(searchStatus(offline.getState())).toBe("Failed to fetch");
});

test("closing the search drops the query and its results; ⇧⌘F shows the field again", async () => {
  const store = createSearchStore(async () => streamed([lines(README, { done: true, files: 1, matches: 1, scanned: 5, truncated: false, ms: 1 })]), 0);
  expect(store.getState().open).toBe(false);
  store.show();
  expect(store.getState()).toMatchObject({ open: true, focus: 1 });
  store.setQuery("hello");
  await store.run();
  expect(store.getState().files).toHaveLength(1);
  store.hide();
  expect(store.getState()).toMatchObject({ open: false, query: "", status: "idle", files: [], matches: 0 });
  expect(searchStatus(store.getState())).toBe("");
  // Clearing the field shows the tree again without closing the search.
  store.show();
  store.setQuery("hello");
  store.setQuery("");
  expect(store.getState()).toMatchObject({ open: true, focus: 2, status: "idle", files: [] });
});

// --- Markup -------------------------------------------------------------------

test("a result lists the file with its count, then each match's line number and marked line", () => {
  const html = renderToStaticMarkup(<>{resultRows([README, INDEX], "src/index.ts", { goTo: () => {} }, () => {})}</>);
  // The file's row: its name, its folder, how many matches (more than listed: a +).
  expect(html).toContain('title="src/index.ts"');
  expect(html).toContain('<span class="files-hit-folder"> src</span>');
  expect(html).toContain('<span class="row-trailing">2+</span>');
  expect(html).toContain('<span class="row-trailing">1</span>');
  expect(html).toContain('aria-current="page"');
  // A match's row: under its file, linked to it, the match marked.
  expect(html).toContain('aria-level="2"');
  expect(html).toContain('href="/files/src/index.ts"');
  expect(html).toContain('<span class="files-hit-line">3</span>');
  expect(html).toContain("Say <mark>hello</mark> to the world.");
  expect(html).toContain('title="README.md, line 3"');
  expect(html.match(/role="treeitem"/g)).toHaveLength(5);
});

test("the results are a tree of their own, filled from the search as it stands", async () => {
  const store = createSearchStore(async () => streamed([lines(README, INDEX, { done: true, files: 2, matches: 3, scanned: 5, truncated: false, ms: 1 })]), 0);
  const empty = renderToStaticMarkup(<FilesSearchResults active={null} navigate={() => {}} store={store} />);
  expect(empty).toContain('role="tree"');
  expect(empty).toContain('aria-label="Search results"');
  expect(empty).not.toContain('role="treeitem"');
  store.setQuery("hello");
  await store.run();
  const html = renderToStaticMarkup(<FilesSearchResults active="README.md" navigate={() => {}} store={store} />);
  expect(html.match(/role="treeitem"/g)).toHaveLength(5);
  expect(html).toContain('aria-current="page" title="README.md"');
});

test("the field is a search box with three switches that say whether they are on", () => {
  const store = createSearchStore(async () => streamed([]), 0);
  store.show();
  store.toggle("regex");
  const html = renderToStaticMarkup(<FilesSearchField store={store} />);
  expect(html).toContain('role="searchbox"');
  expect(html).toContain('aria-label="Search in files"');
  expect(html).toMatch(/aria-label="Match case" aria-pressed="false"/);
  expect(html).toMatch(/aria-label="Match whole words" aria-pressed="false"/);
  expect(html).toMatch(/aria-label="Use a regular expression" aria-pressed="true"/);
  // Nothing typed: no status line.
  expect(html).not.toContain('role="status"');
});

// --- The palette and the key ------------------------------------------------------

test("the palette asks the server for files by name and marks what matched in the path", async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(input);
    return new Response(
      JSON.stringify({ query: "sapi", total: 1, results: [{ path: "src/server/api.ts", name: "api.ts", indexes: [4, 11, 12, 13] }] }),
    );
  }) as unknown as typeof fetch;
  try {
    expect(await findFiles("  ")).toEqual([]);
    expect(urls).toEqual([]);
    const hits = await filesTab.palette!.search!("s api", new AbortController().signal);
    expect(urls).toEqual(["/api/files/find?q=s%20api"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "files:src/server/api.ts", label: "api.ts", href: "/files/src/server/api.ts", view: { path: "src/server/api.ts" } });
    expect(renderToStaticMarkup(<>{hits[0]!.sub}</>)).toBe("src/<mark>s</mark>erver/<mark>api</mark>.ts");
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "No code repository is open" }), { status: 409 })) as unknown as typeof fetch;
    expect(findFiles("api")).rejects.toThrow("No code repository is open");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(renderToStaticMarkup(<>{markedPath("a/b.ts", [])}</>)).toBe("a/b.ts");
});

test("the tab registers mod+shift+f, which shows the search field", () => {
  const key = filesTab.shortcuts!.find((s) => s.id === "files-search")!;
  expect(key.keys).toBe("mod+shift+f");
  expect(key.label).toBe("Search in files");
  expect(fileSearch.getState().open).toBe(false);
  key.run();
  expect(fileSearch.getState().open).toBe(true);
});

// --- Going to a line --------------------------------------------------------------

test("a result asks the editor for its place once, and the request is dropped when another file opens", async () => {
  const store = createFilesStore(async (input) => {
    const path = new URL(input, "http://x").searchParams.get("path") ?? "";
    if (input.startsWith("/api/files/dir")) return new Response(JSON.stringify({ path, entries: [] }));
    return new Response(JSON.stringify({ path, content: "a\nb\nc\n", mtimeMs: 1, size: 6, eol: "lf" }));
  });
  await store.configure("/code");
  expect(store.getState().goto).toBeNull();
  store.goTo("src/index.ts", 3, 12, 5);
  const first = store.getState().goto!;
  expect(first).toMatchObject({ path: "src/index.ts", line: 3, col: 12, length: 5 });
  // Opening the file it names keeps the request for the editor.
  await store.open("src/index.ts");
  expect(store.getState().goto).toBe(first);
  // The same place asked again is a new request.
  store.goTo("src/index.ts", 3, 12, 5);
  expect(store.getState().goto!.seq).toBeGreaterThan(first.seq);
  // An answer to the old request leaves the new one standing.
  store.wentTo(first.seq);
  expect(store.getState().goto).not.toBeNull();
  store.wentTo(store.getState().goto!.seq);
  expect(store.getState().goto).toBeNull();
  // A place in a file that was never shown is forgotten when another opens.
  store.goTo("src/other.ts", 9);
  expect(store.getState().goto).toMatchObject({ line: 9, col: 1, length: 0 });
  await store.open("README.md");
  expect(store.getState().goto).toBeNull();
});

test("a plain click on a result opens it in the app, and a modified click is left to the browser", () => {
  const click = (keys: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => {
    const seen = { prevented: false, opened: false };
    const event = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...keys, preventDefault: () => (seen.prevented = true) };
    spaClick(event as never, () => (seen.opened = true));
    return seen;
  };
  expect(click()).toEqual({ prevented: true, opened: true });
  // ⌘-click, Ctrl-click, Shift-click and Alt-click keep the link's own meaning: a new tab, a new window.
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    expect(click({ [key]: true })).toEqual({ prevented: false, opened: false });
  }
});
