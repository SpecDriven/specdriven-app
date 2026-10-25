// specs/app/tasks.feature.md "Reorder tasks by dragging" and "Task folder
// menu": a tasks folder keeps its tasks in an order of its own — an
// `order.txt` beside them (src/server/pageOrder.ts) — that a drag, Move up,
// Move down and Move to folder… rewrite, and its subfolders get the ⋯ menu a
// Specs folder has: new task, new folder, rename, delete.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { hasPageDoc, pageDocDirRel } from "../src/server/automerge/store";
import { conflictedFiles } from "../src/server/git";
import {
  PAGE_ORDER_FILE,
  formatOrder,
  inOrder,
  isPageOrderFile,
  mergeOrder,
  parseOrder,
} from "../src/server/pageOrder";
import {
  ROADMAP,
  TASKS,
  createPage,
  createPageFolder,
  deletePage,
  deletePageFolder,
  listPageFolders,
  listPages,
  movePage,
  renamePageFile,
  renamePageFolder,
} from "../src/server/pages";
import { syncDataDir } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { dropPlacement, pageGroups, stepPlacement } from "../src/frontend/pages/pages";
import type { PageListing } from "../src/server/pages";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-task-order-"));
});

afterEach(async () => {
  stopServers();
  await rm(root, { recursive: true, force: true });
});

const names = async (dir: string) => (await listPages(dir, TASKS)).map((p) => p.fileName);
const orderOf = (dir: string, folder = "tasks") =>
  readFile(join(dir, folder, PAGE_ORDER_FILE), "utf8").then(parseOrder, () => null);

/** Three tasks at the top level, written by hand — nothing committed. */
async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "tasks"), { recursive: true });
  for (const name of ["Alpha", "Bravo", "Charlie"]) {
    await writeFile(join(dir, "tasks", `${name.toLowerCase()}.md`), `# ${name}\n`);
  }
}

test("an order file lists names once, in order, and merges without losing a task", () => {
  expect(parseOrder("b.md\n\na.md\nb.md\nsub/x.md\n")).toEqual(["b.md", "a.md"]);
  expect(formatOrder(["b.md", "a.md"])).toBe("b.md\na.md\n");
  expect(formatOrder([])).toBe("");
  // Named first as named, then the rest in name order; a stale name is skipped.
  expect(inOrder(["a.md", "b.md", "c.md", "d.md"], ["c.md", "gone.md", "a.md"])).toEqual([
    "c.md",
    "a.md",
    "b.md",
    "d.md",
  ]);
  expect(isPageOrderFile("tasks/order.txt")).toBe(true);
  expect(isPageOrderFile("tasks/sub/order.txt")).toBe(true);
  expect(isPageOrderFile("tasks/border.txt")).toBe(false);
  // A side that left the base takes the other's; else ours, plus theirs' new names.
  const base = "a.md\nb.md\n";
  expect(mergeOrder(base, base, "b.md\na.md\n")).toBe("b.md\na.md\n");
  expect(mergeOrder(base, "b.md\na.md\n", base)).toBe("b.md\na.md\n");
  expect(mergeOrder(base, "b.md\na.md\n", "a.md\nb.md\nc.md\n")).toBe("b.md\na.md\nc.md\n");
});

test("tasks list in name order until moved, and a move keeps its place", async () => {
  await seed(root);
  expect(await names(root)).toEqual(["tasks/alpha.md", "tasks/bravo.md", "tasks/charlie.md"]);

  // Charlie before Alpha: the top of the list.
  expect(await movePage(root, TASKS, "tasks/charlie.md", "tasks", "tasks/alpha.md")).toEqual({
    fileName: "tasks/charlie.md",
    message: "reordered",
  });
  expect(await names(root)).toEqual(["tasks/charlie.md", "tasks/alpha.md", "tasks/bravo.md"]);
  expect(await orderOf(root)).toEqual(["charlie.md", "alpha.md", "bravo.md"]);

  // No `before`: last.
  await movePage(root, TASKS, "tasks/charlie.md", "tasks", null);
  expect(await names(root)).toEqual(["tasks/alpha.md", "tasks/bravo.md", "tasks/charlie.md"]);

  // A task the order does not name yet — a teammate's, say — goes last.
  await writeFile(join(root, "tasks", "aardvark.md"), "# Aardvark\n");
  expect(await names(root)).toEqual([
    "tasks/alpha.md",
    "tasks/bravo.md",
    "tasks/charlie.md",
    "tasks/aardvark.md",
  ]);

  // Only an ordered folder's pages move, and only before a page of the folder.
  await expect(movePage(root, ROADMAP, "roadmap/x.md", "roadmap")).rejects.toThrow("name order");
  await expect(movePage(root, TASKS, "tasks/alpha.md", "tasks", "tasks/sub/x.md")).rejects.toThrow(
    "is not in tasks",
  );
  await expect(movePage(root, TASKS, "tasks/alpha.md", "tasks/nope")).rejects.toThrow(
    "Folder not found",
  );
  await expect(movePage(root, TASKS, "tasks/alpha.md", "../x")).rejects.toThrow("Invalid folder");
});

test("a renamed task keeps its place, and a deleted one leaves the order", async () => {
  const { a } = await twoClones(root);
  for (const name of ["Alpha", "Bravo", "Charlie"]) await createPage(a, TASKS, name);
  await movePage(a, TASKS, "tasks/charlie.md", "tasks", "tasks/alpha.md");

  const renamed = await renamePageFile(a, TASKS, "tasks/charlie.md", "Delta");
  expect(renamed.fileName).toBe("tasks/delta.md");
  expect(await names(a)).toEqual(["tasks/delta.md", "tasks/alpha.md", "tasks/bravo.md"]);

  await deletePage(a, TASKS, "tasks/alpha.md");
  expect(await orderOf(a)).toEqual(["delta.md", "bravo.md"]);
});

test("a task moved to another folder takes its document, and both orders follow", async () => {
  const { a, b } = await twoClones(root);
  for (const name of ["Alpha", "Bravo", "sub/Inner"]) await createPage(a, TASKS, name);
  await movePage(a, TASKS, "tasks/bravo.md", "tasks", "tasks/alpha.md");

  const moved = await movePage(a, TASKS, "tasks/bravo.md", "tasks/sub", "tasks/sub/inner.md");
  expect(moved.fileName).toBe("tasks/sub/bravo.md");
  expect(moved.message).toContain("pushed");
  expect(await names(a)).toEqual(["tasks/alpha.md", "tasks/sub/bravo.md", "tasks/sub/inner.md"]);
  expect(await orderOf(a)).toEqual(["alpha.md"]);
  expect(await orderOf(a, "tasks/sub")).toEqual(["bravo.md", "inner.md"]);
  expect(await hasPageDoc(a, "tasks/sub/bravo.md")).toBe(true);
  expect(await hasPageDoc(a, "tasks/bravo.md")).toBe(false);

  // The move itself is committed and pushed, like a rename.
  await git(b, "pull", "origin", "main");
  expect(await Bun.file(join(b, "tasks/sub/bravo.md")).exists()).toBe(true);
  expect(await Bun.file(join(b, "tasks/bravo.md")).exists()).toBe(false);

  await expect(movePage(a, TASKS, "tasks/alpha.md", "tasks/sub")).resolves.toMatchObject({
    fileName: "tasks/sub/alpha.md",
  });
  await createPage(a, TASKS, "Alpha");
  await expect(movePage(a, TASKS, "tasks/alpha.md", "tasks/sub")).rejects.toThrow("already exists");
});

test("a task folder is created empty, renamed with its tasks, and deleted with them", async () => {
  const { a, b } = await twoClones(root);
  expect(await createPageFolder(a, TASKS, "Next Sprint")).toBe("tasks/next-sprint");
  expect(await createPageFolder(a, TASKS, "tasks/next-sprint/Later")).toBe("tasks/next-sprint/later");
  expect(await listPageFolders(a, TASKS)).toEqual(["tasks/next-sprint", "tasks/next-sprint/later"]);
  await expect(createPageFolder(a, TASKS, "next-sprint")).rejects.toThrow("already exists");
  await expect(createPageFolder(a, TASKS, "  ")).rejects.toThrow("name is required");
  // Git keeps no empty folder, so it starts with an empty order file.
  expect(await readFile(join(a, "tasks/next-sprint", PAGE_ORDER_FILE), "utf8")).toBe("");

  // Empty: renamed on disk alone.
  expect(await renamePageFolder(a, TASKS, "tasks/next-sprint/later", "Someday")).toEqual({
    path: "tasks/next-sprint/someday",
    message: "renamed",
  });

  // With a task in it: a git mv of the folder and of the task's document.
  await createPage(a, TASKS, "next-sprint/Ship v2");
  const renamed = await renamePageFolder(a, TASKS, "tasks/next-sprint", "Sprint 12");
  expect(renamed.path).toBe("tasks/sprint-12");
  expect(renamed.message).toContain("pushed");
  expect(await names(a)).toEqual(["tasks/sprint-12/ship-v2.md"]);
  expect(await hasPageDoc(a, "tasks/sprint-12/ship-v2.md")).toBe(true);
  expect(await listPageFolders(a, TASKS)).toEqual(["tasks/sprint-12", "tasks/sprint-12/someday"]);
  await expect(renamePageFolder(a, TASKS, "tasks", "x")).rejects.toThrow("name is required");

  const removed = await deletePageFolder(a, TASKS, "tasks/sprint-12");
  expect(removed.pages).toBe(1);
  expect(await listPages(a, TASKS)).toEqual([]);
  expect(await listPageFolders(a, TASKS)).toEqual([]);
  expect(await Bun.file(join(a, pageDocDirRel("tasks/sprint-12/ship-v2.md"), "x")).exists()).toBe(false);
  await git(b, "pull", "origin", "main");
  expect(await Bun.file(join(b, "tasks/sprint-12/ship-v2.md")).exists()).toBe(false);
  await expect(deletePageFolder(a, TASKS, "tasks")).rejects.toThrow("name is required");
});

const ORDERED_SEED = {
  "tasks/alpha.md": "# Alpha\n",
  "tasks/bravo.md": "# Bravo\n",
  "tasks/charlie.md": "# Charlie\n",
  [`tasks/${PAGE_ORDER_FILE}`]: "alpha.md\nbravo.md\ncharlie.md\n",
};

test("two teammates reordering apart are both kept by git's own merge", async () => {
  const { a, b } = await twoClones(root, ORDERED_SEED);
  await movePage(a, TASKS, "tasks/charlie.md", "tasks", "tasks/alpha.md");
  await writeFile(join(b, "tasks", "delta.md"), "# Delta\n");
  await movePage(b, TASKS, "tasks/delta.md", "tasks", "tasks/bravo.md");
  await syncDataDir(a);
  // The first tick commits b's move, the second pulls a's and merges the two.
  await syncDataDir(b);
  await syncDataDir(b);
  expect(await conflictedFiles(b)).toEqual([]);
  expect(await orderOf(b)).toEqual(["charlie.md", "alpha.md", "delta.md", "bravo.md"]);
});

test("two teammates reordering the same spot merge on the next sync", async () => {
  const { a, b } = await twoClones(root, ORDERED_SEED);
  // Both put a task at the top, so git cannot merge the two on its own.
  await movePage(a, TASKS, "tasks/charlie.md", "tasks", "tasks/alpha.md");
  await writeFile(join(b, "tasks", "delta.md"), "# Delta\n");
  await movePage(b, TASKS, "tasks/delta.md", "tasks", "tasks/alpha.md");
  await syncDataDir(a);
  await syncDataDir(b);
  await syncDataDir(b);
  expect(await conflictedFiles(b)).toEqual([]);
  const merged = await readFile(join(b, "tasks", PAGE_ORDER_FILE), "utf8");
  expect(merged).not.toContain("<<<<<<<");
  // Ours stands, and no task drops out of the order.
  expect(parseOrder(merged)).toEqual(["delta.md", "alpha.md", "bravo.md", "charlie.md"]);
  await syncDataDir(a);
  expect(await readFile(join(a, "tasks", PAGE_ORDER_FILE), "utf8")).toBe(merged);
});

const listed = (...files: string[]): PageListing[] => files.map((fileName) => ({ fileName, name: fileName }));

test("a drop lands before the row's page or after it, and a drop in place moves nothing", () => {
  const group = listed("tasks/a.md", "tasks/b.md", "tasks/c.md");
  expect(dropPlacement(group, "tasks/c.md", "tasks/a.md", false)).toBe("tasks/a.md");
  expect(dropPlacement(group, "tasks/a.md", "tasks/c.md", true)).toBeNull();
  expect(dropPlacement(group, "tasks/a.md", "tasks/b.md", true)).toBe("tasks/c.md");
  // Where it already is: on itself, or on either edge of its neighbours.
  expect(dropPlacement(group, "tasks/b.md", "tasks/b.md", false)).toBeUndefined();
  expect(dropPlacement(group, "tasks/b.md", "tasks/a.md", true)).toBeUndefined();
  expect(dropPlacement(group, "tasks/b.md", "tasks/c.md", false)).toBeUndefined();
  // From another folder every edge is a move.
  expect(dropPlacement(group, "tasks/sub/x.md", "tasks/c.md", true)).toBeNull();
  expect(dropPlacement(group, "tasks/sub/x.md", "tasks/b.md", false)).toBe("tasks/b.md");
});

test("Move up and Move down step one place, and stop at either end", () => {
  const group = listed("tasks/a.md", "tasks/b.md", "tasks/c.md");
  expect(stepPlacement(group, "tasks/b.md", -1)).toBe("tasks/a.md");
  expect(stepPlacement(group, "tasks/a.md", 1)).toBe("tasks/c.md");
  expect(stepPlacement(group, "tasks/b.md", 1)).toBeNull();
  expect(stepPlacement(group, "tasks/a.md", -1)).toBeUndefined();
  expect(stepPlacement(group, "tasks/c.md", 1)).toBeUndefined();
});

test("the sidebar groups keep the listing's order and show empty folders", () => {
  const groups = pageGroups(listed("tasks/b.md", "tasks/a.md", "tasks/sub/z.md", "tasks/sub/y.md"), [
    "tasks/empty",
    "tasks/sub",
  ]);
  expect(groups.map((g) => [g.dir, g.pages.map((p) => p.fileName)])).toEqual([
    ["", ["tasks/b.md", "tasks/a.md"]],
    ["empty", []],
    ["sub", ["tasks/sub/z.md", "tasks/sub/y.md"]],
  ]);
});

test("the tasks routes list folders, move a task and manage a folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "specdriven-task-order-home-"));
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  const data = join(root, "data");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = (await handleApi(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    )) as Response;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    await writeState({ dataRepo: data, tasks: true }, root);
    await syncPlugins({ tasks: true });
    await seed(data);

    expect((await call("POST", "/api/tasks-folders", { path: "Later" })).body).toEqual({
      path: "tasks/later",
    });
    const moved = await call("POST", `/api/tasks/${encodeURIComponent("tasks/bravo.md")}/move`, {
      folder: "tasks",
      before: "tasks/alpha.md",
    });
    expect(moved.status).toBe(200);
    const list = await call("GET", "/api/tasks");
    expect((list.body.pages as PageListing[]).map((p) => p.fileName)).toEqual([
      "tasks/bravo.md",
      "tasks/alpha.md",
      "tasks/charlie.md",
    ]);
    expect(list.body.folders).toEqual(["tasks/later"]);
    expect((await call("POST", `/api/tasks/${encodeURIComponent("tasks/bravo.md")}/move`, {})).status).toBe(400);

    const renamed = await call("POST", `/api/tasks-folders/${encodeURIComponent("tasks/later")}/rename`, {
      name: "Someday",
    });
    expect(renamed.body.path).toBe("tasks/someday");
    expect((await call("DELETE", `/api/tasks-folders/${encodeURIComponent("tasks/someday")}`)).body).toEqual({
      message: "folder deleted",
      pages: 0,
    });
    expect((await call("GET", "/api/tasks")).body.folders).toEqual([]);
  } finally {
    reloader.stop();
    await syncPlugins({ tasks: false });
    await rm(home, { recursive: true, force: true });
    for (const [name, value] of [
      ["SPECDRIVEN_ROOT", realRoot],
      ["SPECDRIVEN_HOME", realHome],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
