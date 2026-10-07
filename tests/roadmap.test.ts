// specs/app/roadmap.feature.md: the data repo's `roadmap` folder — regular
// markdown pages above the feature folders, shown only while the Roadmap
// setting is on, created when it is, and committed by the sync tick.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPage } from "../src/server/automerge/page";
import { loadPageDoc, pageDocDirRel } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { parsePage, serializePage } from "../src/server/parser";
import { syncDataDir } from "../src/server/reload";
// The folder's drift pass is the roadmap plugin's (src/plugins/builtin/pages
// /host.ts): it runs while the switch has the plugin mounted.
import "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import {
  ROADMAP,
  ROADMAP_FOLDER,
  createPage,
  deletePage,
  ensurePageFolder,
  importPageDrift,
  isPageFolderPath,
  listPages,
  readPage,
  renamePageFile,
  savePage,
} from "../src/server/pages";
import { git, stopServers, twoClones } from "./helpers/fixtures";
import { installFakeGit } from "./helpers/fakeGit";
import { builtinManifests } from "../src/plugins/builtin/manifests";
import { readProfile } from "../src/plugins/profile";

/** The legacy `roadmap` switch, read as the profile reads it (src/plugins/profile.ts). */
const normalizeRoadmap = (value: unknown): boolean =>
  readProfile(value === undefined ? {} : { roadmap: value }, builtinManifests).enabled.includes("roadmap");

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
test("ensurePageFolder creates the roadmap folder once", async () => {
  expect(await ensurePageFolder(root, ROADMAP)).toBe(true);
  expect(await exists(join(root, ROADMAP_FOLDER))).toBe(true);
  // Already there: nothing to create, and nothing disturbed.
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n");
  expect(await ensurePageFolder(root, ROADMAP)).toBe(false);
  expect(await Bun.file(join(root, ROADMAP_FOLDER, "pricing.md")).text()).toBe("# Pricing\n");
});

// The switch is under test, not git, so the tick runs on a fake one.
test("a sync tick creates the folder only when the setting is on", async () => {
  const fakeGit = installFakeGit();
  try {
    await syncPlugins({ roadmap: false });
    await syncDataDir(root);
    expect(await exists(join(root, ROADMAP_FOLDER))).toBe(false);
    await syncPlugins({ roadmap: true });
    await syncDataDir(root);
  } finally {
    await syncPlugins({ roadmap: false });
    fakeGit.restore();
  }
  expect(await exists(join(root, ROADMAP_FOLDER))).toBe(true);
});

// "On Sync, commit all files in this folder."
test("a sync tick commits and pushes every file in the roadmap folder", async () => {
  const clones = await twoClones(root);
  await mkdir(join(clones.a, ROADMAP_FOLDER), { recursive: true });
  await writeFile(join(clones.a, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\nCharge for it.\n");
  await writeFile(join(clones.a, ROADMAP_FOLDER, "notes.md"), "# Notes\n");
  await syncPlugins({ roadmap: true });
  try {
    await syncDataDir(clones.a);
  } finally {
    await syncPlugins({ roadmap: false });
  }

  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, ROADMAP_FOLDER, "notes.md")).exists()).toBe(true);
  expect(await Bun.file(join(clones.b, ROADMAP_FOLDER, "pricing.md")).text()).toContain(
    "Charge for it.",
  );
  // The pages' documents ride along, so the peer merges further edits.
  expect(await loadPageDoc(clones.b, `${ROADMAP_FOLDER}/pricing.md`)).not.toBeNull();
});

test("roadmap paths are the folder and what is under it", () => {
  expect(isPageFolderPath("roadmap")).toBe(true);
  expect(isPageFolderPath("roadmap/q3")).toBe(true);
  expect(isPageFolderPath("roadmapping")).toBe(false);
  expect(isPageFolderPath("billing")).toBe(false);
});

// A roadmap page is a regular markdown file: heading, an optional
// `**Assigned:**` line like a feature's, then free markdown.
test("a page parses into its name, assignment and body", () => {
  const page = parsePage("# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge *more*.\n");
  expect(page).toEqual({ name: "Pricing", assigned: "Ada Lovelace", body: "Charge *more*." });
  expect(serializePage(page)).toBe("# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge *more*.\n");
});

test("a page without a heading is all body", () => {
  const page = parsePage("Just some notes.\n\n- one\n");
  expect(page).toEqual({ name: "", body: "Just some notes.\n\n- one" });
  expect(serializePage(page)).toBe("Just some notes.\n\n- one\n");
});

test("listPages names the roadmap pages, nested ones included", async () => {
  await mkdir(join(root, ROADMAP_FOLDER, "q3"), { recursive: true });
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\n**Assigned:** Ada\n");
  await writeFile(join(root, ROADMAP_FOLDER, "q3/no-heading.md"), "notes\n");
  // A feature file that wandered in is not a roadmap page.
  await writeFile(join(root, ROADMAP_FOLDER, "stray.feature.md"), "# Stray\n");
  expect(await listPages(root, ROADMAP)).toEqual([
    { fileName: "roadmap/pricing.md", name: "Pricing", assigned: "Ada" },
    { fileName: "roadmap/q3/no-heading.md", name: "No Heading" },
  ]);
});

test("a page is created, read and saved through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, ROADMAP, "Pricing");
  expect(fileName).toBe("roadmap/pricing.md");
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe("# Pricing\n");
  // Committed and pushed like a new feature — document and all.
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(true);
  expect(await exists(join(clones.b, pageDocDirRel(fileName)))).toBe(true);

  const saved = await savePage(clones.a, ROADMAP, fileName, "# Pricing\n\nCharge for it.\n");
  expect(saved.name).toBe("Pricing");
  expect(saved.content).toBe("# Pricing\n\nCharge for it.\n");
  expect((await readPage(clones.a, ROADMAP, fileName))?.content).toBe(saved.content);
  const loaded = await loadPageDoc(clones.a, fileName);
  expect(loaded?.doc.body).toBe("Charge for it.");
});

// The sidebar's ⋯ menu deletes a page: the markdown and its document go,
// committed and pushed like a deleted feature.
test("a page is deleted with its document, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createPage(clones.a, ROADMAP, "Pricing");
  await deletePage(clones.a, ROADMAP, fileName);
  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.a, pageDocDirRel(fileName)))).toBe(false);
  expect((await listPages(clones.a, ROADMAP)).map((page) => page.fileName)).toEqual([]);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  expect(deletePage(clones.a, ROADMAP, fileName)).rejects.toThrow("not found");
});

// "allow Assignment for a roadmap doc just like for a feature": the member
// lands on the file's `**Assigned:**` line and in the page's document.
test("a page is assigned to a project member", async () => {
  await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
  await writeFile(join(root, ROADMAP_FOLDER, "pricing.md"), "# Pricing\n\nCharge for it.\n");
  const fileName = "roadmap/pricing.md";
  const saved = await savePage(
    root,
    ROADMAP,
    fileName,
    "# Pricing\n\n**Assigned:** Ada Lovelace\n\nCharge for it.\n",
  );
  expect(saved.assigned).toBe("Ada Lovelace");
  expect(await Bun.file(join(root, fileName)).text()).toContain("**Assigned:** Ada Lovelace");
  expect((await loadPageDoc(root, fileName))?.doc.assigned).toBe("Ada Lovelace");

  // Unassigning takes the line back out, in the file and in the document.
  const cleared = await savePage(root, ROADMAP, fileName, "# Pricing\n\nCharge for it.\n");
  expect(cleared.assigned).toBeUndefined();
  expect(await Bun.file(join(root, fileName)).text()).not.toContain("Assigned");
  expect((await loadPageDoc(root, fileName))?.doc.assigned).toBeUndefined();
});

// An edit made to the file on disk is only absorbed into the document on the
// next sync tick; an editor save landing first must not write over it — the
// same rule features.ts absorbIntoDoc uses for `.feature.md` files.
describe("a page save racing an unsynced disk edit", () => {
  const file = "roadmap/pricing.md";

  beforeEach(async () => {
    await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
    await writeFile(join(root, file), "# Pricing\n\nOriginal.\n");
    await importPageDrift(root, ROADMAP);
  });

  test("keeps the disk edit alongside the save", async () => {
    await writeFile(join(root, file), "# Pricing\n\nOriginal.\n\nFrom disk.\n");
    // The editor loaded the page before the disk edit; that is its base.
    const saved = await savePage(
      root,
      ROADMAP,
      file,
      "# Pricing\n\nOriginal, edited here.\n",
      "# Pricing\n\nOriginal.\n",
    );

    const md = (await Bun.file(join(root, file)).text()) as string;
    expect(md).toContain("From disk.");
    expect(md).toContain("edited here");
    expect(saved.content).toBe(md);
    expect(projectPage((await loadPageDoc(root, file))!.doc)).toBe(md);
    expect(await importPageDrift(root, ROADMAP)).toBe("");
  });

  test("an editor that already holds the disk edit saves it once", async () => {
    const onDisk = "# Pricing\n\nOriginal.\n\nFrom disk.\n";
    await writeFile(join(root, file), onDisk);
    const saved = await savePage(root, ROADMAP, file, onDisk);
    expect(saved.content).toContain("From disk.");
    expect(saved.content.match(/From disk\./g)?.length).toBe(1);
    expect(await Bun.file(join(root, file)).text()).toBe(saved.content);
  });

  // The page view reads the file, so an editor opened after the disk edit
  // holds it: merging it in again would write it twice.
  test("an editor opened after the disk edit and typing on saves it once", async () => {
    const onDisk = "# Pricing\n\nOriginal.\n\nFrom disk.\n";
    await writeFile(join(root, file), onDisk);
    const opened = (await readPage(root, ROADMAP, file))!.content;
    const saved = await savePage(
      root,
      ROADMAP,
      file,
      opened.replace("Original.", "Original, edited here."),
      opened,
    );
    expect(saved.content).toBe("# Pricing\n\nOriginal, edited here.\n\nFrom disk.\n");
  });

  // The editor keeps its own buffer after a save; its next save must not
  // take the folded disk edit back out.
  test("the editor's next autosave keeps the folded disk edit", async () => {
    const loaded = "# Pricing\n\nOriginal.\n";
    await writeFile(join(root, file), "# Pricing\n\nOriginal.\n\nFrom disk.\n");
    const first = "# Pricing\n\nOriginal, edited here.\n";
    await savePage(root, ROADMAP, file, first, loaded);
    const second = await savePage(root, ROADMAP, file, "# Pricing\n\nOriginal, edited here twice.\n", first);
    expect(second.content).toBe("# Pricing\n\nOriginal, edited here twice.\n\nFrom disk.\n");
  });

  test("a rename keeps the heading it was given when the heading drifted", async () => {
    await writeFile(join(root, file), "# Pricing tiers\n\nOriginal.\n");
    const renamed = await renamePageFile(root, ROADMAP, file, "Plans");
    expect(renamed.fileName).toBe("roadmap/plans.md");
    expect(await Bun.file(join(root, "roadmap/plans.md")).text()).toBe("# Plans\n\nOriginal.\n");
  });

  // With no base the merge can only guess, so text changed on both sides is
  // refused rather than merged into a possible duplicate.
  test("a save with no base refuses text changed on both sides", async () => {
    await writeFile(join(root, file), "# Pricing\n\nOriginal.\n\nFrom disk.\n");
    await expect(savePage(root, ROADMAP, file, "# Pricing\n\nOriginal, edited here.\n")).rejects.toThrow(
      "edited on disk and here at the same time",
    );
    expect(await Bun.file(join(root, file)).text()).toBe("# Pricing\n\nOriginal.\n\nFrom disk.\n");
  });
});

test("an externally edited page is absorbed into its document", async () => {
  await mkdir(join(root, ROADMAP_FOLDER), { recursive: true });
  const fileName = "roadmap/pricing.md";
  await writeFile(join(root, fileName), "# Pricing\n");
  // First pass imports the page; the second sees no drift.
  expect(await importPageDrift(root, ROADMAP)).toContain("imported 1");
  expect(await importPageDrift(root, ROADMAP)).toBe("");

  await writeFile(join(root, fileName), "# Pricing\n\n**Assigned:** Grace\n\nEdited elsewhere.\n");
  expect(await importPageDrift(root, ROADMAP)).toContain("absorbed 1");
  const loaded = await loadPageDoc(root, fileName);
  expect(loaded?.doc.body).toBe("Edited elsewhere.");
  expect(loaded?.doc.assigned).toBe("Grace");

  // A deleted page takes its document with it.
  await rm(join(root, fileName));
  expect(await importPageDrift(root, ROADMAP)).toContain("dropped 1");
  expect(await loadPageDoc(root, fileName)).toBeNull();
});

test("a page path outside the roadmap folder is refused", async () => {
  await expect(readPage(root, ROADMAP, "../secrets.md")).rejects.toThrow("Invalid roadmap page");
  await expect(readPage(root, ROADMAP, "billing/quotes.md")).rejects.toThrow("Invalid roadmap page");
  await expect(savePage(root, ROADMAP, "roadmap/x.feature.md", "# X\n")).rejects.toThrow(
    "Invalid roadmap page",
  );
});
