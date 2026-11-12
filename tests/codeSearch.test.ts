// Automates specs/app/code-search.feature.md on the server: the repository's
// file list (git's, and the walk that stands in for it without git), the
// search by name, and the search of the files' text — /api/files/find and
// /api/files/search over the open code repository, and nothing outside it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import {
  compileSearch,
  findFiles,
  forgetRepoFiles,
  gitRepoFiles,
  matchLines,
  searchRepo,
  walkRepoFiles,
  type FileMatches,
  type SearchSummary,
} from "../src/server/codeSearch";
import { FilesError, MAX_FILE_BYTES, SNIFF_BYTES } from "../src/server/files";
import { run } from "../src/server/run";
import { writeState } from "../src/server/state";

let root: string;
let code: string;
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-search-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  // Not a git repository: the list is the walk's, by the .gitignore files.
  code = join(root, "code");
  await mkdir(join(code, "src", "server"), { recursive: true });
  await mkdir(join(code, "docs", "deep", "er"), { recursive: true });
  await mkdir(join(code, "node_modules", "dep"), { recursive: true });
  await mkdir(join(code, ".git"), { recursive: true });
  await writeFile(join(code, ".git", "config"), "greeting = hello\n");
  await writeFile(join(code, ".gitignore"), "node_modules/\n*.log\n");
  await writeFile(join(code, "README.md"), "# Code\n\nSay hello to the world.\n");
  await writeFile(join(code, "src", "index.ts"), 'export const greeting = "Hello";\n\n  function helloWorld() {}\n');
  await writeFile(join(code, "src", "server", "api.ts"), "// say hello, then HELLO\nexport {};\n");
  await writeFile(join(code, "docs", "deep", "er", "notes.txt"), "nothing here\n");
  await writeFile(join(code, "debug.log"), "hello from the log\n");
  await writeFile(join(code, "node_modules", "dep", "index.js"), "hello from a dependency\n");
  await writeState({ openCodeRepo: code, reloadFrequencySeconds: 0 }, root);
  forgetRepoFiles();
});

afterEach(async () => {
  reloader.stop();
  forgetRepoFiles();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string): Promise<Response> {
  return handleApi(new Request(`http://localhost${path}`)) as Promise<Response>;
}

/** Run a text search through the route: the file lines, then the last line. */
async function search(query: string, flags = ""): Promise<{ files: FileMatches[]; end: SearchSummary & { done: true } }> {
  const res = await api(`/api/files/search?q=${encodeURIComponent(query)}${flags}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const end = lines.pop() as unknown as SearchSummary & { done: true };
  return { files: lines as unknown as FileMatches[], end };
}

const paths = (files: FileMatches[]) => files.map((f) => f.path);

// --- Routes -------------------------------------------------------------------

test("the search routes are registered, for reading only", () => {
  expect(matchApi("GET", "/api/files/find")).not.toBeNull();
  expect(matchApi("GET", "/api/files/search")).not.toBeNull();
  expect(matchApi("POST", "/api/files/find")).toBeNull();
  expect(matchApi("POST", "/api/files/search")).toBeNull();
});

test("outside code repository mode there is nothing to search", async () => {
  await writeState({ dataRepo: join(root, "data") }, root);
  expect((await api("/api/files/find?q=api")).status).toBe(409);
  expect((await api("/api/files/search?q=hello")).status).toBe(409);
});

// --- Which files there are ------------------------------------------------------

test("without git the list is every file but .git and what the .gitignore files exclude", async () => {
  expect(await gitRepoFiles(code)).toBeNull();
  expect(await walkRepoFiles(code)).toEqual([
    ".gitignore",
    "README.md",
    "docs/deep/er/notes.txt",
    "src/index.ts",
    "src/server/api.ts",
  ]);
});

test("a folder's own .gitignore adds to the ones above it, and can take a file back", async () => {
  await mkdir(join(code, "src", "gen"), { recursive: true });
  await writeFile(join(code, "src", ".gitignore"), "gen/\n!keep.log\n");
  await writeFile(join(code, "src", "gen", "out.ts"), "");
  await writeFile(join(code, "src", "keep.log"), "");
  await writeFile(join(code, "src", "drop.log"), "");
  const files = await walkRepoFiles(code);
  expect(files).toContain("src/keep.log");
  expect(files).not.toContain("src/drop.log");
  expect(files).not.toContain("src/gen/out.ts");
  expect(files).not.toContain("debug.log");
});

test("in a git repository the list is git's own, tracked files and untracked ones that are not ignored", async () => {
  const repo = join(root, "repo");
  await mkdir(join(repo, "build"), { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  await git("init", "-q");
  await writeFile(join(repo, ".gitignore"), "build/\n*.log\n");
  await writeFile(join(repo, "kept.log"), "");
  await writeFile(join(repo, "app.log"), "");
  await writeFile(join(repo, "build", "out.js"), "");
  await writeFile(join(repo, "new.ts"), "");
  await git("add", "-f", "kept.log", ".gitignore");
  await git("commit", "-q", "-m", "first");
  expect(await gitRepoFiles(repo)).toEqual([".gitignore", "kept.log", "new.ts"]);
});

// --- Find a file by name --------------------------------------------------------

test("a file is found by part of its name, in a folder the tree never listed", async () => {
  const res = await api("/api/files/find?q=notes");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { query: string; total: number; results: { path: string; name: string; indexes: number[] }[] };
  expect(body.query).toBe("notes");
  expect(body.results.map((r) => r.path)).toEqual(["docs/deep/er/notes.txt"]);
  expect(body.results[0]!.name).toBe("notes.txt");
  // The matched characters, as places in the path.
  expect(body.results[0]!.indexes.map((i) => "docs/deep/er/notes.txt"[i]).join("")).toBe("notes");
});

test("the typed characters need only be in order, and a hit in the name comes before one in the folders", async () => {
  await mkdir(join(code, "api"), { recursive: true });
  await writeFile(join(code, "api", "zebra.ts"), "");
  const fuzzy = await findFiles(code, "sapi");
  expect(fuzzy.results[0]!.path).toBe("src/server/api.ts");
  const named = await findFiles(code, "api");
  expect(named.results.map((r) => r.path)).toEqual(["src/server/api.ts", "api/zebra.ts"]);
  const folder = await findFiles(code, "server/api");
  expect(folder.results.map((r) => r.path)).toEqual(["src/server/api.ts"]);
});

test("an ignored file is never found by name, and nothing typed finds nothing", async () => {
  expect((await findFiles(code, "debug")).results).toEqual([]);
  expect((await findFiles(code, "index.js")).results.map((r) => r.path)).not.toContain("node_modules/dep/index.js");
  expect(await findFiles(code, "  ")).toEqual({ results: [], total: 0 });
  expect(await ((await api("/api/files/find?q=")).json())).toEqual({ query: "", results: [], total: 0 });
});

test("a file made after the list was read is found once the list is read again", async () => {
  expect((await findFiles(code, "fresh")).results).toEqual([]);
  await writeFile(join(code, "src", "fresh.ts"), "");
  // Within a few seconds the kept list answers.
  expect((await findFiles(code, "fresh")).results).toEqual([]);
  forgetRepoFiles();
  expect((await findFiles(code, "fresh")).results.map((r) => r.path)).toEqual(["src/fresh.ts"]);
});

// --- Find text ------------------------------------------------------------------

test("a search streams each file with its matches in path order, then the totals", async () => {
  const { files, end } = await search("hello");
  expect(paths(files)).toEqual(["README.md", "src/index.ts", "src/server/api.ts"]);
  expect(files[0]!.matches).toEqual([{ line: 3, col: 5, length: 5, text: "Say hello to the world.", start: 4, end: 9 }]);
  // Upper and lower case are the same unless asked; the line loses its indent.
  expect(files[1]!.matches.map((m) => [m.line, m.col, m.text.slice(m.start, m.end)])).toEqual([
    [1, 26, "Hello"],
    [3, 12, "hello"],
  ]);
  expect(files[1]!.matches[1]!.text).toBe("function helloWorld() {}");
  expect(files[2]!.matches.map((m) => m.col)).toEqual([8, 20]);
  expect(end).toMatchObject({ done: true, files: 3, matches: 5, scanned: 5, truncated: false });
});

test("match case, whole word and regular expression narrow the search", async () => {
  expect(paths((await search("Hello", "&case=1")).files)).toEqual(["src/index.ts"]);
  // `helloWorld` is not the word hello.
  const words = await search("hello", "&word=1");
  expect(words.files.find((f) => f.path === "src/index.ts")!.matches.map((m) => m.line)).toEqual([1]);
  const pattern = await search("hello\\w+\\(", "&regex=1&case=1");
  expect(paths(pattern.files)).toEqual(["src/index.ts"]);
  expect(pattern.files[0]!.matches[0]).toMatchObject({ line: 3, col: 12, length: 11 });
  // Without the switch the same characters are looked for as they are.
  expect((await search("hello\\w+\\(")).files).toEqual([]);
  expect((await search("a.i")).files).toEqual([]);
});

test("ignored files, git's folder, binary files, files too large to open and links are not searched", async () => {
  await writeFile(join(code, "image.bin"), Buffer.concat([Buffer.from("hello"), Buffer.from([0, 1, 2])]));
  await writeFile(join(code, "latin1.txt"), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0x0a]));
  await writeFile(join(code, "huge.txt"), "hello\n" + "x".repeat(MAX_FILE_BYTES));
  await symlink(join(code, "README.md"), join(code, "link.md"));
  // Binary is told by a file's start, as the editor tells it: a NUL byte
  // further in leaves the file text.
  await writeFile(join(code, "late.txt"), `hello\n${"x".repeat(SNIFF_BYTES)}\0`);
  forgetRepoFiles();
  const { files, end } = await search("hello");
  expect(paths(files)).toEqual(["README.md", "late.txt", "src/index.ts", "src/server/api.ts"]);
  // The others were looked at, and passed over.
  expect(end.scanned).toBe(10);
});

test("a search that cannot run is refused before anything is streamed", async () => {
  const bad = await api(`/api/files/search?q=${encodeURIComponent("hello(")}&regex=1`);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("Not a regular expression");
  expect((await api("/api/files/search?q=")).status).toBe(400);
  expect(() => compileSearch({ query: "" })).toThrow(FilesError);
  // The same characters as plain text are fine.
  expect((await api(`/api/files/search?q=${encodeURIComponent("hello(")}`)).status).toBe(200);
});

test("the search stops at its limits and says there may be more", async () => {
  await writeFile(join(code, "many.txt"), "hello\n".repeat(150));
  forgetRepoFiles();
  const got: FileMatches[] = [];
  // A file lists its first hundred matches.
  const all = await searchRepo(code, { query: "hello" }, (f) => got.push(f));
  const many = got.find((f) => f.path === "many.txt")!;
  expect(many.matches).toHaveLength(100);
  expect(many.more).toBe(true);
  expect(all.truncated).toBe(false);
  // A limit on matches cuts the file that crosses it, and ends the search.
  got.length = 0;
  const few = await searchRepo(code, { query: "hello", maxMatches: 3 }, (f) => got.push(f));
  expect(got.map((f) => [f.path, f.matches.length])).toEqual([
    ["README.md", 1],
    ["many.txt", 2],
  ]);
  expect(few).toMatchObject({ files: 2, matches: 3, truncated: true });
  // ...and so does a limit on files.
  got.length = 0;
  const one = await searchRepo(code, { query: "hello", maxFiles: 1 }, (f) => got.push(f));
  expect(paths(got)).toEqual(["README.md"]);
  expect(one).toMatchObject({ files: 1, truncated: true });
});

test("a search stops when its reader goes away", async () => {
  for (let i = 0; i < 200; i++) await writeFile(join(code, "docs", `page${String(i).padStart(3, "0")}.md`), "hello\n");
  forgetRepoFiles();
  const abort = new AbortController();
  const got: FileMatches[] = [];
  const summary = await searchRepo(
    code,
    { query: "hello" },
    (f) => {
      got.push(f);
      abort.abort();
    },
    abort.signal,
  );
  expect(got).toHaveLength(1);
  expect(summary.scanned).toBeLessThan(205);
});

test("a long line is shortened around its match, and Windows line ends are not part of it", () => {
  const { pattern } = compileSearch({ query: "needle" });
  const long = `${"a".repeat(300)} needle ${"b".repeat(300)}\r\nsecond needle\r\n`;
  const { matches, more } = matchLines(long, pattern);
  expect(more).toBe(false);
  expect(matches.map((m) => [m.line, m.col])).toEqual([
    [1, 302],
    [2, 8],
  ]);
  const first = matches[0]!;
  expect(first.text.startsWith("…")).toBe(true);
  expect(first.text.endsWith("…")).toBe(true);
  expect(first.text.length).toBeLessThanOrEqual(202);
  expect(first.text.slice(first.start, first.end)).toBe("needle");
  expect(matches[1]!.text).toBe("second needle");
});
