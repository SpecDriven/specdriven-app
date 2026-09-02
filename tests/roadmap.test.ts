// specs/app/roadmap.feature.md: the data repo's `roadmap` folder — regular
// markdown pages above the feature folders, shown only while the Roadmap
// setting is on, created when it is, and committed by the sync tick.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoadmapDoc, roadmapDocDirRel } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { parseRoadmap, serializeRoadmap } from "../src/server/parser";
import { syncDataDir } from "../src/server/reload";
import {
  ROADMAP_FOLDER,
  createRoadmapPage,
  deleteRoadmapPage,
  ensureRoadmapFolder,
  importRoadmapDrift,
  isRoadmapPath,
  listRoadmap,
  readRoadmapPage,
  saveRoadmapPage,
} from "../src/server/roadmap";
import { normalizeRoadmap } from "../src/server/state";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-roadmap-"));
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

// "User settings will control the visibility of this folder": the folder is
// opt-in, so a settings file that never mentions it means off.
test("the Roadmap setting is off unless explicitly turned on", () => {
  expect(normalizeRoadmap(undefined)).toBe(false);
  expect(normalizeRoadmap("true")).toBe(false);
  expect(normalizeRoadmap(false)).toBe(false);
  expect(normalizeRoadmap(true)).toBe(true);
});

// Scenario "Create roadmap folder if necessary".
test("ensureRoadmapFolder creates the folder once", async () => {
  expect(await ensureRoadmapFolder(root)).toBe(true);
  expect(await exists(join(root, ROADMAP_FOLDER))).toBe(true);
  // Already there: nothing to create, and nothing disturbed.
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n");
  expect(await ensureRoadmapFolder(root)).toBe(false);
  expect(await Bun.file(join(root, ROADMAP_FOLDER, "pricing.md")).text()).toBe("# Pricing\n");
});

test("a sync tick creates the folder only when the setting is on", async () => {
  const clones = await twoClones(root);
  await syncDataDir(clones.a);
  expect(await exists(join(clones.a, ROADMAP_FOLDER))).toBe(false);
  await syncDataDir(clones.a, { roadmap: true });
  expect(await exists(join(clones.a, ROADMAP_FOLDER))).toBe(true);
});

// "On Sync, commit all files in this folder."
test("a sync tick commits and pushes every file in the roadmap folder", async () => {
  const clones = await twoClones(root);
  await mkdir(join(clones.a, ROADMAP_FOLDER), { recursive: true });
  await writeFile(join(clones.a, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\nCharge for it.\n");
  await writeFile(join(clones.a, ROADMAP_FOLDER, "notes.md"), "# Notes\n");
  await syncDataDir(clones.a, { roadmap: true });

  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, ROADMAP_FOLDER, "notes.md")).exists()).toBe(true);
  expect(await Bun.file(join(clones.b, ROADMAP_FOLDER, "pricing.md")).text()).toContain(
    "Charge for it.",
  );
  // The pages' documents ride along, so the peer merges further edits.
  expect(await loadRoadmapDoc(clones.b, `${ROADMAP_FOLDER}/pricing.md`)).not.toBeNull();
});

test("roadmap paths are the folder and what is under it", () => {
  expect(isRoadmapPath("roadmap")).toBe(true);
  expect(isRoadmapPath("roadmap/q3")).toBe(true);
  expect(isRoadmapPath("roadmapping")).toBe(false);
  expect(isRoadmapPath("billing")).toBe(false);
});

// A roadmap page is a regular markdown file: heading, an optional
// `**Assigned:**` line like a feature's, then free markdown.
test("a page parses into its name, assignment and body", () => {
  const page = parseRoadmap("# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge *more*.\n");
  expect(page).toEqual({ name: "Pricing", assigned: "Ada Lovelace", body: "Charge *more*." });
  expect(serializeRoadmap(page)).toBe("# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge *more*.\n");
});

test("a page without a heading is all body", () => {
  const page = parseRoadmap("Just some notes.\n\n- one\n");
  expect(page).toEqual({ name: "", body: "Just some notes.\n\n- one" });
  expect(serializeRoadmap(page)).toBe("Just some notes.\n\n- one\n");
});

test("listRoadmap names the pages, nested ones included", async () => {
  await mkdir(join(root, ROADMAP_FOLDER, "q3"), { recursive: true });
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\n**Assigned:** Ada\n");
  await writeFile(join(root, ROADMAP_FOLDER, "q3/no-heading.md"), "notes\n");
  // A feature file that wandered in is not a roadmap page.
  await writeFile(join(root, ROADMAP_FOLDER, "stray.feature.md"), "# Stray\n");
  expect(await listRoadmap(root)).toEqual([
    { fileName: "roadmap/pricing.md", name: "Pricing", assigned: "Ada" },
    { fileName: "roadmap/q3/no-heading.md", name: "No Heading" },
  ]);
});

test("a page is created, read and saved through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createRoadmapPage(clones.a, "Pricing");
  expect(fileName).toBe("roadmap/pricing.md");
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe("# Pricing\n");
  // Committed and pushed like a new feature — document and all.
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(true);
  expect(await exists(join(clones.b, roadmapDocDirRel(fileName)))).toBe(true);

  const saved = await saveRoadmapPage(clones.a, fileName, "# Pricing\n\nCharge for it.\n");
  expect(saved.name).toBe("Pricing");
  expect(saved.content).toBe("# Pricing\n\nCharge for it.\n");
  expect((await readRoadmapPage(clones.a, fileName))?.content).toBe(saved.content);
  const loaded = await loadRoadmapDoc(clones.a, fileName);
  expect(loaded?.doc.body).toBe("Charge for it.");
});

// The sidebar's ⋯ menu deletes a page: the markdown and its document go,
// committed and pushed like a deleted feature.
test("a page is deleted with its document, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createRoadmapPage(clones.a, "Pricing");
  await deleteRoadmapPage(clones.a, fileName);
  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.a, roadmapDocDirRel(fileName)))).toBe(false);
  expect((await listRoadmap(clones.a)).map((p) => p.fileName)).toEqual([]);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  expect(deleteRoadmapPage(clones.a, fileName)).rejects.toThrow("not found");
});

// "allow Assignment for a roadmap doc just like for a feature": the member
// lands on the file's `**Assigned:**` line and in the page's document.
test("a page is assigned to a project member", async () => {
  await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\nCharge for it.\n");
  const fileName = "roadmap/pricing.md";
  const saved = await saveRoadmapPage(
    root,
    fileName,
    "# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge for it.\n",
  );
  expect(saved.assigned).toBe("Ada Lovelace");
  expect(await Bun.file(join(root, fileName)).text()).toContain("**Assigned:** Ada Lovelace");
  expect((await loadRoadmapDoc(root, fileName))?.doc.assigned).toBe("Ada Lovelace");

  // Unassigning takes the line back out, in the file and in the document.
  const cleared = await saveRoadmapPage(root, fileName, "# Pricing\n\nCharge for it.\n");
  expect(cleared.assigned).toBeUndefined();
  expect(await Bun.file(join(root, fileName)).text()).not.toContain("Assigned");
  expect((await loadRoadmapDoc(root, fileName))?.doc.assigned).toBeUndefined();
});

test("an externally edited page is absorbed into its document", async () => {
  await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
  const fileName = "roadmap/pricing.md";
  await writeFile(join(root, fileName), "# Pricing\n");
  // First pass imports the page; the second sees no drift.
  expect(await importRoadmapDrift(root)).toContain("imported 1");
  expect(await importRoadmapDrift(root)).toBe("");

  await writeFile(join(root, fileName), "# Pricing\n\n**Assigned:** Grace\n\nEdited elsewhere.\n");
  expect(await importRoadmapDrift(root)).toContain("absorbed 1");
  const loaded = await loadRoadmapDoc(root, fileName);
  expect(loaded?.doc.body).toBe("Edited elsewhere.");
  expect(loaded?.doc.assigned).toBe("Grace");

  // A deleted page takes its document with it.
  await rm(join(root, fileName));
  expect(await importRoadmapDrift(root)).toContain("dropped 1");
  expect(await loadRoadmapDoc(root, fileName)).toBeNull();
});

test("a page path outside the roadmap folder is refused", async () => {
  await expect(readRoadmapPage(root, "../secrets.md")).rejects.toThrow("Invalid roadmap page");
  await expect(readRoadmapPage(root, "billing/quotes.md")).rejects.toThrow("Invalid roadmap page");
  await expect(saveRoadmapPage(root, "roadmap/x.feature.md", "# X\n")).rejects.toThrow(
    "Invalid roadmap page",
  );
});
