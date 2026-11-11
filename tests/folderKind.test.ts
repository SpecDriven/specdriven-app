// Automates specs/ui/app-start.feature.md "one field opens a specification
// folder or a code repository" on the server: what kind of folder a path
// names (src/server/folderKind.ts), the route the first-run screen asks
// (POST /api/folder-kind), and the two folders a specification folder is
// given once the user says it is one (PUT /api/state initSpecFolder).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { BUILD_FILES, buildToolAmong, expandHome, folderKind, initSpecFolder } from "../src/server/folderKind";
import { readState, writeState } from "../src/server/state";

let root: string;
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};

beforeEach(async () => {
  // realpath: macOS hands out /var/… for /private/var/….
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-folderkind-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  await writeState({ reloadFrequencySeconds: 0 }, root);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A folder under the test root holding `entries` — a trailing "/" makes a folder. */
async function folder(name: string, entries: string[] = []): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const entry of entries) {
    if (entry.endsWith("/")) await mkdir(join(dir, entry), { recursive: true });
    else await writeFile(join(dir, entry), "");
  }
  return dir;
}

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

// --- Telling the kinds apart ----------------------------------------------------

test("a folder with .specdriven and specs inside is a specification folder", async () => {
  const dir = await folder("acme", [".specdriven/", "specs/", "README.md"]);
  expect(await folderKind(dir, root)).toEqual({ kind: "spec", open: dir, path: dir, name: "acme" });
});

test("a specification folder that also holds a build file is still a specification folder", async () => {
  const dir = await folder("acme", [".specdriven/", "specs/", "package.json"]);
  expect((await folderKind(dir, root)).kind).toBe("spec");
});

test("one of the two folders alone does not make a specification folder", async () => {
  expect((await folderKind(await folder("only-specs", ["specs/", "notes.md"]), root)).kind).toBe("unknown");
  expect((await folderKind(await folder("only-data", [".specdriven/", "notes.md"]), root)).kind).toBe("unknown");
});

test("a folder with a well-known build tool's file is a code repository, named by the tool", async () => {
  const cases: Array<[file: string, tool: string]> = [
    ["pom.xml", "Maven"],
    ["package.json", "npm"],
    ["build.gradle.kts", "Gradle"],
    ["Cargo.toml", "Cargo"],
    ["go.mod", "Go"],
    ["pyproject.toml", "Python"],
    ["Makefile", "Make"],
    ["App.sln", ".NET"],
  ];
  for (const [file, tool] of cases) {
    const dir = await folder(`code-${file}`, [file, "src/"]);
    expect(await folderKind(dir, root)).toEqual({
      kind: "code",
      open: dir,
      path: dir,
      name: `code-${file}`,
      buildTool: tool,
    });
  }
});

test("a code repository's specs link does not make it a specification folder", async () => {
  const specs = await folder("acme-specs", [".specdriven/", "specs/"]);
  // The app's own checkout: a settings folder, a build file, and the link.
  const dir = await folder("acme-app", [".specdriven/", "package.json"]);
  await symlink(join(specs, "specs"), join(dir, "specs"));
  expect((await folderKind(dir, root)).kind).toBe("code");
  // With no build file either, it is not guessed to be specifications.
  const bare = await folder("acme-docs", [".specdriven/"]);
  await symlink(join(specs, "specs"), join(bare, "specs"));
  expect((await folderKind(bare, root)).kind).toBe("unknown");
});

test("an empty folder named specs-… is asked about; git's own folder does not make it non-empty", async () => {
  expect((await folderKind(await folder("specs-billing"), root)).kind).toBe("empty-specs");
  expect((await folderKind(await folder("specs-cloned", [".git/", ".DS_Store"]), root)).kind).toBe("empty-specs");
});

test("an empty folder with another name, and a specs-… folder with files, cannot be told", async () => {
  expect((await folderKind(await folder("billing"), root)).kind).toBe("unknown");
  expect((await folderKind(await folder("specs-notes", ["notes.md"]), root)).kind).toBe("unknown");
});

test("a missing path and a file are reported as such", async () => {
  const missing = join(root, "nope");
  expect(await folderKind(missing, root)).toEqual({ kind: "missing", open: missing, path: missing, name: "nope" });
  const file = join(root, "notes.txt");
  await writeFile(file, "hello\n");
  expect((await folderKind(file, root)).kind).toBe("not-a-folder");
});

test("a repository url is a url, whatever is on disk", async () => {
  const url = "https://github.com/acme/specs-billing";
  expect(await folderKind(` ${url} `, root)).toEqual({ kind: "url", open: url, path: url, name: url });
  expect((await folderKind("https://gitlab.example.com/acme/specs.git", root)).kind).toBe("url");
});

test("a relative path is read against the app's folder, and ~ is the home folder", async () => {
  await folder("rel", ["pom.xml"]);
  expect(await folderKind("rel", root)).toMatchObject({ kind: "code", open: "rel", path: join(root, "rel") });
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("~/work/specs-a")).toBe(join(homedir(), "work/specs-a"));
  expect(expandHome("/tmp/~/x")).toBe("/tmp/~/x");
  expect(await folderKind("~/no-such-folder-specdriven-test", root)).toMatchObject({
    kind: "missing",
    open: join(homedir(), "no-such-folder-specdriven-test"),
  });
});

test("the build files name each tool, exact names before project-named ones", () => {
  expect(buildToolAmong(["README.md", "src"])).toBeNull();
  expect(buildToolAmong(["Acme.csproj", "pom.xml"])).toBe("Maven");
  expect(buildToolAmong(["Acme.xcodeproj"])).toBe("Xcode");
  expect(new Set(BUILD_FILES.map(([file]) => file)).size).toBe(BUILD_FILES.length);
});

// --- Setting one up -------------------------------------------------------------

test("initSpecFolder adds .specdriven and specs, leaving what is there", async () => {
  const dir = await folder("specs-billing", ["specs/", "specs/a.feature.md"]);
  await initSpecFolder(dir);
  await initSpecFolder(dir);
  expect((await readdir(dir)).sort()).toEqual([".specdriven", "specs"]);
  expect(await readdir(join(dir, "specs"))).toEqual(["a.feature.md"]);
  expect((await folderKind(dir, root)).kind).toBe("spec");
});

// --- The routes -----------------------------------------------------------------

test("POST /api/folder-kind answers the kind of the folder at a path", async () => {
  const dir = await folder("shop", ["pom.xml"]);
  const res = await api("/api/folder-kind", "POST", { path: dir });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ kind: "code", open: dir, path: dir, name: "shop", buildTool: "Maven" });
  expect((await api("/api/folder-kind", "POST", { path: "  " })).status).toBe(400);
  expect((await api("/api/folder-kind", "POST", {})).status).toBe(400);
});

test("the demo and the hosted app tell no folder's kind", async () => {
  const dir = await folder("shop", ["pom.xml"]);
  process.env.DEMO_MODE = "1";
  expect((await api("/api/folder-kind", "POST", { path: dir })).status).toBe(403);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await api("/api/folder-kind", "POST", { path: dir })).status).toBe(403);
});

test("PUT /api/state initSpecFolder sets up the picked folder and opens it as specifications", async () => {
  const dir = await folder("specs-billing");
  const res = await api("/api/state", "PUT", { dataRepo: dir, initSpecFolder: true });
  expect(res.status).toBe(200);
  expect((await stat(join(dir, ".specdriven"))).isDirectory()).toBe(true);
  expect((await stat(join(dir, "specs"))).isDirectory()).toBe(true);
  expect((await readState(root)).dataRepo).toBe(dir);
  expect((await folderKind(dir, root)).kind).toBe("spec");
});

test("a folder made on request starts as a specification folder", async () => {
  const fresh = join(root, "new", "specs-claims");
  const made = await api("/api/state", "PUT", { dataRepo: fresh, createDataRepo: true, initSpecFolder: true });
  expect(made.status).toBe(200);
  expect((await folderKind(fresh, root)).kind).toBe("spec");
});

test("initSpecFolder makes nothing at a path that names no folder", async () => {
  const missing = join(root, "typo");
  const res = await api("/api/state", "PUT", { dataRepo: missing, initSpecFolder: true });
  expect(res.status).toBe(404);
  expect(await stat(missing).catch(() => null)).toBeNull();
});
