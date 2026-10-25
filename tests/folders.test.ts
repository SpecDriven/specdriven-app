import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  createFolder,
  deleteFolder,
  listFeatures,
  listFolderDescriptions,
  listFolderOrders,
  listFolders,
  moveFeature,
  readFolderDescription,
  readFolderOrder,
  readFeature,
  renameFeature,
  renameFolder,
  setFolderDescription,
  setFolderOrder,
} from "../src/server/features";
import { setGitEngine } from "../src/server/git";
import type { GitEngine } from "../src/server/git";
import {
  buildTree,
  featuresBeneath,
  findFolder,
  folderDrop,
  folderLabel,
  folderNamesMoved,
  folderOptions,
  folderRenamed,
} from "../src/frontend/tree";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;
let fakeGh: FakeGh | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-folders-"));
});

afterEach(async () => {
  stopServers();
  fakeGh?.restore();
  fakeGh = null;
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

// specs/ui/folders.feature.md: feature files anywhere in the tree are listed
// with folder-relative paths; hidden directories are not part of the tree.
test("listFeatures recurses into folders; listFolders sees empty ones", async () => {
  await mkdir(join(root, "specs/billing/sub"), { recursive: true });
  await mkdir(join(root, "specs/empty"), { recursive: true });
  await mkdir(join(root, ".git/objects"), { recursive: true });
  await Bun.write(join(root, "specs/top.feature.md"), "# Top\n");
  await Bun.write(join(root, "specs/billing/quotes.feature.md"), "# Quotes\n");
  await Bun.write(join(root, "specs/billing/sub/deep.feature.md"), "# Deep\n");
  await Bun.write(join(root, ".git/objects/x.feature.md"), "# Hidden\n");
  // A feature outside the spec tree is not listed — only `specs/` is walked.
  await Bun.write(join(root, "outside.feature.md"), "# Outside\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "specs/billing/quotes.feature.md", name: "Quotes", scenarios: [] },
    { fileName: "specs/billing/sub/deep.feature.md", name: "Deep", scenarios: [] },
    { fileName: "specs/top.feature.md", name: "Top", scenarios: [] },
  ]);
  expect(await listFolders(root)).toEqual([
    "specs/billing",
    "specs/billing/sub",
    "specs/empty",
  ]);
});

test("createFolder slugifies segments and refuses duplicates", async () => {
  expect(await createFolder(root, "Billing Stuff/Sub Folder!")).toBe(
    "specs/billing-stuff/sub-folder",
  );
  expect(await listFolders(root)).toEqual([
    "specs/billing-stuff",
    "specs/billing-stuff/sub-folder",
  ]);
  expect(createFolder(root, "billing-stuff")).rejects.toThrow("already exists");
  expect(createFolder(root, "  ")).rejects.toThrow("required");
  // traversal segments don't survive slugification — no escape from the repo
  expect(await createFolder(root, "../evil")).toBe("specs/evil");
  // the caller may name the tree it is already in; the prefix is not doubled
  expect(await createFolder(root, "specs/Reports")).toBe("specs/reports");
});

// specs/ui/folders.feature.md: a `/` in the New feature name creates the
// feature inside a folder, creating folders as needed.
test("createFeature places a feature inside a folder via a / path", async () => {
  const fileName = await createFeature(root, "billing/Basic Quote");
  expect(fileName).toBe("specs/billing/basic-quote.feature.md");
  expect(await readFeature(root, fileName)).toBe("# Basic Quote\n");
  expect(await listFolders(root)).toEqual(["specs/billing"]);
});

test("moveFeature refuses missing folders, collisions and traversal", async () => {
  await mkdir(join(root, "specs/billing"), { recursive: true });
  await Bun.write(join(root, "specs/one.feature.md"), "# One\n");
  await Bun.write(join(root, "specs/billing/one.feature.md"), "# Other One\n");
  expect(moveFeature(root, "specs/one.feature.md", "specs/ghost")).rejects.toThrow(
    "Folder not found",
  );
  expect(moveFeature(root, "specs/one.feature.md", "specs/billing")).rejects.toThrow(
    "already exists",
  );
  expect(moveFeature(root, "specs/one.feature.md", "../evil")).rejects.toThrow("Invalid folder");
  expect(moveFeature(root, "specs/ghost.feature.md", "specs/billing")).rejects.toThrow(
    /not found/,
  );
  // moving to where it already is: a no-op, not an error
  expect(await moveFeature(root, "specs/one.feature.md", "")).toEqual({
    fileName: "specs/one.feature.md",
    message: "already there",
  });
});

test("moveFeature works in a plain directory (no git repo)", async () => {
  await mkdir(join(root, "specs/billing"), { recursive: true });
  await Bun.write(join(root, "specs/one.feature.md"), "# One\n");
  const result = await moveFeature(root, "specs/one.feature.md", "specs/billing");
  expect(result.fileName).toBe("specs/billing/one.feature.md");
  expect(await readFeature(root, "specs/billing/one.feature.md")).toBe("# One\n");
  expect(await readFeature(root, "specs/one.feature.md")).toBeNull();
});

// specs/ui/folders.feature.md: only an empty folder can be deleted — features
// must be moved out first. Nested empty folders (and macOS .DS_Store junk)
// don't block deletion.
test("deleteFolder deletes empty folders only", async () => {
  await mkdir(join(root, "specs/empty/nested"), { recursive: true });
  await Bun.write(join(root, "specs/empty/nested/.DS_Store"), "junk");
  await mkdir(join(root, "specs/full"), { recursive: true });
  await Bun.write(join(root, "specs/full/one.feature.md"), "# One\n");
  // What moving the last feature out leaves behind: the folder's empty
  // Automerge mirror. It goes with the folder.
  await mkdir(join(root, ".specdriven/automerge/specs/empty"), { recursive: true });
  // A mirror that still holds a document is not ours to sweep.
  await mkdir(join(root, "specs/orphan"), { recursive: true });
  await mkdir(join(root, ".specdriven/automerge/specs/orphan/gone.feature.md"), { recursive: true });
  await Bun.write(join(root, ".specdriven/automerge/specs/orphan/gone.feature.md/docid"), "id");

  await deleteFolder(root, "specs/empty");
  expect(await listFolders(root)).toEqual(["specs/full", "specs/orphan"]);
  expect(await Bun.file(join(root, ".specdriven/automerge/specs/empty")).exists()).toBe(false);
  await deleteFolder(root, "specs/orphan");
  expect(await listFolders(root)).toEqual(["specs/full"]);
  expect(await Bun.file(join(root, ".specdriven/automerge/specs/orphan/gone.feature.md/docid")).exists()).toBe(true);

  expect(deleteFolder(root, "specs/full")).rejects.toThrow("not empty");
  expect(deleteFolder(root, "specs/ghost")).rejects.toThrow("Folder not found");
  expect(deleteFolder(root, "")).rejects.toThrow("required");
  expect(deleteFolder(root, "..")).rejects.toThrow("Invalid folder");
  expect(await readFeature(root, "specs/full/one.feature.md")).toBe("# One\n");
});

// specs/ui/folders.feature.md "delete a folder with features in it": without
// force the refusal stands; with it the folder, its features and their
// documents go, and what git never tracked is swept away after.
test("deleteFolder with force removes a folder with features in it", async () => {
  await mkdir(join(root, "specs/full/sub"), { recursive: true });
  await mkdir(join(root, ".specdriven/automerge/specs/full/one.feature.md"), { recursive: true });
  await Bun.write(join(root, "specs/full/one.feature.md"), "# One\n");
  await Bun.write(join(root, "specs/full/sub/two.feature.md"), "# Two\n");
  await Bun.write(join(root, "specs/full/sub/.DS_Store"), "junk");
  await Bun.write(join(root, "specs/keep.feature.md"), "# Keep\n");
  expect(deleteFolder(root, "specs/full")).rejects.toThrow("not empty");
  const result = await deleteFolder(root, "specs/full", { force: true });
  expect(result.features).toBe(2);
  expect(await listFolders(root)).toEqual([]);
  expect(await listFeatures(root)).toEqual([{ fileName: "specs/keep.feature.md", name: "Keep", scenarios: [] }]);
  expect(await Bun.file(join(root, ".specdriven/automerge/specs/full")).exists()).toBe(false);
  // the root is never a folder to delete, forced or not
  expect(deleteFolder(root, "specs", { force: true })).rejects.toThrow("required");
});

// specs/ui/folders.feature.md "rename a folder": the last segment changes,
// slugified; the folder keeps its parent; an empty one is renamed on disk.
test("renameFolder renames in place, slugified, refusing collisions", async () => {
  await mkdir(join(root, "specs/billing/sub"), { recursive: true });
  await mkdir(join(root, "specs/taken"), { recursive: true });
  expect(await renameFolder(root, "specs/billing/sub", "Old Quotes!")).toEqual({
    path: "specs/billing/old-quotes",
    message: "renamed locally (git does not track an empty folder)",
  });
  expect(await listFolders(root)).toEqual(["specs/billing", "specs/billing/old-quotes", "specs/taken"]);
  expect(await renameFolder(root, "billing", "billing")).toEqual({ path: "specs/billing", message: "already named that" });
  expect(renameFolder(root, "specs/billing", "taken")).rejects.toThrow("already exists");
  expect(renameFolder(root, "specs/ghost", "x")).rejects.toThrow("Folder not found");
  expect(renameFolder(root, "specs/billing", "  ")).rejects.toThrow("required");
  expect(renameFolder(root, "", "x")).rejects.toThrow("required");
  expect(renameFolder(root, "..", "x")).rejects.toThrow("Invalid folder");
  // a `/` in the new name does not move the folder elsewhere: the last segment is the name
  expect(await renameFolder(root, "specs/taken", "a/b")).toEqual({
    path: "specs/b",
    message: "renamed locally (git does not track an empty folder)",
  });
});

test("renameFolder works in a plain directory with features (no git repo)", async () => {
  await mkdir(join(root, "specs/billing"), { recursive: true });
  await Bun.write(join(root, "specs/billing/one.feature.md"), "# One\n");
  const result = await renameFolder(root, "specs/billing", "invoices");
  expect(result.path).toBe("specs/invoices");
  expect(await readFeature(root, "specs/invoices/one.feature.md")).toBe("# One\n");
  expect(await readFeature(root, "specs/billing/one.feature.md")).toBeNull();
});

// The sidebar's folder helpers (src/frontend/tree.ts): what a folder holds,
// where paths land after a rename, and the list "Move to folder…" offers.
test("featuresBeneath, folderRenamed and folderOptions", () => {
  const tree = buildTree(
    ["specs/billing", "specs/billing/sub", "specs/empty"],
    [
      { fileName: "specs/top.feature.md", name: "Top", scenarios: [] },
      { fileName: "specs/billing/quotes.feature.md", name: "Quotes", scenarios: [] },
      { fileName: "specs/billing/sub/deep.feature.md", name: "Deep", scenarios: [] },
    ],
  );
  expect(featuresBeneath(tree)).toBe(3);
  expect(featuresBeneath(findFolder(tree, "specs/billing")!)).toBe(2);
  expect(featuresBeneath(findFolder(tree, "specs/empty")!)).toBe(0);
  expect(findFolder(tree, "specs/ghost")).toBeNull();

  expect(folderRenamed("specs/billing", "specs/billing", "specs/invoices")).toBe("specs/invoices");
  expect(folderRenamed("specs/billing/sub/deep.feature.md", "specs/billing", "specs/invoices")).toBe(
    "specs/invoices/sub/deep.feature.md",
  );
  // a sibling that merely shares the prefix is not beneath it
  expect(folderRenamed("specs/billing-old/x.feature.md", "specs/billing", "specs/invoices")).toBe(
    "specs/billing-old/x.feature.md",
  );

  expect(folderOptions(tree)).toEqual([
    { value: "specs", label: "Top level", hint: "" },
    { value: "specs/billing", label: "billing", hint: "" },
    { value: "specs/billing/sub", label: "sub", hint: "billing" },
    { value: "specs/empty", label: "empty", hint: "" },
  ]);
  // the folder the feature is in is not offered
  expect(folderOptions(tree, "specs/billing").map((o) => o.value)).toEqual([
    "specs",
    "specs/billing/sub",
    "specs/empty",
  ]);
  expect(folderOptions(tree, "specs").map((o) => o.value)).toEqual([
    "specs/billing",
    "specs/billing/sub",
    "specs/empty",
  ]);
});

// specs/ui/folders.feature.md: the Edit link edits the feature name only — the
// file keeps its name and folder.
test("renameFeature edits the name in place, keeping file and folder", async () => {
  await mkdir(join(root, "billing"));
  await Bun.write(join(root, "specs/billing/one.feature.md"), "# One\n");
  const renamed = await renameFeature(root, "specs/billing/one.feature.md", "Uno");
  expect(renamed.fileName).toBe("specs/billing/one.feature.md");
  expect(await readFeature(root, "specs/billing/one.feature.md")).toBe("# Uno\n");
});

// The tree is rooted at `specs/` — the storage prefix is not a folder the
// sidebar shows — while every path stays repo-relative for the move API.
test("buildTree arranges folders and features, folders first, sorted", () => {
  const tree = buildTree(
    ["specs/billing", "specs/billing/sub", "specs/empty"],
    [
      { fileName: "specs/zeta.feature.md", name: "Zeta", scenarios: [] },
      { fileName: "specs/billing/quotes.feature.md", name: "Quotes", scenarios: [] },
      { fileName: "specs/billing/sub/deep.feature.md", name: "Deep", scenarios: [] },
      { fileName: "specs/alpha.feature.md", name: "Alpha", scenarios: [] },
      // a feature whose folder is missing from the folder list still lands
      { fileName: "specs/implied/one.feature.md", name: "One", scenarios: [] },
    ],
  );
  expect(tree.path).toBe("specs");
  expect(tree.folders.map((f) => f.path)).toEqual([
    "specs/billing",
    "specs/empty",
    "specs/implied",
  ]);
  expect(tree.features.map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  const billing = tree.folders[0]!;
  expect(billing.name).toBe("billing");
  expect(billing.folders.map((f) => f.path)).toEqual(["specs/billing/sub"]);
  expect(billing.features.map((f) => f.name)).toEqual(["Quotes"]);
  expect(billing.folders[0]!.features.map((f) => f.name)).toEqual(["Deep"]);
});

// specs/ui/folders.feature.md "describe a folder": a display-name.txt in a
// folder gives it a display name — its first non-blank line, trimmed. A
// folder without one, or with a blank one, has none. A description.txt — the
// file's name before display-name.txt — still counts when there is no
// display-name.txt.
test("readFolderDescription and listFolderDescriptions read display-name.txt", async () => {
  await mkdir(join(root, "specs/billing/sub"), { recursive: true });
  await mkdir(join(root, "specs/plain"), { recursive: true });
  await mkdir(join(root, "specs/blank"), { recursive: true });
  await mkdir(join(root, "specs/legacy"), { recursive: true });
  await mkdir(join(root, "specs/both"), { recursive: true });
  await Bun.write(join(root, "specs/billing/display-name.txt"), "Billing and invoicing\n");
  // leading blank lines and surrounding space are not part of the name,
  // and only the first line counts
  await Bun.write(join(root, "specs/billing/sub/display-name.txt"), "\r\n  Sub-ledgers  \r\nmore words\n");
  await Bun.write(join(root, "specs/blank/display-name.txt"), "\n   \n");
  await Bun.write(join(root, "specs/legacy/description.txt"), "Old style\n");
  await Bun.write(join(root, "specs/both/description.txt"), "Old\n");
  await Bun.write(join(root, "specs/both/display-name.txt"), "New\n");
  expect(await readFolderDescription(root, "specs/billing")).toBe("Billing and invoicing");
  expect(await readFolderDescription(root, "billing/sub")).toBe("Sub-ledgers");
  expect(await readFolderDescription(root, "specs/plain")).toBeNull();
  expect(await readFolderDescription(root, "specs/blank")).toBeNull();
  expect(await readFolderDescription(root, "specs/ghost")).toBeNull();
  expect(await readFolderDescription(root, "specs/legacy")).toBe("Old style");
  expect(await readFolderDescription(root, "specs/both")).toBe("New");
  expect(await listFolderDescriptions(root)).toEqual({
    "specs/billing": "Billing and invoicing",
    "specs/billing/sub": "Sub-ledgers",
    "specs/both": "New",
    "specs/legacy": "Old style",
  });
  // the display-name file is not a feature, and does not make the folder one
  expect(await listFeatures(root)).toEqual([]);
  expect(await listFolders(root)).toEqual([
    "specs/billing",
    "specs/billing/sub",
    "specs/blank",
    "specs/both",
    "specs/legacy",
    "specs/plain",
  ]);
});

// specs/ui/folders.feature.md "edit a folder's display name": outside a git
// repository the file is written (and removed) all the same; the folder
// itself never moves.
test("setFolderDescription writes, keeps extra lines, and clears display-name.txt", async () => {
  await mkdir(join(root, "specs/billing"), { recursive: true });
  expect(await setFolderDescription(root, "specs/billing", "  Billing  ")).toEqual({
    description: "Billing",
    message: "saved locally (not a git repository)",
  });
  expect(await Bun.file(join(root, "specs/billing/display-name.txt")).text()).toBe("Billing\n");
  expect(await setFolderDescription(root, "specs/billing", "Billing")).toEqual({
    description: "Billing",
    message: "display name unchanged",
  });
  // only the first non-blank line is the name; the rest is kept
  await Bun.write(join(root, "specs/billing/display-name.txt"), "\nBilling\nNotes for GitHub readers\n");
  await setFolderDescription(root, "billing", "Invoices");
  expect(await Bun.file(join(root, "specs/billing/display-name.txt")).text()).toBe(
    "\nInvoices\nNotes for GitHub readers\n",
  );
  expect(await listFolders(root)).toEqual(["specs/billing"]);
  expect(await setFolderDescription(root, "specs/billing", "   ")).toEqual({
    description: null,
    message: "deleted locally (not a git repository)",
  });
  expect(await Bun.file(join(root, "specs/billing/display-name.txt")).exists()).toBe(false);
  expect(await readFolderDescription(root, "specs/billing")).toBeNull();
  expect(await setFolderDescription(root, "specs/billing", "")).toEqual({
    description: null,
    message: "no display name to clear",
  });
  await expect(setFolderDescription(root, "specs/ghost", "Ghost")).rejects.toThrow("Folder not found: specs/ghost");
  await expect(setFolderDescription(root, "specs", "Root")).rejects.toThrow("Folder name is required");
});

// The sidebar labels a described folder by its description and every other
// by its name; the order stays the folders' own.
test("buildTree carries folder descriptions; folderLabel falls back to the name", () => {
  const tree = buildTree(
    ["specs/billing", "specs/billing/sub", "specs/empty"],
    [{ fileName: "specs/billing/quotes.feature.md", name: "Quotes", scenarios: [] }],
    { "specs/billing": "Billing and invoicing", "specs/ghost": "Not in the tree" },
  );
  const billing = findFolder(tree, "specs/billing")!;
  expect(billing.description).toBe("Billing and invoicing");
  expect(folderLabel(billing)).toBe("Billing and invoicing");
  const sub = findFolder(tree, "specs/billing/sub")!;
  expect(sub.description).toBeUndefined();
  expect(folderLabel(sub)).toBe("sub");
  expect(folderLabel(findFolder(tree, "specs/empty")!)).toBe("empty");
  expect(tree.folders.map((f) => f.path)).toEqual(["specs/billing", "specs/empty"]);
  // without a map, nothing changes
  expect(findFolder(buildTree(["specs/billing"], []), "specs/billing")!.description).toBeUndefined();
});

// specs/ui/folders.feature.md "order folders": a folder-order.txt names a
// folder's subfolders in the order the sidebar shows them — one per line,
// blank and repeated lines dropped. The top level's lives in specs/ itself.
test("readFolderOrder and listFolderOrders read folder-order.txt", async () => {
  await mkdir(join(root, "specs/billing/sub"), { recursive: true });
  await mkdir(join(root, "specs/billing/other"), { recursive: true });
  await mkdir(join(root, "specs/alpha"), { recursive: true });
  await Bun.write(join(root, "specs/folder-order.txt"), "billing\n\n alpha \nbilling\n");
  await Bun.write(join(root, "specs/billing/folder-order.txt"), "sub\r\nother\r\n");
  expect(await readFolderOrder(root, "specs")).toEqual(["billing", "alpha"]);
  expect(await readFolderOrder(root, "")).toEqual(["billing", "alpha"]);
  expect(await readFolderOrder(root, "billing")).toEqual(["sub", "other"]);
  expect(await readFolderOrder(root, "specs/alpha")).toEqual([]);
  expect(await listFolderOrders(root)).toEqual({
    specs: ["billing", "alpha"],
    "specs/billing": ["sub", "other"],
  });
  // the order file is not a feature, and not a folder
  expect(await listFeatures(root)).toEqual([]);
  expect(await listFolders(root)).toEqual([
    "specs/alpha",
    "specs/billing",
    "specs/billing/other",
    "specs/billing/sub",
  ]);
});

// setFolderOrder takes the subfolders' own names, every one a direct
// subfolder of the folder, and writes them one per line; the same order
// again writes nothing.
test("setFolderOrder writes folder-order.txt, refusing names that are not subfolders", async () => {
  await mkdir(join(root, "specs/billing/sub"), { recursive: true });
  await mkdir(join(root, "specs/billing/other"), { recursive: true });
  await mkdir(join(root, "specs/alpha"), { recursive: true });
  expect(await setFolderOrder(root, "specs", ["billing", " alpha "])).toEqual({
    folders: ["billing", "alpha"],
    message: "saved locally (not a git repository)",
  });
  expect(await Bun.file(join(root, "specs/folder-order.txt")).text()).toBe("billing\nalpha\n");
  expect(await setFolderOrder(root, "", ["billing", "alpha"])).toEqual({
    folders: ["billing", "alpha"],
    message: "folder order unchanged",
  });
  expect(await setFolderOrder(root, "billing", ["other", "sub"])).toMatchObject({ folders: ["other", "sub"] });
  expect(await Bun.file(join(root, "specs/billing/folder-order.txt")).text()).toBe("other\nsub\n");
  // a partial list is allowed: the rest sort after it by name
  expect(await setFolderOrder(root, "specs", ["alpha"])).toMatchObject({ folders: ["alpha"] });
  await expect(setFolderOrder(root, "specs", ["ghost"])).rejects.toThrow("Not a folder in specs: ghost");
  await expect(setFolderOrder(root, "specs", ["billing/sub"])).rejects.toThrow("Invalid folder name: billing/sub");
  await expect(setFolderOrder(root, "specs", [])).rejects.toThrow("Folder order is required");
  await expect(setFolderOrder(root, "specs/ghost", ["x"])).rejects.toThrow("Folder not found: specs/ghost");
  // a renamed subfolder keeps its place in the parent's order
  await setFolderOrder(root, "specs", ["billing", "alpha"]);
  expect(await renameFolder(root, "specs/billing", "Invoices")).toMatchObject({ path: "specs/invoices" });
  expect(await readFolderOrder(root, "specs")).toEqual(["invoices", "alpha"]);
});

// The sidebar puts a folder's subfolders in its folder-order.txt order, the
// ones it leaves out after them by name; a stale name orders nothing.
test("buildTree orders subfolders by folder order, the rest by name", () => {
  const tree = buildTree(
    ["specs/alpha", "specs/billing", "specs/billing/other", "specs/billing/sub", "specs/zeta"],
    [{ fileName: "specs/billing/quotes.feature.md", name: "Quotes", scenarios: [] }],
    {},
    { specs: ["zeta", "ghost", "billing"], "specs/billing": ["sub"] },
  );
  expect(tree.folders.map((f) => f.name)).toEqual(["zeta", "billing", "alpha"]);
  expect(findFolder(tree, "specs/billing")!.folders.map((f) => f.name)).toEqual(["sub", "other"]);
  // without orders, by name
  expect(buildTree(["specs/zeta", "specs/alpha"], []).folders.map((f) => f.name)).toEqual(["alpha", "zeta"]);
});

// Move up / Move down send every sibling in the new order; a drop on a
// sibling's row lands before or after it, as a scenario drop does.
test("folderNamesMoved and folderDrop", () => {
  const siblings = ["a", "b", "c", "d"].map((name) => ({ name, path: `specs/${name}` }));
  expect(folderNamesMoved(siblings, 1, 0)).toEqual(["b", "a", "c", "d"]);
  expect(folderNamesMoved(siblings, 1, 2)).toEqual(["a", "c", "b", "d"]);
  expect(folderNamesMoved(siblings, 0, 3)).toEqual(["b", "c", "d", "a"]);
  expect(folderNamesMoved(siblings, 2, 2)).toBeNull();
  expect(folderNamesMoved(siblings, 0, -1)).toBeNull();
  expect(folderNamesMoved(siblings, 3, 4)).toBeNull();
  expect(folderDrop(siblings, "specs/d", "specs/b", false)).toEqual({ from: 3, to: 1 });
  expect(folderDrop(siblings, "specs/a", "specs/c", true)).toEqual({ from: 0, to: 2 });
  expect(folderDrop(siblings, "specs/a", "specs/c", false)).toEqual({ from: 0, to: 1 });
  expect(folderDrop(siblings, "specs/b", "specs/b", true)).toBeNull();
  expect(folderDrop(siblings, "specs/b", "specs/a", true)).toBeNull();
  expect(folderDrop(siblings, "specs/b", "specs/ghost", true)).toBeNull();
});

// The move flow runs on all three git engines (git-operations.md).
for (const engine of ["cli", "gh", "js"] as GitEngine[]) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // specs/ui/folders.feature.md: drag-move is a `git mv` into the target
    // directory, committed and pushed — the other clone sees it on pull.
    test("moveFeature moves between folders via git mv, commits and pushes", async () => {
      const { a, b } = await twoClones(root, {
        "specs/seed.feature.md": "# Seed\n",
        "specs/billing/quotes.feature.md": "# Quotes\n",
      });
      const result = await moveFeature(a, "specs/seed.feature.md", "billing");
      expect(result.fileName).toBe("specs/billing/seed.feature.md");
      expect(result.message).toBe("renamed, committed and pushed");
      expect(await readFeature(a, "specs/seed.feature.md")).toBeNull();
      expect(await readFeature(a, "specs/billing/seed.feature.md")).toBe("# Seed\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain(
        "Move feature: specs/seed.feature.md -> specs/billing/seed.feature.md",
      );
      await git(b, "pull");
      expect(await readFeature(b, "specs/billing/seed.feature.md")).toBe("# Seed\n");

      // and back out to the top level
      const back = await moveFeature(a, "specs/billing/seed.feature.md", "");
      expect(back.fileName).toBe("specs/seed.feature.md");
      expect(await readFeature(a, "specs/seed.feature.md")).toBe("# Seed\n");
    });

    // specs/ui/folders.feature.md "rename a folder": one `git mv` of the
    // directory carries every feature and its document; the other clone
    // sees the new folder on pull and nothing of the old one.
    test("renameFolder git-mvs the directory and its documents, commits and pushes", async () => {
      const { a, b } = await twoClones(root, {
        "specs/billing/quotes.feature.md": "# Quotes\n",
        "specs/billing/sub/deep.feature.md": "# Deep\n",
        ".specdriven/automerge/specs/billing/quotes.feature.md/snapshot.bin": "doc",
      });
      const result = await renameFolder(a, "specs/billing", "Invoices");
      expect(result).toEqual({ path: "specs/invoices", message: "renamed, committed and pushed" });
      expect(await listFolders(a)).toEqual(["specs/invoices", "specs/invoices/sub"]);
      expect(await readFeature(a, "specs/invoices/sub/deep.feature.md")).toBe("# Deep\n");
      expect(
        await Bun.file(join(a, ".specdriven/automerge/specs/invoices/quotes.feature.md/snapshot.bin")).exists(),
      ).toBe(true);
      expect(await Bun.file(join(a, ".specdriven/automerge/specs/billing")).exists()).toBe(false);
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Rename folder: specs/billing -> specs/invoices");
      await git(b, "pull");
      expect(await listFolders(b)).toEqual(["specs/invoices", "specs/invoices/sub"]);
      expect(await readFeature(b, "specs/invoices/quotes.feature.md")).toBe("# Quotes\n");
    });

    // specs/ui/folders.feature.md "delete a folder with features in it": a
    // forced delete is a `git rm -r`, committed and pushed.
    test("deleteFolder with force git-rms the directory, commits and pushes", async () => {
      const { a, b } = await twoClones(root, {
        "specs/keep.feature.md": "# Keep\n",
        "specs/billing/quotes.feature.md": "# Quotes\n",
        "specs/billing/sub/deep.feature.md": "# Deep\n",
        ".specdriven/automerge/specs/billing/quotes.feature.md/snapshot.bin": "doc",
      });
      const result = await deleteFolder(a, "specs/billing", { force: true });
      expect(result).toEqual({ features: 2, message: "deleted, committed and pushed" });
      expect(await listFolders(a)).toEqual([]);
      expect(await Bun.file(join(a, ".specdriven/automerge/specs/billing")).exists()).toBe(false);
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Delete folder: specs/billing (2 features)");
      await git(b, "pull");
      expect(await listFolders(b)).toEqual([]);
      expect(await readFeature(b, "specs/keep.feature.md")).toBe("# Keep\n");
    });

    // specs/ui/folders.feature.md "describe a folder": a folder with no
    // feature but a display-name.txt is one git tracks, so renaming it is a
    // `git mv`, committed and pushed, and the description comes along.
    test("renameFolder git-mvs a folder holding only a display-name.txt", async () => {
      const { a, b } = await twoClones(root, {
        "specs/keep.feature.md": "# Keep\n",
        "specs/billing/display-name.txt": "Billing and invoicing\n",
      });
      const result = await renameFolder(a, "specs/billing", "Invoices");
      expect(result).toEqual({ path: "specs/invoices", message: "renamed, committed and pushed" });
      expect(await listFolderDescriptions(a)).toEqual({ "specs/invoices": "Billing and invoicing" });
      await git(b, "pull");
      expect(await listFolders(b)).toEqual(["specs/invoices"]);
      expect(await listFolderDescriptions(b)).toEqual({ "specs/invoices": "Billing and invoicing" });
    });

    // ...and deleting it needs no "and its features" confirmation — there
    // are none — but is a `git rm -r` all the same, not a local sweep.
    test("deleteFolder removes a folder holding only a display-name.txt, committed and pushed", async () => {
      const { a, b } = await twoClones(root, {
        "specs/keep.feature.md": "# Keep\n",
        "specs/billing/display-name.txt": "Billing and invoicing\n",
      });
      const result = await deleteFolder(a, "specs/billing");
      expect(result).toEqual({ features: 0, message: "deleted, committed and pushed" });
      expect(await listFolders(a)).toEqual([]);
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Delete folder: specs/billing (0 features)");
      await git(b, "pull");
      expect(await listFolders(b)).toEqual([]);
      expect(await readFeature(b, "specs/keep.feature.md")).toBe("# Keep\n");
    });

    // specs/ui/folders.feature.md "edit a folder's display name": the new
    // name lands in display-name.txt, committed and pushed; clearing it is a
    // `git rm`. The other clone sees each on pull.
    test("setFolderDescription commits and pushes display-name.txt, and git-rms it when cleared", async () => {
      const { a, b } = await twoClones(root, {
        "specs/billing/quotes.feature.md": "# Quotes\n",
      });
      const set = await setFolderDescription(a, "specs/billing", "Billing and invoicing");
      expect(set).toEqual({ description: "Billing and invoicing", message: "committed and pushed" });
      let log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Set folder display name: specs/billing -> Billing and invoicing");
      await git(b, "pull");
      expect(await listFolderDescriptions(b)).toEqual({ "specs/billing": "Billing and invoicing" });

      const cleared = await setFolderDescription(a, "specs/billing", "");
      expect(cleared).toEqual({ description: null, message: "deleted, committed and pushed" });
      log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Clear folder display name: specs/billing");
      await git(b, "pull");
      expect(await listFolderDescriptions(b)).toEqual({});
      expect(await listFolders(b)).toEqual(["specs/billing"]);
    });

    // specs/ui/folders.feature.md "order folders": the new order lands in
    // folder-order.txt, committed and pushed, and a rename keeps the
    // folder's place in it. The other clone sees each on pull.
    test("setFolderOrder commits and pushes folder-order.txt; renameFolder keeps the place", async () => {
      const { a, b } = await twoClones(root, {
        "specs/alpha/one.feature.md": "# One\n",
        "specs/billing/quotes.feature.md": "# Quotes\n",
      });
      const set = await setFolderOrder(a, "specs", ["billing", "alpha"]);
      expect(set).toEqual({ folders: ["billing", "alpha"], message: "committed and pushed" });
      let log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Reorder folders in: specs");
      await git(b, "pull");
      expect(await listFolderOrders(b)).toEqual({ specs: ["billing", "alpha"] });

      await renameFolder(a, "specs/billing", "Invoices");
      expect(await readFolderOrder(a, "specs")).toEqual(["invoices", "alpha"]);
      log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Reorder folders in: specs");
      const status = await git(a, "status", "--porcelain");
      expect(status.stdout.toString()).toBe("");
      await git(b, "pull");
      expect(await listFolderOrders(b)).toEqual({ specs: ["invoices", "alpha"] });
      expect(await listFolders(b)).toEqual(["specs/alpha", "specs/invoices"]);
    });

    // A legacy description.txt moves over to display-name.txt in the same
    // commit, its extra lines with it.
    test("setFolderDescription moves a legacy description.txt to display-name.txt", async () => {
      const { a, b } = await twoClones(root, {
        "specs/billing/quotes.feature.md": "# Quotes\n",
        "specs/billing/description.txt": "Billing\nMore about billing\n",
      });
      await setFolderDescription(a, "specs/billing", "Invoices");
      await git(b, "pull");
      expect(await Bun.file(join(b, "specs/billing/description.txt")).exists()).toBe(false);
      expect(await Bun.file(join(b, "specs/billing/display-name.txt")).text()).toBe("Invoices\nMore about billing\n");
      const status = await git(a, "status", "--porcelain");
      expect(status.stdout.toString()).toBe("");
    });
  });
}
