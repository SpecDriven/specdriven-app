// The store's mirrored layout (specs/datastore/automerge-store.feature.md
// "Storage layout"): a document's directory is its source path with the top
// folder mapped — `specs/`, `roadmap/`, `tasks/`, `notebook/` as they are,
// `models/` (the Event Models plugin's) as `event-models/` — plus `test-management/project/` for the one
// document with no markdown side. And the one-shot migration
// (src/server/migrate.ts migrateAutomergeLayout) that lifts a repo written
// under the old per-kind roots (`features/`, `docs/`, `models/`, `testing/`)
// into it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import * as A from "@automerge/automerge";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  AUTOMERGE_ROOT,
  createFeatureDoc,
  createFileDoc,
  createPageDoc,
  createTestingDoc,
  docDirRel,
  featureFileOfDocidPath,
  listFeatureDocs,
  listFileDocs,
  listPageDocs,
  loadFeatureDoc,
  loadFileDoc,
  loadPageDoc,
  loadTestingDoc,
  fileDocDirRel,
  newFeatureDoc,
  newFileDoc,
  newPageDoc,
  newTestingDoc,
  pageDocDirRel,
  saveFeatureDoc,
  testingDocDirRel,
} from "../../src/server/automerge/store";
import { migrateAutomergeLayout } from "../../src/server/migrate";
import { reloadData } from "../../src/server/reload";
import { setGitEngine } from "../../src/server/git";
import { writeState } from "../../src/server/state";
import { directoryExists, fileExists } from "../../src/server/fsx";
import { git, stopServers, twoClones } from "../helpers/fixtures";

let root: string;
let home: string;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-amlayout-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-amlayout-home-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

const FEATURE = "specs/policy/quote-policy.feature.md";
const ROADMAP_PAGE = "roadmap/auth.md";
const TASK_PAGE = "tasks/ship-it.md";
const MODEL = "models/cart.model.json";

function featureDoc(name = "Quote Policy") {
  return newFeatureDoc({ name, description: "", specs: [] });
}

function pageDoc(name: string) {
  return newPageDoc({ name, body: "some body\n" });
}

/** An Event Model's document, as the Models plugin keeps one per model file. */
function modelDoc() {
  return newFileDoc(1, {
    name: "Cart",
    model: { slices: [] },
    layout: { lanes: [], slices: {}, elements: {} },
    links: {},
  });
}

/** One document of every kind, at today's paths. Returns their identities. */
async function seedEveryKind(dataDir: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids[FEATURE] = (await createFeatureDoc(dataDir, FEATURE, featureDoc())).docId;
  ids[ROADMAP_PAGE] = (await createPageDoc(dataDir, ROADMAP_PAGE, pageDoc("Auth"))).docId;
  ids[TASK_PAGE] = (await createPageDoc(dataDir, TASK_PAGE, pageDoc("Ship it"))).docId;
  ids[MODEL] = (await createFileDoc(dataDir, MODEL, modelDoc())).docId;
  ids.testing = (await createTestingDoc(dataDir, newTestingDoc())).docId;
  return ids;
}

/** Shuffle a mirrored-layout store into the shape an older app version wrote. */
async function toLegacyLayout(dataDir: string): Promise<void> {
  const am = join(dataDir, AUTOMERGE_ROOT);
  await mkdir(join(am, "features"), { recursive: true });
  await rename(join(am, "specs"), join(am, "features", "specs"));
  await mkdir(join(am, "docs"), { recursive: true });
  for (const folder of ["roadmap", "tasks", "notebook"]) {
    if (await directoryExists(join(am, folder))) await rename(join(am, folder), join(am, "docs", folder));
  }
  if (await directoryExists(join(am, "event-models"))) {
    await mkdir(join(am, "models"), { recursive: true });
    await rename(join(am, "event-models"), join(am, "models", "models"));
  }
  if (await directoryExists(join(am, "test-management"))) {
    await rename(join(am, "test-management"), join(am, "testing"));
  }
  // The empty per-folder directories the specs-folder move left behind on
  // every clone (git never tracked them).
  await mkdir(join(am, "features", "agents"), { recursive: true });
  await mkdir(join(am, "features", "app"), { recursive: true });
}

async function docid(dataDir: string, dirRel: string): Promise<string> {
  return (await readFile(join(dataDir, dirRel, "docid"), "utf8")).trim();
}

test("a document's directory mirrors its source path under the store root", () => {
  expect(docDirRel(FEATURE)).toBe(".specdriven/automerge/specs/policy/quote-policy.feature.md");
  expect(pageDocDirRel(ROADMAP_PAGE)).toBe(".specdriven/automerge/roadmap/auth.md");
  expect(pageDocDirRel(TASK_PAGE)).toBe(".specdriven/automerge/tasks/ship-it.md");
  expect(pageDocDirRel("notebook/2026-09-12-worktrees.md")).toBe(
    ".specdriven/automerge/notebook/2026-09-12-worktrees.md",
  );
  expect(fileDocDirRel(MODEL)).toBe(".specdriven/automerge/event-models/cart.model.json");
  expect(fileDocDirRel("models/claims/home.model.json")).toBe(
    ".specdriven/automerge/event-models/claims/home.model.json",
  );
  expect(testingDocDirRel()).toBe(".specdriven/automerge/test-management/project");
});

test("the drift pass can tell a feature's docid path from any other conflicted path", () => {
  expect(featureFileOfDocidPath(".specdriven/automerge/specs/policy/quote-policy.feature.md/docid")).toBe(FEATURE);
  expect(featureFileOfDocidPath(".specdriven/automerge/specs/policy/quote-policy.feature.md/snapshot-1.bin")).toBeNull();
  expect(featureFileOfDocidPath(".specdriven/automerge/roadmap/auth.md/docid")).toBeNull();
  expect(featureFileOfDocidPath("specs/policy/quote-policy.feature.md")).toBeNull();
});

test("listings walk the mirrored folders and come back with the source folder in front", async () => {
  await seedEveryKind(root);
  expect(await listFeatureDocs(root)).toEqual([FEATURE]);
  expect(await listPageDocs(root, "roadmap")).toEqual([ROADMAP_PAGE]);
  expect(await listPageDocs(root, "tasks")).toEqual([TASK_PAGE]);
  expect(await listPageDocs(root, "notebook")).toEqual([]);
  expect(await listFileDocs(root, "models", ".model.json")).toEqual([MODEL]);
  const top = (await readdir(join(root, AUTOMERGE_ROOT))).sort();
  expect(top).toEqual(["event-models", "roadmap", "specs", "tasks", "test-management"]);
});

test("the migration lifts every kind out of the old roots in one commit, identities intact", async () => {
  setGitEngine("cli");
  const { a: data, originDir } = await twoClones(root);
  const ids = await seedEveryKind(data);
  await toLegacyLayout(data);
  await git(data, "add", "-A");
  await git(data, "commit", "-m", "old layout");
  await git(data, "push");
  const before = (await $`git -C ${data} rev-list --count HEAD`.text()).trim();

  expect(await migrateAutomergeLayout(data)).toBe(5);

  const am = join(data, AUTOMERGE_ROOT);
  expect((await readdir(am)).sort()).toEqual(["event-models", "roadmap", "specs", "tasks", "test-management"]);
  expect(await docid(data, docDirRel(FEATURE))).toBe(ids[FEATURE]!);
  expect(await docid(data, pageDocDirRel(ROADMAP_PAGE))).toBe(ids[ROADMAP_PAGE]!);
  expect(await docid(data, pageDocDirRel(TASK_PAGE))).toBe(ids[TASK_PAGE]!);
  expect(await docid(data, fileDocDirRel(MODEL))).toBe(ids[MODEL]!);
  expect(await docid(data, testingDocDirRel())).toBe(ids.testing!);
  expect((await loadFeatureDoc(data, FEATURE))?.docId).toBe(ids[FEATURE]!);
  expect((await loadPageDoc(data, ROADMAP_PAGE))?.doc.name).toBe("Auth");
  expect((await loadFileDoc<{ name: string }>(data, MODEL))?.doc.name).toBe("Cart");
  expect((await loadTestingDoc(data))?.docId).toBe(ids.testing!);

  // One commit of pure renames, pushed, tree clean.
  const after = (await $`git -C ${data} rev-list --count HEAD`.text()).trim();
  expect(Number(after)).toBe(Number(before) + 1);
  const subject = (await $`git -C ${data} log -1 --format=%s`.text()).trim();
  expect(subject).toBe("Move Automerge documents to the mirrored layout");
  const status = (await $`git -C ${data} status --porcelain`.text()).trim();
  expect(status).toBe("");
  const changes = (await $`git -C ${data} show --name-status -M --format= HEAD`.text())
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(changes.length).toBeGreaterThan(0);
  for (const line of changes) expect(line.startsWith("R100")).toBe(true);
  const originSubject = (await $`git -C ${originDir} log -1 --format=%s`.text()).trim();
  expect(originSubject).toBe("Move Automerge documents to the mirrored layout");

  // Every tick after the first: nothing to do, nothing committed.
  expect(await migrateAutomergeLayout(data)).toBe(0);
  expect((await $`git -C ${data} rev-list --count HEAD`.text()).trim()).toBe(after);
});

test("a document already at its new place absorbs the old directory's chunks", async () => {
  // A peer migrated and pushed; this clone still holds the old directory
  // with one change the peer never saw.
  const created = await createFeatureDoc(root, FEATURE, featureDoc());
  const am = join(root, AUTOMERGE_ROOT);
  const oldDir = join(am, "features", FEATURE);
  await mkdir(join(am, "features", "specs", "policy"), { recursive: true });
  await cp(join(root, docDirRel(FEATURE)), oldDir, { recursive: true });
  const next = A.change(A.clone(created.doc), (d) => {
    A.updateText(d, ["name"], "Quote Policy v2");
  });
  await saveFeatureDoc(root, FEATURE, next, created.heads);
  const newDir = join(root, docDirRel(FEATURE));
  const changeFile = (await readdir(newDir)).find((f) => f.startsWith("changes-"))!;
  await rename(join(newDir, changeFile), join(oldDir, changeFile));
  expect((await loadFeatureDoc(root, FEATURE))?.doc.name).toBe("Quote Policy");

  expect(await migrateAutomergeLayout(root)).toBe(1);

  expect(await directoryExists(join(am, "features"))).toBe(false);
  expect(await fileExists(join(newDir, changeFile))).toBe(true);
  const loaded = await loadFeatureDoc(root, FEATURE);
  expect(loaded?.docId).toBe(created.docId);
  expect(loaded?.doc.name).toBe("Quote Policy v2");
});

test("outside a git repository the move happens on disk alone", async () => {
  await seedEveryKind(root);
  await toLegacyLayout(root);
  expect(await migrateAutomergeLayout(root)).toBe(5);
  expect((await readdir(join(root, AUTOMERGE_ROOT))).sort()).toEqual([
    "event-models",
    "roadmap",
    "specs",
    "tasks",
    "test-management",
  ]);
  expect(await migrateAutomergeLayout(root)).toBe(0);
});

test("a feature the specs-folder move has not reached yet is left for it", async () => {
  await createFeatureDoc(root, "specs/stray.feature.md", featureDoc("Stray"));
  const am = join(root, AUTOMERGE_ROOT);
  await mkdir(join(am, "features"), { recursive: true });
  // As an app from before either move filed it: straight under `features/`.
  await rename(join(am, "specs", "stray.feature.md"), join(am, "features", "stray.feature.md"));
  await rm(join(am, "specs"), { recursive: true, force: true });
  expect(await migrateAutomergeLayout(root)).toBe(0);
  expect(await fileExists(join(am, "features", "stray.feature.md", "docid"))).toBe(true);
});

test("the sync tick lifts an old-layout clone and its features keep their identity", async () => {
  setGitEngine("cli");
  const { a: data } = await twoClones(root);
  await writeState({ dataRepo: "a" }, root);
  const { docId } = await createFeatureDoc(data, "specs/seed.feature.md", featureDoc("Seed"));
  await toLegacyLayout(data);
  await git(data, "add", "-A");
  await git(data, "commit", "-m", "old layout");
  await git(data, "push");

  const message = await reloadData(root);
  expect(message).toContain("moved 1 document(s) to the mirrored automerge layout");
  expect((await loadFeatureDoc(data, "specs/seed.feature.md"))?.docId).toBe(docId);
  expect(await directoryExists(join(data, AUTOMERGE_ROOT, "features"))).toBe(false);
  expect(await migrateAutomergeLayout(data)).toBe(0);
});
