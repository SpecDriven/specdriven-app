import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  createFolder,
  deleteFolder,
  listFeatures,
  listFolders,
  moveFeature,
  readFeature,
  renameFeature,
} from "../src/server/features";
import { setGitEngine } from "../src/server/git";
import type { GitEngine } from "../src/server/git";
import { buildTree } from "../src/frontend/tree";
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

// specs/folders.spec.md: feature files anywhere in the tree are listed
// with folder-relative paths; hidden directories are not part of the tree.
test("listFeatures recurses into folders; listFolders sees empty ones", async () => {
  await mkdir(join(root, "billing/sub"), { recursive: true });
  await mkdir(join(root, "empty"));
  await mkdir(join(root, ".git/objects"), { recursive: true });
  await Bun.write(join(root, "top.feature.md"), "# Top\n");
  await Bun.write(join(root, "billing/quotes.feature.md"), "# Quotes\n");
  await Bun.write(join(root, "billing/sub/deep.feature.md"), "# Deep\n");
  await Bun.write(join(root, ".git/objects/x.feature.md"), "# Hidden\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "billing/quotes.feature.md", name: "Quotes" },
    { fileName: "billing/sub/deep.feature.md", name: "Deep" },
    { fileName: "top.feature.md", name: "Top" },
  ]);
  expect(await listFolders(root)).toEqual(["billing", "billing/sub", "empty"]);
});

test("createFolder slugifies segments and refuses duplicates", async () => {
  expect(await createFolder(root, "Billing Stuff/Sub Folder!")).toBe("billing-stuff/sub-folder");
  expect(await listFolders(root)).toEqual(["billing-stuff", "billing-stuff/sub-folder"]);
  expect(createFolder(root, "billing-stuff")).rejects.toThrow("already exists");
  expect(createFolder(root, "  ")).rejects.toThrow("required");
  // traversal segments don't survive slugification — no escape from the repo
  expect(await createFolder(root, "../evil")).toBe("evil");
});

// specs/folders.spec.md: a `/` in the New feature name creates the
// feature inside a folder, creating folders as needed.
test("createFeature places a feature inside a folder via a / path", async () => {
  const fileName = await createFeature(root, "billing/Basic Quote");
  expect(fileName).toBe("billing/basic-quote.feature.md");
  expect(await readFeature(root, fileName)).toBe("# Basic Quote\n");
  expect(await listFolders(root)).toEqual(["billing"]);
});

test("moveFeature refuses missing folders, collisions and traversal", async () => {
  await mkdir(join(root, "billing"));
  await Bun.write(join(root, "one.feature.md"), "# One\n");
  await Bun.write(join(root, "billing/one.feature.md"), "# Other One\n");
  expect(moveFeature(root, "one.feature.md", "ghost")).rejects.toThrow("Folder not found");
  expect(moveFeature(root, "one.feature.md", "billing")).rejects.toThrow("already exists");
  expect(moveFeature(root, "one.feature.md", "../evil")).rejects.toThrow("Invalid folder");
  expect(moveFeature(root, "ghost.feature.md", "billing")).rejects.toThrow(/not found/);
  // moving to where it already is: a no-op, not an error
  expect(await moveFeature(root, "one.feature.md", "")).toEqual({
    fileName: "one.feature.md",
    message: "already there",
  });
});

test("moveFeature works in a plain directory (no git repo)", async () => {
  await mkdir(join(root, "billing"));
  await Bun.write(join(root, "one.feature.md"), "# One\n");
  const result = await moveFeature(root, "one.feature.md", "billing");
  expect(result.fileName).toBe("billing/one.feature.md");
  expect(await readFeature(root, "billing/one.feature.md")).toBe("# One\n");
  expect(await readFeature(root, "one.feature.md")).toBeNull();
});

// specs/folders.spec.md: only an empty folder can be deleted — features
// must be moved out first. Nested empty folders (and macOS .DS_Store junk)
// don't block deletion.
test("deleteFolder deletes empty folders only", async () => {
  await mkdir(join(root, "empty/nested"), { recursive: true });
  await Bun.write(join(root, "empty/nested/.DS_Store"), "junk");
  await mkdir(join(root, "full"));
  await Bun.write(join(root, "full/one.feature.md"), "# One\n");

  await deleteFolder(root, "empty");
  expect(await listFolders(root)).toEqual(["full"]);

  expect(deleteFolder(root, "full")).rejects.toThrow("not empty");
  expect(deleteFolder(root, "ghost")).rejects.toThrow("Folder not found");
  expect(deleteFolder(root, "")).rejects.toThrow("required");
  expect(deleteFolder(root, "..")).rejects.toThrow("Invalid folder");
  expect(await readFeature(root, "full/one.feature.md")).toBe("# One\n");
});

// specs/folders.spec.md: the Edit link edits the feature name only — the
// file keeps its name and folder.
test("renameFeature edits the name in place, keeping file and folder", async () => {
  await mkdir(join(root, "billing"));
  await Bun.write(join(root, "billing/one.feature.md"), "# One\n");
  const renamed = await renameFeature(root, "billing/one.feature.md", "Uno");
  expect(renamed.fileName).toBe("billing/one.feature.md");
  expect(await readFeature(root, "billing/one.feature.md")).toBe("# Uno\n");
});

test("buildTree arranges folders and features, folders first, sorted", () => {
  const tree = buildTree(
    ["billing", "billing/sub", "empty"],
    [
      { fileName: "zeta.feature.md", name: "Zeta" },
      { fileName: "billing/quotes.feature.md", name: "Quotes" },
      { fileName: "billing/sub/deep.feature.md", name: "Deep" },
      { fileName: "alpha.feature.md", name: "Alpha" },
      // a feature whose folder is missing from the folder list still lands
      { fileName: "implied/one.feature.md", name: "One" },
    ],
  );
  expect(tree.path).toBe("");
  expect(tree.folders.map((f) => f.path)).toEqual(["billing", "empty", "implied"]);
  expect(tree.features.map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  const billing = tree.folders[0]!;
  expect(billing.name).toBe("billing");
  expect(billing.folders.map((f) => f.path)).toEqual(["billing/sub"]);
  expect(billing.features.map((f) => f.name)).toEqual(["Quotes"]);
  expect(billing.folders[0]!.features.map((f) => f.name)).toEqual(["Deep"]);
});

// The move flow runs on all three git engines (specs/git-operations.spec.md).
for (const engine of ["cli", "gh", "js"] as GitEngine[]) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // specs/folders.spec.md: drag-move is a `git mv` into the target
    // directory, committed and pushed — the other clone sees it on pull.
    test("moveFeature moves between folders via git mv, commits and pushes", async () => {
      const { a, b } = await twoClones(root, {
        "seed.feature.md": "# Seed\n",
        "billing/quotes.feature.md": "# Quotes\n",
      });
      const result = await moveFeature(a, "seed.feature.md", "billing");
      expect(result.fileName).toBe("billing/seed.feature.md");
      expect(result.message).toBe("renamed, committed and pushed");
      expect(await readFeature(a, "seed.feature.md")).toBeNull();
      expect(await readFeature(a, "billing/seed.feature.md")).toBe("# Seed\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain(
        "Move feature: seed.feature.md -> billing/seed.feature.md",
      );
      await git(b, "pull");
      expect(await readFeature(b, "billing/seed.feature.md")).toBe("# Seed\n");

      // and back out to the top level
      const back = await moveFeature(a, "billing/seed.feature.md", "");
      expect(back.fileName).toBe("seed.feature.md");
      expect(await readFeature(a, "seed.feature.md")).toBe("# Seed\n");
    });
  });
}
