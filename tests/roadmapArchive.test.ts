// specs/app/roadmap.feature.md "Archive a roadmap page": an archived page's
// markdown leaves the data repo while its Automerge document stays, marked
// archived — the only copy, until the page is restored or deleted for good.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { loadPageDoc, pageDocDirRel } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { PAGE_ORDER_FILE } from "../src/server/pageOrder";
import {
  ROADMAP,
  TASKS,
  archivePage,
  createPage,
  createPageFolder,
  deleteArchivedPage,
  deletePageFolder,
  importPageDrift,
  listArchivedPages,
  listPages,
  movePage,
  renamePageFile,
  restorePage,
  savePage,
} from "../src/server/pages";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-roadmap-archive-"));
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

const AT = "2026-11-01T10:00:00.000Z";

test("archiving removes the markdown and keeps the document, in one pushed commit", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, ROADMAP, "Pricing");
  await savePage(clones.a, ROADMAP, fileName, "# Pricing\n\nCharge for it.\n");
  await archivePage(clones.a, ROADMAP, fileName, { by: "Ada", at: AT });

  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  const doc = (await loadPageDoc(clones.a, fileName))?.doc;
  expect(doc?.archived).toEqual({ at: AT, by: "Ada" });
  expect(doc?.body).toBe("Charge for it.");
  expect(await listPages(clones.a, ROADMAP)).toEqual([]);
  expect(await listArchivedPages(clones.a, ROADMAP)).toEqual([
    { fileName, name: "Pricing", archivedAt: AT, archivedBy: "Ada" },
  ]);

  // The removal and the archived document travel together: the last commit
  // holds both, and nothing is left for the sync tick.
  const shown = (await git(clones.a, "show", "--name-status", "--format=%s", "HEAD")).stdout.toString();
  expect(shown).toContain(`Archive roadmap page: ${fileName}`);
  expect(shown).toContain(`D\t${fileName}`);
  expect(shown).toContain(pageDocDirRel(fileName));
  const left = await git(clones.a, "status", "--porcelain", "--", pageDocDirRel(fileName));
  expect(left.stdout.toString().trim()).toBe("");

  // A teammate pulls it: no file, the document marked archived — and their
  // drift pass keeps it, where a page whose file is gone loses its document.
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  expect(await importPageDrift(clones.b, ROADMAP)).toBe("");
  expect((await loadPageDoc(clones.b, fileName))?.doc.archived?.by).toBe("Ada");
  expect((await listArchivedPages(clones.b, ROADMAP)).map((p) => p.fileName)).toEqual([fileName]);
});

test("a restored page comes back as it was, last in its folder, pushed", async () => {
  const clones = await twoClones(root);
  const pricing = await createPage(clones.a, ROADMAP, "Pricing");
  await savePage(clones.a, ROADMAP, pricing, "# Pricing\n\n**Assigned:** Ada\n\nCharge for it.\n");
  await createPage(clones.a, ROADMAP, "Launch");
  await movePage(clones.a, ROADMAP, pricing, "roadmap", null);
  await archivePage(clones.a, ROADMAP, pricing, { at: AT });
  // The order forgets it, as for a delete.
  expect(await Bun.file(join(clones.a, "roadmap", PAGE_ORDER_FILE)).text()).toBe("launch.md\n");

  const restored = await restorePage(clones.a, ROADMAP, pricing);
  expect(restored.fileName).toBe(pricing);
  expect(await Bun.file(join(clones.a, pricing)).text()).toBe(
    "# Pricing\n\n**Assigned:** Ada\n\nCharge for it.\n",
  );
  expect((await loadPageDoc(clones.a, pricing))?.doc.archived).toBeUndefined();
  expect(await listArchivedPages(clones.a, ROADMAP)).toEqual([]);
  expect((await listPages(clones.a, ROADMAP)).map((p) => p.fileName)).toEqual([
    "roadmap/launch.md",
    pricing,
  ]);
  await expect(restorePage(clones.a, ROADMAP, pricing)).rejects.toThrow("No archived roadmap page");

  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, pricing)).text()).toContain("Charge for it.");
  expect((await loadPageDoc(clones.b, pricing))?.doc.archived).toBeUndefined();
});

test("an archived page is deleted for good with its document, pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, ROADMAP, "Pricing");
  await archivePage(clones.a, ROADMAP, fileName);
  await deleteArchivedPage(clones.a, ROADMAP, fileName);
  expect(await exists(join(clones.a, pageDocDirRel(fileName)))).toBe(false);
  expect(await listArchivedPages(clones.a, ROADMAP)).toEqual([]);
  await git(clones.b, "pull", "origin", "main");
  expect(await exists(join(clones.b, pageDocDirRel(fileName)))).toBe(false);
  // A live page is not an archived one.
  const live = await createPage(clones.a, ROADMAP, "Launch");
  await expect(deleteArchivedPage(clones.a, ROADMAP, live)).rejects.toThrow("No archived roadmap page");
});

test("archiving takes in an edit the sync tick has not absorbed yet", async () => {
  await mkdir(join(root, "roadmap"), { recursive: true });
  const fileName = "roadmap/pricing.md";
  await writeFile(join(root, fileName), "# Pricing\n");
  await importPageDrift(root, ROADMAP);
  await writeFile(join(root, fileName), "# Pricing\n\nEdited on disk.\n");
  await archivePage(root, ROADMAP, fileName);
  expect((await loadPageDoc(root, fileName))?.doc.body).toBe("Edited on disk.");
  // A page that never had a document gets one to be archived in.
  await writeFile(join(root, "roadmap/fresh.md"), "# Fresh\n\nNever synced.\n");
  await archivePage(root, ROADMAP, "roadmap/fresh.md");
  expect((await loadPageDoc(root, "roadmap/fresh.md"))?.doc.body).toBe("Never synced.");
  expect((await listArchivedPages(root, ROADMAP)).map((p) => p.name).sort()).toEqual(["Fresh", "Pricing"]);
});

test("an archived page's name is not taken by another page, nor saved over", async () => {
  await mkdir(join(root, "roadmap/later"), { recursive: true });
  const fileName = await createPage(root, ROADMAP, "Pricing");
  await archivePage(root, ROADMAP, fileName);
  await expect(createPage(root, ROADMAP, "Pricing")).rejects.toThrow("An archived roadmap page has that name");
  const other = await createPage(root, ROADMAP, "Other");
  await expect(renamePageFile(root, ROADMAP, other, "Pricing")).rejects.toThrow("An archived roadmap page");
  const later = await createPage(root, ROADMAP, "later/Pricing");
  await expect(movePage(root, ROADMAP, later, "roadmap", null)).rejects.toThrow("An archived roadmap page");
  // An editor left open on it saves nothing back.
  await expect(savePage(root, ROADMAP, fileName, "# Pricing\n\nTyped late.\n")).rejects.toThrow(
    "An archived roadmap page",
  );
  expect(await Bun.file(join(root, fileName)).exists()).toBe(false);
  expect((await loadPageDoc(root, fileName))?.doc.body).toBe("");
});

test("markdown put back beside an archived document brings the page back", async () => {
  const fileName = await createPage(root, ROADMAP, "Pricing");
  await archivePage(root, ROADMAP, fileName);
  await writeFile(join(root, fileName), "# Pricing\n\nBack by hand.\n");
  expect(await importPageDrift(root, ROADMAP)).toContain("brought back 1 archived");
  const doc = (await loadPageDoc(root, fileName))?.doc;
  expect(doc?.archived).toBeUndefined();
  expect(doc?.body).toBe("Back by hand.");
  expect(await listArchivedPages(root, ROADMAP)).toEqual([]);
});

test("deleting a folder keeps the archived pages that were in it", async () => {
  await createPageFolder(root, ROADMAP, "Later");
  const kept = await createPage(root, ROADMAP, "later/Kept");
  const gone = await createPage(root, ROADMAP, "later/Gone");
  await archivePage(root, ROADMAP, kept);
  await deletePageFolder(root, ROADMAP, "roadmap/later");
  expect(await loadPageDoc(root, gone)).toBeNull();
  expect((await listArchivedPages(root, ROADMAP)).map((p) => p.fileName)).toEqual([kept]);
  // Restore makes the folder again.
  await restorePage(root, ROADMAP, kept);
  expect(await Bun.file(join(root, kept)).text()).toBe("# Kept\n");
});

test("only the roadmap's pages are archived", async () => {
  const task = await createPage(root, TASKS, "Ship");
  await expect(archivePage(root, TASKS, task)).rejects.toThrow("Tasks are not archived");
  expect(await listArchivedPages(root, TASKS)).toEqual([]);
});

test("the roadmap routes archive, list, restore and delete a page", async () => {
  const home = await mkdtemp(join(tmpdir(), "specdriven-roadmap-archive-home-"));
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  const data = join(root, "data");
  const call = async (method: string, path: string) => {
    const res = (await handleApi(new Request(`http://localhost${path}`, { method }))) as Response | null;
    // No route at all answers null — the tasks have no archive.
    if (res === null) return { status: 404, body: {} };
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const file = (name: string) => encodeURIComponent(`roadmap/${name}.md`);
  try {
    await writeState({ dataRepo: data, roadmap: true, tasks: true }, root);
    await syncPlugins({ roadmap: true, tasks: true });
    await mkdir(join(data, "roadmap"), { recursive: true });
    await writeFile(join(data, "roadmap/pricing.md"), "# Pricing\n");
    await writeFile(join(data, "roadmap/launch.md"), "# Launch\n");

    expect((await call("POST", `/api/roadmap/${file("pricing")}/archive`)).status).toBe(200);
    expect((await call("POST", `/api/roadmap/${file("launch")}/archive`)).status).toBe(200);
    const listed = await call("GET", "/api/roadmap-archive");
    expect((listed.body.pages as { name: string }[]).map((p) => p.name).sort()).toEqual(["Launch", "Pricing"]);
    expect((await call("GET", "/api/roadmap")).body.pages).toEqual([]);

    const restored = await call("POST", `/api/roadmap-archive/${file("pricing")}/restore`);
    expect(restored.body.fileName).toBe("roadmap/pricing.md");
    expect((await call("DELETE", `/api/roadmap-archive/${file("launch")}`)).status).toBe(200);
    expect((await call("GET", "/api/roadmap-archive")).body.pages).toEqual([]);
    expect(((await call("GET", "/api/roadmap")).body.pages as { name: string }[]).map((p) => p.name)).toEqual([
      "Pricing",
    ]);
    // A page that is not there, and a folder whose pages are not archived.
    expect((await call("POST", `/api/roadmap/${file("nope")}/archive`)).status).toBe(400);
    expect((await call("GET", "/api/tasks-archive")).status).toBe(404);
  } finally {
    reloader.stop();
    await syncPlugins({ roadmap: false, tasks: false });
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
