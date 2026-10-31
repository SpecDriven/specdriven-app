// specs/app/tasks.feature.md "Projects group tasks": the tasks' subfolders
// are projects — each a group of tasks with a page of its own, a
// `project.md` beside them holding the project's name, the member it is
// assigned to and what it is about. The page is never a task: it is left out
// of the task list, the folder's order and the counts.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { hasPageDoc } from "../src/server/automerge/store";
import { PAGE_ORDER_FILE, parseOrder } from "../src/server/pageOrder";
import { ROADMAP, isProjectPage } from "../src/server/pageFolders";
import {
  TASKS,
  createPage,
  createPageFolder,
  deletePage,
  deletePageFolder,
  ensureProjectPage,
  listPageFolders,
  listPages,
  listProjects,
  movePage,
  readPage,
  renamePageFile,
  renamePageFolder,
  savePage,
} from "../src/server/pages";
import { parsePage, serializePage } from "../src/server/parser";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { ROADMAP_TAB, TASKS_TAB, createPagesStore, isProjectPageOf } from "../src/frontend/pages/pages";
import type { PageListing, ProjectListing } from "../src/server/pages";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-task-projects-"));
});

afterEach(async () => {
  stopServers();
  await rm(root, { recursive: true, force: true });
});

const names = async (dir: string) => (await listPages(dir, TASKS)).map((p) => p.fileName);

/** Assign a page to a member, the way the "Assigned" chip does. */
async function assign(dir: string, fileName: string, member: string): Promise<void> {
  const text = await readFile(join(dir, fileName), "utf8");
  await savePage(dir, TASKS, fileName, serializePage({ ...parsePage(text), assigned: member }), text);
}

test("only a subfolder's project.md is a project's page", () => {
  expect(isProjectPage(TASKS, "tasks/launch/project.md")).toBe(true);
  expect(isProjectPage(TASKS, "tasks/launch/later/project.md")).toBe(true);
  // At the top of the folder it is an ordinary task, and elsewhere a page.
  expect(isProjectPage(TASKS, "tasks/project.md")).toBe(false);
  expect(isProjectPage(TASKS, "tasks/launch/plan.md")).toBe(false);
  expect(isProjectPage(ROADMAP, "roadmap/launch/project.md")).toBe(false);
  expect(isProjectPageOf(TASKS_TAB, "tasks/launch/project.md")).toBe(true);
  expect(isProjectPageOf(ROADMAP_TAB, "roadmap/launch/project.md")).toBe(false);
});

test("a new project starts with its page, which is not listed as a task", async () => {
  const dir = join(root, "data");
  await mkdir(join(dir, "tasks"), { recursive: true });
  expect(await createPageFolder(dir, TASKS, "Website Relaunch")).toBe("tasks/website-relaunch");
  // Headed with the name as typed, through its document like any page.
  expect(await readFile(join(dir, "tasks/website-relaunch/project.md"), "utf8")).toBe(
    "# Website Relaunch\n",
  );
  expect(await hasPageDoc(dir, "tasks/website-relaunch/project.md")).toBe(true);
  expect(await listProjects(dir, TASKS)).toEqual([
    { folder: "tasks/website-relaunch", name: "Website Relaunch", fileName: "tasks/website-relaunch/project.md" },
  ]);

  await createPage(dir, TASKS, "website-relaunch/Pick hosting");
  await createPage(dir, TASKS, "website-relaunch/Write copy");
  expect(await names(dir)).toEqual([
    "tasks/website-relaunch/pick-hosting.md",
    "tasks/website-relaunch/write-copy.md",
  ]);
  // The order names its tasks only.
  await movePage(dir, TASKS, "tasks/website-relaunch/write-copy.md", "tasks/website-relaunch", null);
  const order = parseOrder(await readFile(join(dir, "tasks/website-relaunch", PAGE_ORDER_FILE), "utf8"));
  expect(order).toEqual(["pick-hosting.md", "write-copy.md"]);
  // The roadmap's subfolders are folders, with no page of their own.
  await mkdir(join(dir, "roadmap"), { recursive: true });
  await createPageFolder(dir, ROADMAP, "Q3");
  expect(await Bun.file(join(dir, "roadmap/q3/project.md")).exists()).toBe(false);
  expect(await listProjects(dir, ROADMAP)).toEqual([]);
});

test("a project is assigned on its page, and the listing names its owner", async () => {
  const dir = join(root, "data");
  await mkdir(join(dir, "tasks"), { recursive: true });
  await createPageFolder(dir, TASKS, "Launch");
  await createPage(dir, TASKS, "launch/Ship it");
  await assign(dir, "tasks/launch/project.md", "Ada Lovelace");
  // A task in it keeps its own assignee, someone else's or nobody's.
  await assign(dir, "tasks/launch/ship-it.md", "Grace Hopper");

  expect(await readFile(join(dir, "tasks/launch/project.md"), "utf8")).toBe(
    "# Launch\n\n**Assigned:** Ada Lovelace\n",
  );
  expect(await listProjects(dir, TASKS)).toEqual([
    { folder: "tasks/launch", name: "Launch", assigned: "Ada Lovelace", fileName: "tasks/launch/project.md" },
  ]);
  expect((await listPages(dir, TASKS)).map((p) => [p.fileName, p.assigned])).toEqual([
    ["tasks/launch/ship-it.md", "Grace Hopper"],
  ]);
  expect((await readPage(dir, TASKS, "tasks/launch/project.md"))?.assigned).toBe("Ada Lovelace");
});

test("a project's page is not renamed, moved or deleted as a task, and no task takes its name", async () => {
  const dir = join(root, "data");
  await mkdir(join(dir, "tasks"), { recursive: true });
  await createPageFolder(dir, TASKS, "Launch");
  await createPage(dir, TASKS, "Plan");
  const page = "tasks/launch/project.md";

  await expect(createPage(dir, TASKS, "launch/Project")).rejects.toThrow("project's own page");
  await expect(renamePageFile(dir, TASKS, page, "Other")).rejects.toThrow("Rename the project instead");
  await expect(deletePage(dir, TASKS, page)).rejects.toThrow("Delete the project instead");
  await expect(movePage(dir, TASKS, page, "tasks")).rejects.toThrow("stays with its project");
  await expect(renamePageFile(dir, TASKS, "tasks/plan.md", "Project")).resolves.toMatchObject({
    fileName: "tasks/project.md",
  });
  // A top-level task named Project is a task — but cannot join a project.
  await expect(movePage(dir, TASKS, "tasks/project.md", "tasks/launch")).rejects.toThrow(
    "project's own page",
  );
  expect(await names(dir)).toEqual(["tasks/project.md"]);
});

test("renaming a project renames its folder and its heading, and deleting it counts only tasks", async () => {
  const { a, b } = await twoClones(root);
  await createPageFolder(a, TASKS, "Website Relaunch");
  await assign(a, "tasks/website-relaunch/project.md", "Ada Lovelace");
  await createPage(a, TASKS, "website-relaunch/Pick hosting");

  const renamed = await renamePageFolder(a, TASKS, "tasks/website-relaunch", "Site Relaunch");
  expect(renamed.path).toBe("tasks/site-relaunch");
  expect(renamed.message).toContain("pushed");
  // The heading follows, the owner and the tasks stay.
  expect(await listProjects(a, TASKS)).toEqual([
    { folder: "tasks/site-relaunch", name: "Site Relaunch", assigned: "Ada Lovelace", fileName: "tasks/site-relaunch/project.md" },
  ]);
  expect(await names(a)).toEqual(["tasks/site-relaunch/pick-hosting.md"]);

  // The same folder name in other words: only the heading changes.
  expect(await renamePageFolder(a, TASKS, "tasks/site-relaunch", "Site relaunch")).toEqual({
    path: "tasks/site-relaunch",
    message: "already named that",
  });
  expect((await listProjects(a, TASKS))[0]?.name).toBe("Site relaunch");

  const removed = await deletePageFolder(a, TASKS, "tasks/site-relaunch");
  expect(removed.pages).toBe(1);
  expect(await listProjects(a, TASKS)).toEqual([]);
  await git(b, "pull", "origin", "main");
  expect(await Bun.file(join(b, "tasks/site-relaunch/pick-hosting.md")).exists()).toBe(false);

  // A project holding no task is renamed and deleted on disk, for the sync
  // tick to commit, and counts none.
  await createPageFolder(a, TASKS, "Someday");
  expect((await renamePageFolder(a, TASKS, "tasks/someday", "Later")).message).toBe("renamed");
  expect(await readFile(join(a, "tasks/later/project.md"), "utf8")).toBe("# Later\n");
  expect(await deletePageFolder(a, TASKS, "tasks/later")).toEqual({ message: "folder deleted", pages: 0 });
});

test("a folder made before projects gets its page the first time it is opened", async () => {
  const dir = join(root, "data");
  await mkdir(join(dir, "tasks/next-sprint"), { recursive: true });
  await writeFile(join(dir, "tasks/next-sprint/ship.md"), "# Ship\n");
  expect(await listProjects(dir, TASKS)).toEqual([{ folder: "tasks/next-sprint", name: "Next Sprint" }]);

  expect(await ensureProjectPage(dir, TASKS, "tasks/next-sprint")).toBe("tasks/next-sprint/project.md");
  expect(await readFile(join(dir, "tasks/next-sprint/project.md"), "utf8")).toBe("# Next Sprint\n");
  // Opened again, the page is left as it is.
  await assign(dir, "tasks/next-sprint/project.md", "Ada Lovelace");
  await ensureProjectPage(dir, TASKS, "tasks/next-sprint");
  expect((await listProjects(dir, TASKS))[0]?.assigned).toBe("Ada Lovelace");

  await expect(ensureProjectPage(dir, TASKS, "tasks")).rejects.toThrow("name is required");
  await expect(ensureProjectPage(dir, TASKS, "tasks/missing")).rejects.toThrow("not found");
  await expect(ensureProjectPage(dir, ROADMAP, "roadmap/x")).rejects.toThrow("no projects");
  expect(await listPageFolders(dir, TASKS)).toEqual(["tasks/next-sprint"]);
});

test("the sidebar's project header follows its page's heading and owner", async () => {
  const realFetch = globalThis.fetch;
  const project: ProjectListing = { folder: "tasks/launch", name: "Launch", fileName: "tasks/launch/project.md" };
  const task: PageListing = { fileName: "tasks/launch/ship.md", name: "Ship" };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ pages: [task], folders: ["tasks/launch"], projects: [project] }))) as unknown as typeof fetch;
  try {
    const store = createPagesStore("tasks");
    await store.load();
    expect(store.state().projects).toEqual([project]);
    store.upsert({ fileName: "tasks/launch/project.md", name: "Launch v2", assigned: "Ada Lovelace" });
    expect(store.state().projects).toEqual([{ ...project, name: "Launch v2", assigned: "Ada Lovelace" }]);
    // The page is no row of its own.
    expect(store.state().pages).toEqual([task]);
    store.upsert({ fileName: "tasks/launch/project.md", name: "Launch v2" });
    expect(store.state().projects[0]?.assigned).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the tasks routes list projects and open a project's page", async () => {
  const home = await mkdtemp(join(tmpdir(), "specdriven-task-projects-home-"));
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
    await mkdir(join(data, "tasks/legacy"), { recursive: true });

    expect((await call("POST", "/api/tasks-folders", { path: "Launch" })).body).toEqual({
      path: "tasks/launch",
    });
    expect((await call("GET", "/api/tasks")).body.projects).toEqual([
      { folder: "tasks/launch", name: "Launch", fileName: "tasks/launch/project.md" },
      { folder: "tasks/legacy", name: "Legacy" },
    ]);
    const opened = await call("POST", `/api/tasks-folders/${encodeURIComponent("tasks/legacy")}/page`);
    expect(opened.body).toEqual({ fileName: "tasks/legacy/project.md" });
    const page = await call("GET", `/api/tasks/${encodeURIComponent("tasks/legacy/project.md")}`);
    expect(page.body).toMatchObject({ name: "Legacy", content: "# Legacy\n" });
    expect((await call("GET", "/api/tasks")).body.pages).toEqual([]);
    const missing = await call("POST", `/api/tasks-folders/${encodeURIComponent("tasks/nope")}/page`);
    expect(missing.status).toBe(400);
    expect((await call("DELETE", `/api/tasks/${encodeURIComponent("tasks/launch/project.md")}`)).status).toBe(400);
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
