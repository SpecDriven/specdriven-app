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

  await deleteFolder(root, "specs/empty");
  expect(await listFolders(root)).toEqual(["specs/full"]);

  expect(deleteFolder(root, "specs/full")).rejects.toThrow("not empty");
  expect(deleteFolder(root, "specs/ghost")).rejects.toThrow("Folder not found");
  expect(deleteFolder(root, "")).rejects.toThrow("required");
  expect(deleteFolder(root, "..")).rejects.toThrow("Invalid folder");
  expect(await readFeature(root, "specs/full/one.feature.md")).toBe("# One\n");
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
  });
}
