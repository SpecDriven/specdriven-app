// Automates specs/app/code-repo-mode.feature.md in the browser half: the
// Files tab's urls, its store (the tree as far as it is opened, the file in
// the editor and how it saves), the tree's markup, the pane's header, and
// the loader mounting the tab — and none of the specification modules — for
// an open code repository. Pure helpers and static markup; the store runs
// against a stand-in fetch.

import { test, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { baseName, filesPath, parentFolders, parseFilesRoute } from "../src/frontend/files/route";
import { createFilesStore, isDirty, type FilesState, type OpenFile } from "../src/frontend/files/filesStore";
import { treeRows } from "../src/frontend/files/FilesSidebar";
import { FilesPane, readmeOf, saveStatus } from "../src/frontend/files/FilesPane";
import { languageOf } from "../src/frontend/files/codeLanguage";
import { filesTab, searchFiles } from "../src/frontend/files/plugin";
import { matchPluginRoute, syncClientPlugins, tabs } from "../src/plugins/client/loader";

afterEach(async () => {
  await syncClientPlugins([]);
});

// --- Urls ---------------------------------------------------------------------

test("the tab's urls are home at / and /files, and /files/<path> for a file", () => {
  expect(parseFilesRoute("/")).toEqual({ path: null });
  expect(parseFilesRoute("/files")).toEqual({ path: null });
  expect(parseFilesRoute("/files/src/a%20b.ts")).toEqual({ path: "src/a b.ts" });
  expect(parseFilesRoute("/features/app/x")).toBeNull();
  expect(filesPath({ path: null })).toBe("/");
  expect(filesPath({ path: "src/a b.ts" })).toBe("/files/src/a%20b.ts");
  expect(parseFilesRoute(filesPath({ path: "docs/#1.md" }))).toEqual({ path: "docs/#1.md" });
  expect(baseName("src/lib/x.ts")).toBe("x.ts");
  expect(parentFolders("a/b/c.ts")).toEqual(["a", "a/b"]);
});

test("Markdown files get Markdown's highlighting, a file in no known language is plain text", () => {
  expect(languageOf("README.md")).toBe("markdown");
  expect(languageOf("docs/x.MARKDOWN")).toBe("markdown");
  expect(languageOf("LICENSE")).toBe(null);
});

// --- The store ----------------------------------------------------------------

type Call = { url: string; method: string; body?: Record<string, unknown> };

function fakeServer(files: Record<string, string>, dirs: Record<string, { name: string; path: string; kind: "dir" | "file" }[]>) {
  const calls: Call[] = [];
  let mtime = 1000;
  const times: Record<string, number> = Object.fromEntries(Object.keys(files).map((p) => [p, mtime]));
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://x");
    const path = url.searchParams.get("path") ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: `${url.pathname}?path=${path}`, method: init?.method ?? "GET", ...(body ? { body } : {}) });
    if (url.pathname === "/api/files/dir") {
      return dirs[path] ? respond(200, { path, entries: dirs[path] }) : respond(404, { error: `No folder at ${path}` });
    }
    if (url.pathname === "/api/files/file" && (init?.method ?? "GET") === "GET") {
      if (!(path in files)) return respond(404, { error: `No file at ${path}` });
      return respond(200, { path, content: files[path], mtimeMs: times[path], size: files[path]!.length, eol: files[path]!.includes("\r\n") ? "crlf" : "lf" });
    }
    if (url.pathname === "/api/files/file" && init?.method === "PUT") {
      if (body!.ifMtimeMs !== undefined && body!.ifMtimeMs !== times[path]) {
        return respond(409, { error: `${path} changed on disk`, mtimeMs: times[path] });
      }
      files[path] = String(body!.content);
      times[path] = ++mtime;
      return respond(200, { path, mtimeMs: times[path], size: files[path]!.length });
    }
    return respond(404, { error: "no route" });
  };
  /** Someone else writes the file. */
  const touch = (path: string, content: string) => {
    files[path] = content;
    times[path] = ++mtime;
  };
  return { fetchFn, calls, files, touch };
}

const TREE = {
  "": [
    { name: "src", path: "src", kind: "dir" as const },
    { name: "README.md", path: "README.md", kind: "file" as const },
  ],
  src: [{ name: "index.ts", path: "src/index.ts", kind: "file" as const }],
};

test("the store lists the top folder, and a folder when it is opened", async () => {
  const server = fakeServer({ "README.md": "# Hi\n" }, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  expect(store.getState().dirs[""]).toEqual({ entries: TREE[""] });
  expect(store.getState().dirs.src).toBeUndefined();
  await store.toggle("src");
  expect(store.getState().expanded).toEqual(["src"]);
  expect(store.getState().dirs.src).toEqual({ entries: TREE.src });
  await store.toggle("src");
  expect(store.getState().expanded).toEqual([]);
  // Opening a file deep in the tree opens the folders it sits in.
  await store.reveal("src/index.ts");
  expect(store.getState().expanded).toEqual(["src"]);
  expect(readmeOf(store.getState())).toBe("README.md");
});

test("a file opens, saves what changed with its time and line endings, and nothing else", async () => {
  const server = fakeServer({ "src/index.ts": "a\r\nb\r\n" }, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  await store.open("src/index.ts");
  const open = store.getState().open!;
  expect(open.status).toBe("ready");
  // The editor's own line breaks; the file's go back on save.
  expect(open.content).toBe("a\nb\n");
  expect(open.eol).toBe("crlf");
  await store.save();
  expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
  store.edit("a\nb\nc\n");
  expect(isDirty(store.getState().open)).toBe(true);
  expect(saveStatus(store.getState().open!)).toBe("Unsaved");
  await store.save();
  const put = server.calls.find((c) => c.method === "PUT")!;
  expect(put.body).toEqual({ content: "a\nb\nc\n", eol: "crlf", ifMtimeMs: 1000 });
  expect(isDirty(store.getState().open)).toBe(false);
  expect(saveStatus(store.getState().open!)).toBe("Saved");
});

test("a file changed on disk is not overwritten until the user says so", async () => {
  const server = fakeServer({ "README.md": "one\n" }, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  await store.open("README.md");
  store.edit("mine\n");
  server.touch("README.md", "theirs\n");
  await store.save();
  expect(store.getState().open!.conflict).toBe(true);
  expect(saveStatus(store.getState().open!)).toBe("Changed on disk");
  expect(server.files["README.md"]).toBe("theirs\n");
  // Autosave waits for the user's choice.
  await store.save();
  expect(server.files["README.md"]).toBe("theirs\n");
  // "Save over it": no time handed back.
  await store.save({ force: true });
  expect(server.files["README.md"]).toBe("mine\n");
  expect(store.getState().open!.conflict).toBe(false);
  expect(server.calls.filter((c) => c.method === "PUT").at(-1)!.body!.ifMtimeMs).toBeUndefined();
});

test("Reload from disk drops the editor's text for the file as it is", async () => {
  const server = fakeServer({ "README.md": "one\n" }, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  await store.open("README.md");
  store.edit("mine\n");
  server.touch("README.md", "theirs\n");
  await store.save();
  await store.reload();
  expect(store.getState().open).toMatchObject({ content: "theirs\n", saved: "theirs\n", conflict: false });
});

test("opening another file saves the one it replaces; leaving saves it too", async () => {
  const server = fakeServer({ "README.md": "one\n", "src/index.ts": "x\n" }, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  await store.open("README.md");
  store.edit("two\n");
  await store.open("src/index.ts");
  expect(server.files["README.md"]).toBe("two\n");
  expect(store.getState().open!.path).toBe("src/index.ts");
  store.edit("y\n");
  // A late close of the old file leaves the new one open.
  await store.close("README.md");
  expect(store.getState().open!.path).toBe("src/index.ts");
  await store.close("src/index.ts");
  expect(server.files["src/index.ts"]).toBe("y\n");
  expect(store.getState().open).toBeNull();
});

test("a file the server will not show as text says why", async () => {
  const server = fakeServer({}, TREE);
  const store = createFilesStore(server.fetchFn);
  await store.configure("/code");
  await store.open("logo.png");
  expect(store.getState().open).toMatchObject({ status: "error", error: "No file at logo.png", errorStatus: 404 });
  expect(saveStatus(store.getState().open!)).toBe("");
});

// --- Markup -------------------------------------------------------------------

const state = (over: Partial<FilesState> = {}): FilesState => ({
  root: "/code",
  dirs: { "": { entries: TREE[""] }, src: { entries: TREE.src } },
  expanded: ["src"],
  open: null,
  ...over,
});

test("the tree is treeitems, folders opening in place, files linking to their url, depth by level", () => {
  const html = renderToStaticMarkup(<>{treeRows(state(), "src/index.ts", { toggle: async () => {} }, () => {})}</>);
  expect(html).toContain('aria-level="1"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/files/src/index.ts"');
  expect(html).toContain('aria-level="2"');
  expect(html).toContain('aria-current="page"');
  expect(html.indexOf(">src<")).toBeLessThan(html.indexOf(">README.md<"));
  const closed = renderToStaticMarkup(<>{treeRows(state({ expanded: [] }), null, { toggle: async () => {} }, () => {})}</>);
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain("index.ts");
});

test("a folder that cannot be read says why, and an empty repository says so", () => {
  const broken = renderToStaticMarkup(
    <>{treeRows(state({ dirs: { "": { error: "No folder at the repository's top" } } }), null, { toggle: async () => {} }, () => {})}</>,
  );
  expect(broken).toContain("No folder at the repository");
  const empty = renderToStaticMarkup(<>{treeRows(state({ dirs: { "": { entries: [] } } }), null, { toggle: async () => {} }, () => {})}</>);
  expect(empty).toContain("No files");
});

test("the pane's header names the file's folders and offers Open in IntelliJ", () => {
  const crumb = { label: "code", href: "/" };
  const html = renderToStaticMarkup(<FilesPane path="src/lib/x.ts" repoCrumb={crumb} autosaveSeconds={6} canOpenInIdea />);
  expect(html).toContain(">code<");
  expect(html).toContain(">lib<");
  expect(html).toContain(">x.ts<");
  expect(html).toContain("Open in IntelliJ");
  const none = renderToStaticMarkup(<FilesPane path="src/lib/x.ts" repoCrumb={crumb} autosaveSeconds={6} canOpenInIdea={false} />);
  expect(none).not.toContain("Open in IntelliJ");
  const home = renderToStaticMarkup(<FilesPane path={null} repoCrumb={crumb} autosaveSeconds={6} canOpenInIdea />);
  expect(home).toContain("Pick a file");
});

test("the status words follow the file's state", () => {
  const base: OpenFile = {
    path: "a",
    status: "ready",
    content: "x",
    saved: "x",
    mtimeMs: 1,
    eol: "lf",
    saving: false,
    error: null,
    errorStatus: null,
    conflict: false,
  };
  expect(saveStatus({ ...base, status: "loading" })).toBe("Opening…");
  expect(saveStatus({ ...base, saving: true })).toBe("Saving…");
  expect(saveStatus({ ...base, error: "disk full" })).toBe("Not saved");
  expect(saveStatus(base)).toBe("Saved");
});

// --- The loader ---------------------------------------------------------------

test("an open code repository mounts the Files tab and none of the specification modules", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })) as unknown as typeof fetch;
  const quiet = console.error;
  console.error = () => {};
  try {
    await syncClientPlugins([{ id: "tests", enabled: true }], { demo: false, codeRepo: "/code" });
    expect(tabs.list().map((t) => t.id)).toEqual(["files"]);
    expect(matchPluginRoute("/files/src/x.ts")).toEqual({ tab: tabs.get("files")!, view: { path: "src/x.ts" } });
    // The state payload names it as well as the config.
    await syncClientPlugins([{ id: "tests", enabled: true }], {
      demo: false,
      settings: { codeRepoMode: true, codeRepoDir: "/code" },
    });
    expect(tabs.list().map((t) => t.id)).toEqual(["files"]);
    // A specifications folder: the modules come back, the Files tab goes.
    await syncClientPlugins([{ id: "tests", enabled: true }], { demo: false, settings: { codeRepoMode: false } });
    expect(tabs.list().map((t) => t.id)).toEqual(["tests"]);
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
  }
});

test("the tab's home opens the README when the repository has one; search finds loaded files", () => {
  expect(filesTab.route.resolve!({ path: "docs/a.md" })).toEqual({ path: "docs/a.md" });
  expect(searchFiles("")).toEqual([]);
});
