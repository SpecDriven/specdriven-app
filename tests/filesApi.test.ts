// Automates specs/app/code-repo-mode.feature.md "The navigation pane lists
// the repository's files", "A file opens in a plain text editor" and "Open
// the file in IntelliJ IDEA" on the server: /api/files/* serve the open code
// repository's tree and files, and nothing outside it. IntelliJ is never
// found or started for real: the seams in src/server/idea.ts stand in.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import { gitIgnored, listDir, MAX_FILE_BYTES, repoPath, setIgnoreCheck, FilesError } from "../src/server/files";
import { IDEA_SYMLINK_HINT, ideaArgs, setIdeaAvailability, setIdeaOpener } from "../src/server/idea";
import { run } from "../src/server/run";
import { writeState } from "../src/server/state";

let root: string;
let code: string;
let opened: { file: string; line?: number }[];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-files-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  code = join(root, "code");
  await mkdir(join(code, "src", "lib"), { recursive: true });
  await mkdir(join(code, "node_modules", "dep"), { recursive: true });
  await mkdir(join(code, ".git"), { recursive: true });
  await writeFile(join(code, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(code, "README.md"), "# Code\n");
  await writeFile(join(code, ".gitignore"), "node_modules/\n");
  await writeFile(join(code, "src", "index.ts"), "export {};\n");
  await writeFile(join(code, "src", "file10.ts"), "");
  await writeFile(join(code, "src", "file2.ts"), "");
  await writeFile(join(code, "node_modules", "dep", "i.js"), "");
  await writeState({ openCodeRepo: code, reloadFrequencySeconds: 0 }, root);
  // The tree's ignore rules without a git repository: node_modules alone.
  setIgnoreCheck(async (_root, paths) => new Set(paths.filter((p) => p === "node_modules")));
  opened = [];
  setIdeaAvailability(() => true);
  setIdeaOpener(async (file, line) => {
    opened.push(line === undefined ? { file } : { file, line });
  });
});

afterEach(async () => {
  reloader.stop();
  setIgnoreCheck(null);
  setIdeaAvailability(null);
  setIdeaOpener(null);
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

const q = (path: string) => `?path=${encodeURIComponent(path)}`;

// --- Routes -------------------------------------------------------------------

test("the files routes are registered with their methods", () => {
  expect(matchApi("GET", "/api/files/dir")).not.toBeNull();
  expect(matchApi("GET", "/api/files/file")).not.toBeNull();
  expect(matchApi("PUT", "/api/files/file")).not.toBeNull();
  expect(matchApi("POST", "/api/files/open-in-idea")).not.toBeNull();
  expect(matchApi("DELETE", "/api/files/file")).toBeNull();
  expect(matchApi("GET", "/api/files/open-in-idea")).toBeNull();
});

test("outside code repository mode the files routes have no folder to serve", async () => {
  await writeState({ dataRepo: join(root, "data") }, root);
  for (const res of [
    await api(`/api/files/dir${q("")}`),
    await api(`/api/files/file${q("README.md")}`),
    await api(`/api/files/file${q("README.md")}`, "PUT", { content: "x" }),
    await api("/api/files/open-in-idea", "POST", { path: "README.md" }),
  ]) {
    expect(res.status).toBe(409);
  }
});

// --- Paths --------------------------------------------------------------------

test("a path that leaves the repository or names git's folder is refused", () => {
  for (const bad of ["..", "../x", "src/../../x", "/etc/passwd", "src//index.ts", "./src", "a\\b", "x\0y", ".git", ".git/HEAD", "src/.git"]) {
    expect(() => repoPath(code, bad)).toThrow(FilesError);
  }
  expect(repoPath(code, "")).toBe(code);
  expect(repoPath(code, "src/index.ts")).toBe(join(code, "src", "index.ts"));
  expect(repoPath(code, "src/")).toBe(join(code, "src"));
});

test("the routes refuse a path outside the repository with 400", async () => {
  expect((await api(`/api/files/dir${q("..")}`)).status).toBe(400);
  expect((await api(`/api/files/file${q("../code/README.md")}`)).status).toBe(400);
  expect((await api(`/api/files/file${q(".git/HEAD")}`, "PUT", { content: "x" })).status).toBe(400);
  expect(await readFile(join(code, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
});

// --- The tree -----------------------------------------------------------------

test("a folder lists folders first, in natural order, without .git or what is ignored", async () => {
  const res = await api(`/api/files/dir${q("")}`);
  expect(res.status).toBe(200);
  const top = (await res.json()) as { entries: { name: string; path: string; kind: string }[] };
  expect(top.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:src", "file:.gitignore", "file:README.md"]);
  const src = (await (await api(`/api/files/dir${q("src")}`)).json()) as { entries: { path: string }[] };
  expect(src.entries.map((e) => e.path)).toEqual(["src/lib", "src/file2.ts", "src/file10.ts", "src/index.ts"]);
});

test("a link is listed as what it points to", async () => {
  await symlink(join(code, "src"), join(code, "linked"));
  const entries = await listDir(code, "");
  expect(entries.find((e) => e.name === "linked")).toEqual({ name: "linked", path: "linked", kind: "dir", link: true });
});

test("a folder that is not there is 404, a file is not a folder", async () => {
  expect((await api(`/api/files/dir${q("nope")}`)).status).toBe(404);
  expect((await api(`/api/files/dir${q("README.md")}`)).status).toBe(400);
});

test("git check-ignore decides what a git repository ignores, tracked files excepted", async () => {
  const repo = join(root, "repo");
  await mkdir(join(repo, "build"), { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  await git("init", "-q");
  await writeFile(join(repo, ".gitignore"), "build/\n*.log\n");
  await writeFile(join(repo, "kept.log"), "");
  await writeFile(join(repo, "app.log"), "");
  await git("add", "-f", "kept.log", ".gitignore");
  await git("commit", "-q", "-m", "first");
  const ignored = await gitIgnored(repo, ["build", "app.log", "kept.log", ".gitignore"]);
  expect([...ignored].sort()).toEqual(["app.log", "build"]);
  // Outside a git repository nothing is ignored.
  expect((await gitIgnored(code, ["node_modules"])).size).toBe(0);
});

// --- Reading and saving -------------------------------------------------------

test("a file opens with its text, time and line endings", async () => {
  await writeFile(join(code, "win.txt"), "a\r\nb\r\n");
  const res = await api(`/api/files/file${q("win.txt")}`);
  expect(res.status).toBe(200);
  const file = (await res.json()) as { content: string; mtimeMs: number; size: number; eol: string };
  expect(file.content).toBe("a\r\nb\r\n");
  expect(file.eol).toBe("crlf");
  expect(file.size).toBe(6);
  expect(file.mtimeMs).toBe((await stat(join(code, "win.txt"))).mtimeMs);
});

test("a missing, binary, non-UTF-8 or too large file is not opened as text", async () => {
  await writeFile(join(code, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  await writeFile(join(code, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await writeFile(join(code, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  expect((await api(`/api/files/file${q("nope.ts")}`)).status).toBe(404);
  expect((await api(`/api/files/file${q("src")}`)).status).toBe(400);
  expect((await api(`/api/files/file${q("logo.png")}`)).status).toBe(415);
  expect((await api(`/api/files/file${q("latin1.txt")}`)).status).toBe(415);
  const big = await api(`/api/files/file${q("big.txt")}`);
  expect(big.status).toBe(413);
  expect(((await big.json()) as { size: number }).size).toBe(MAX_FILE_BYTES + 1);
});

test("a save writes the text in place, keeping the file's permissions", async () => {
  const script = join(code, "run.sh");
  await writeFile(script, "#!/bin/sh\n");
  await chmod(script, 0o755);
  const opened = (await (await api(`/api/files/file${q("run.sh")}`)).json()) as { mtimeMs: number };
  const res = await api(`/api/files/file${q("run.sh")}`, "PUT", {
    content: "#!/bin/sh\necho hi\n",
    ifMtimeMs: opened.mtimeMs,
  });
  expect(res.status).toBe(200);
  const saved = (await res.json()) as { mtimeMs: number; size: number };
  expect(await readFile(script, "utf8")).toBe("#!/bin/sh\necho hi\n");
  expect(saved.size).toBe(18);
  expect((await stat(script)).mode & 0o777).toBe(0o755);
});

test("a save keeps Windows line endings", async () => {
  await writeFile(join(code, "win.txt"), "a\r\nb\r\n");
  const res = await api(`/api/files/file${q("win.txt")}`, "PUT", { content: "a\nb\nc\n", eol: "crlf" });
  expect(res.status).toBe(200);
  expect(await readFile(join(code, "win.txt"), "utf8")).toBe("a\r\nb\r\nc\r\n");
});

test("a file changed on disk since it was opened is not overwritten", async () => {
  const file = join(code, "src", "index.ts");
  const opened = (await (await api(`/api/files/file${q("src/index.ts")}`)).json()) as { mtimeMs: number };
  await writeFile(file, "export const fromTheIde = 1;\n");
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const res = await api(`/api/files/file${q("src/index.ts")}`, "PUT", { content: "mine\n", ifMtimeMs: opened.mtimeMs });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string; mtimeMs: number };
  expect(body.error).toContain("changed on disk");
  expect(body.mtimeMs).toBe((await stat(file)).mtimeMs);
  expect(await readFile(file, "utf8")).toBe("export const fromTheIde = 1;\n");
  // "Save over it": no time, no check.
  expect((await api(`/api/files/file${q("src/index.ts")}`, "PUT", { content: "mine\n" })).status).toBe(200);
  expect(await readFile(file, "utf8")).toBe("mine\n");
});

test("a file deleted on disk since it was opened is not silently made again", async () => {
  const opened = (await (await api(`/api/files/file${q("README.md")}`)).json()) as { mtimeMs: number };
  await rm(join(code, "README.md"));
  const res = await api(`/api/files/file${q("README.md")}`, "PUT", { content: "x", ifMtimeMs: opened.mtimeMs });
  expect(res.status).toBe(409);
});

test("a save with no text is refused", async () => {
  expect((await api(`/api/files/file${q("README.md")}`, "PUT", {})).status).toBe(400);
  expect((await api(`/api/files/file${q("README.md")}`, "PUT", { content: "x", eol: "cr" })).status).toBe(400);
});

// --- IntelliJ -----------------------------------------------------------------

test("idea gets --line only when a line is given", () => {
  expect(ideaArgs("/r/a.ts", 12)).toEqual(["--line", "12", "/r/a.ts"]);
  expect(ideaArgs("/r/a.ts")).toEqual(["/r/a.ts"]);
});

test("Open in IntelliJ runs idea on the file, at the cursor's line", async () => {
  const res = await api("/api/files/open-in-idea", "POST", { path: "src/index.ts", line: 3 });
  expect(res.status).toBe(200);
  expect(opened).toEqual([{ file: join(code, "src", "index.ts"), line: 3 }]);
  expect((await api("/api/files/open-in-idea", "POST", { path: "README.md" })).status).toBe(200);
  expect(opened[1]).toEqual({ file: join(code, "README.md") });
});

test("Open in IntelliJ works for a file the editor cannot show", async () => {
  await writeFile(join(code, "logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
  expect((await api("/api/files/open-in-idea", "POST", { path: "logo.png" })).status).toBe(200);
  expect(opened).toEqual([{ file: join(code, "logo.png") }]);
});

test("without idea on PATH the click is refused with the symlink to make", async () => {
  setIdeaAvailability(() => false);
  const res = await api("/api/files/open-in-idea", "POST", { path: "README.md" });
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string; hint: string };
  expect(body.error).toContain(IDEA_SYMLINK_HINT);
  expect(body.hint).toBe(IDEA_SYMLINK_HINT);
  expect(opened).toEqual([]);
});

test("Open in IntelliJ refuses a bad request before anything runs", async () => {
  expect((await api("/api/files/open-in-idea", "POST", {})).status).toBe(400);
  expect((await api("/api/files/open-in-idea", "POST", { path: "README.md", line: 0 })).status).toBe(400);
  expect((await api("/api/files/open-in-idea", "POST", { path: "../x" })).status).toBe(400);
  expect((await api("/api/files/open-in-idea", "POST", { path: "nope.ts" })).status).toBe(404);
  expect(opened).toEqual([]);
});

test("a launcher that fails to start is reported", async () => {
  setIdeaOpener(async () => {
    throw new Error("spawn idea ENOENT");
  });
  const res = await api("/api/files/open-in-idea", "POST", { path: "README.md" });
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("ENOENT");
});
