// specs/app/tasks.feature.md: the data repo's `tasks` folder — a simple task
// list of markdown pages, each assignable to a project member, shown only
// while the Tasks setting is on, created when it is, and committed by the
// sync tick. The folder shares src/server/pages.ts with the roadmap, so what
// is tested here is what tasks do differently: their own folder, their own
// setting, and a drift pass that leaves the roadmap's documents alone.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPageDoc, pageDocDirRel } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { syncDataDir } from "../src/server/reload";
import {
  ROADMAP,
  ROADMAP_FOLDER,
  TASKS,
  TASKS_FOLDER,
  createPage,
  deletePage,
  ensurePageFolder,
  importPageDrift,
  isPageFolderPath,
  listPages,
  readPage,
  savePage,
} from "../src/server/pages";
import { parsePage, serializePage } from "../src/server/parser";
import { normalizeTasks } from "../src/server/state";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-tasks-"));
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return readdir(path).then(
    () => true,
    () => false,
  );
}

// "tasks are controlled by a switch in user settings": opt-in like the
// roadmap, so a settings file that never mentions it means off.
test("the Tasks setting is off unless explicitly turned on", () => {
  expect(normalizeTasks(undefined)).toBe(false);
  expect(normalizeTasks("true")).toBe(false);
  expect(normalizeTasks(false)).toBe(false);
  expect(normalizeTasks(true)).toBe(true);
});

test("ensurePageFolder creates the tasks folder once", async () => {
  expect(await ensurePageFolder(root, TASKS)).toBe(true);
  expect(await exists(join(root, TASKS_FOLDER))).toBe(true);
  await writeFile(join(root, TASKS_FOLDER, "ship-v2.md"), "# Ship v2\n");
  expect(await ensurePageFolder(root, TASKS)).toBe(false);
  expect(await Bun.file(join(root, TASKS_FOLDER, "ship-v2.md")).text()).toBe("# Ship v2\n");
});

test("a sync tick creates the tasks folder only when the setting is on", async () => {
  const clones = await twoClones(root);
  await syncDataDir(clones.a, { roadmap: true });
  expect(await exists(join(clones.a, TASKS_FOLDER))).toBe(false);
  await syncDataDir(clones.a, { tasks: true });
  expect(await exists(join(clones.a, TASKS_FOLDER))).toBe(true);
});

test("a sync tick commits and pushes every file in the tasks folder", async () => {
  const clones = await twoClones(root);
  await mkdir(join(clones.a, TASKS_FOLDER), { recursive: true });
  await writeFile(join(clones.a, TASKS_FOLDER, "ship-v2.md"), "# Ship v2\n\nCut the build.\n");
  await syncDataDir(clones.a, { tasks: true });

  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, TASKS_FOLDER, "ship-v2.md")).text()).toContain(
    "Cut the build.",
  );
  // The task's document rides along, so the peer merges further edits.
  expect(await loadPageDoc(clones.b, `${TASKS_FOLDER}/ship-v2.md`)).not.toBeNull();
});

test("tasks paths are the folder and what is under it", () => {
  expect(isPageFolderPath("tasks")).toBe(true);
  expect(isPageFolderPath("tasks/sprint-4")).toBe(true);
  expect(isPageFolderPath("tasksy")).toBe(false);
  expect(isPageFolderPath("billing")).toBe(false);
});

// "we need a simple task list where we can assign tasks to a user": a task is
// created, edited and assigned exactly the way a roadmap page is.
test("a task is created, saved and assigned through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, TASKS, "Ship v2");
  expect(fileName).toBe("tasks/ship-v2.md");
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe("# Ship v2\n");
  await git(clones.b, "pull", "origin", "main");
  expect(await exists(join(clones.b, pageDocDirRel(fileName)))).toBe(true);

  const saved = await savePage(
    clones.a,
    TASKS,
    fileName,
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\nCut the build.\n",
  );
  expect(saved.assigned).toBe("Ada Lovelace");
  expect((await readPage(clones.a, TASKS, fileName))?.content).toBe(saved.content);
  expect((await loadPageDoc(clones.a, fileName))?.doc.assigned).toBe("Ada Lovelace");
  expect(await listPages(clones.a, TASKS)).toEqual([
    { fileName, name: "Ship v2", assigned: "Ada Lovelace" },
  ]);
});

// The Done marker (specs/app/tasks.feature.md) is a metadata line like the
// assignment, either order, and only "Done" is one — anything else a person
// wrote on a `**Status:**` line stays in the body where they put it.
test("a page parses its Done marker in either order", () => {
  const after = parsePage("# Ship v2\n\n**Assigned:** Ada\n\n**Status:** Done\n\nCut it.\n");
  expect(after).toEqual({ name: "Ship v2", assigned: "Ada", done: true, body: "Cut it." });
  expect(serializePage(after)).toBe(
    "# Ship v2\n\n**Assigned:** Ada\n\n**Status:** Done\n\nCut it.\n",
  );
  const before = parsePage("# Ship v2\n\n**Status:** done\n\n**Assigned:** Ada\n\nCut it.\n");
  expect(before).toEqual({ name: "Ship v2", assigned: "Ada", done: true, body: "Cut it." });
});

// The Estimate line (specs/app/tasks.feature.md "Add task to Google
// Calendar") is one more metadata line, in any order, written back in its
// canonical form between the assignment and the status; one the app cannot
// read as an estimate stays in the body where the person wrote it.
test("a page parses its Estimate line in any order, and writes it before the status", () => {
  const page = parsePage(
    "# Ship v2\n\n**Status:** Done\n\n**Estimate:** 1h30m\n\n**Assigned:** Ada\n\nCut it.\n",
  );
  expect(page).toEqual({ name: "Ship v2", assigned: "Ada", estimate: 90, done: true, body: "Cut it." });
  expect(serializePage(page)).toBe(
    "# Ship v2\n\n**Assigned:** Ada\n\n**Estimate:** 1h 30m\n\n**Status:** Done\n\nCut it.\n",
  );
  expect(parsePage("# Ship v2\n\n**Estimate:** 2h\n")).toEqual({ name: "Ship v2", estimate: 120, body: "" });
});

test("a page with an estimate it cannot read keeps the line as body", () => {
  const page = parsePage("# Ship v2\n\n**Estimate:** two days\n\nCut it.\n");
  expect(page).toEqual({ name: "Ship v2", body: "**Estimate:** two days\n\nCut it." });
  expect(serializePage(page)).toBe("# Ship v2\n\n**Estimate:** two days\n\nCut it.\n");
});

test("a page with another status keeps it as body", () => {
  const page = parsePage("# Ship v2\n\n**Status:** Blocked\n\nWaiting on legal.\n");
  expect(page).toEqual({
    name: "Ship v2",
    body: "**Status:** Blocked\n\nWaiting on legal.",
  });
  expect(serializePage(page)).toBe("# Ship v2\n\n**Status:** Blocked\n\nWaiting on legal.\n");
});

// "Tasks that are Done should be shown with a strikethrough": the list needs
// to know, so a done task carries a `**Status:** Done` line the listing reads
// back — and reopening it takes the line away again.
test("a task is marked done and reopened through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, TASKS, "Ship v2");

  const done = await savePage(
    clones.a,
    TASKS,
    fileName,
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\n**Status:** Done\n\nCut the build.\n",
  );
  expect(done.done).toBe(true);
  expect(done.content).toBe(
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\n**Status:** Done\n\nCut the build.\n",
  );
  expect((await loadPageDoc(clones.a, fileName))?.doc.done).toBe(true);
  expect(await listPages(clones.a, TASKS)).toEqual([
    { fileName, name: "Ship v2", assigned: "Ada Lovelace", done: true },
  ]);

  const reopened = await savePage(
    clones.a,
    TASKS,
    fileName,
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\nCut the build.\n",
  );
  expect(reopened.done).toBeUndefined();
  expect(reopened.content).not.toContain("Status:");
  expect((await loadPageDoc(clones.a, fileName))?.doc.done).toBeUndefined();
  expect(await listPages(clones.a, TASKS)).toEqual([
    { fileName, name: "Ship v2", assigned: "Ada Lovelace" },
  ]);
});

// The calendar chip writes the estimate through the document like the Done
// marker, so the listing and the chip read it back — and a save without the
// line takes it away again.
test("a task's estimate is saved and cleared through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, TASKS, "Ship v2");

  const estimated = await savePage(
    clones.a,
    TASKS,
    fileName,
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\n**Estimate:** 90m\n\nCut the build.\n",
  );
  expect(estimated.estimate).toBe(90);
  expect(estimated.content).toBe(
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\n**Estimate:** 1h 30m\n\nCut the build.\n",
  );
  expect((await loadPageDoc(clones.a, fileName))?.doc.estimate).toBe(90);
  expect(await listPages(clones.a, TASKS)).toEqual([
    { fileName, name: "Ship v2", assigned: "Ada Lovelace", estimate: 90 },
  ]);

  const cleared = await savePage(
    clones.a,
    TASKS,
    fileName,
    "# Ship v2\n\n**Assigned:** Ada Lovelace\n\nCut the build.\n",
  );
  expect(cleared.estimate).toBeUndefined();
  expect(cleared.content).not.toContain("Estimate:");
  expect((await loadPageDoc(clones.a, fileName))?.doc.estimate).toBeUndefined();
});

test("a task is deleted with its document, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, TASKS, "Ship v2");
  await deletePage(clones.a, TASKS, fileName);
  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.a, pageDocDirRel(fileName)))).toBe(false);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  expect(deletePage(clones.a, TASKS, fileName)).rejects.toThrow("Task not found");
});

// The two folders share one document store, so each drift pass must see only
// its own pages — a tasks tick must never drop the roadmap's documents.
test("each folder's drift pass leaves the other folder's documents alone", async () => {
  await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
  await mkdir(join(root, TASKS_FOLDER), { recursive: true });
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n");
  await writeFile(join(root, TASKS_FOLDER, "ship-v2.md"), "# Ship v2\n");
  expect(await importPageDrift(root, ROADMAP)).toContain("imported 1 roadmap page(s)");
  expect(await importPageDrift(root, TASKS)).toContain("imported 1 task(s)");

  // An externally edited task is absorbed; the roadmap page is not touched.
  await writeFile(join(root, TASKS_FOLDER, "ship-v2.md"), "# Ship v2\n\nEdited elsewhere.\n");
  expect(await importPageDrift(root, TASKS)).toContain("absorbed 1 externally edited task(s)");
  expect(await importPageDrift(root, ROADMAP)).toBe("");

  // A deleted task takes its own document, and only its own.
  await rm(join(root, TASKS_FOLDER, "ship-v2.md"));
  expect(await importPageDrift(root, TASKS)).toContain("dropped 1");
  expect(await loadPageDoc(root, "tasks/ship-v2.md")).toBeNull();
  expect(await loadPageDoc(root, "roadmap/pricing.md")).not.toBeNull();
});

test("a page path outside the tasks folder is refused", async () => {
  await expect(readPage(root, TASKS, "../secrets.md")).rejects.toThrow("Invalid task");
  await expect(readPage(root, TASKS, "roadmap/pricing.md")).rejects.toThrow("Invalid task");
  await expect(savePage(root, TASKS, "tasks/x.feature.md", "# X\n")).rejects.toThrow(
    "Invalid task",
  );
});
