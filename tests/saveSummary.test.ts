// specs/ui/ui.feature.md "Auto-save commits say what changed": the title of
// an auto-save commit names the feature or page and the scenarios behind the
// change; the body lists every file. All on text — no git, no disk.
import { describe, expect, test } from "bun:test";
import {
  AUTO_SAVE_TRAILER,
  DOCUMENTS_TITLE,
  FALLBACK_TITLE,
  TITLE_LIMIT,
  pathsInStatus,
  summarizeSavedChanges,
} from "../src/server/git/saveSummary";

const folders = `# Folders

Features live in folders.

## Move a feature @v1 [published]

Drag it.

## Rename a folder @v1 [proposed]

Click its name.
`;

const edited = folders.replace("Drag it.", "Drag it to another folder.");

describe("one feature", () => {
  test("an edited scenario names the feature and the scenario", () => {
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after: edited },
    ]);
    expect(title).toBe("Edit Folders: Move a feature");
    expect(body).toBe(`- Edit feature: Folders (edit "Move a feature")\n\n${AUTO_SAVE_TRAILER}`);
  });

  test("scenarios only added say so", () => {
    const after = `${folders}\n## Delete a folder @v1 [proposed]\n\nTrash it.\n`;
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Add scenario to Folders: Delete a folder");
    expect(body).toContain('add "Delete a folder"');
  });

  test("scenarios only removed say so, plural when several", () => {
    const after = "# Folders\n\nFeatures live in folders.\n";
    const { title } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Remove scenarios from Folders: Move a feature, Rename a folder");
  });

  test("a scenario that went from proposed to published is a publish", () => {
    const after = folders.replace("Rename a folder @v1 [proposed]", "Rename a folder @v1 [published]");
    const { title } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Publish scenario in Folders: Rename a folder");
  });

  test("mixed changes are an edit listing every scenario", () => {
    const after = `${edited}\n## Delete a folder @v1 [proposed]\n\nTrash it.\n`;
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Edit Folders: Delete a folder, Move a feature");
    expect(body).toContain('(add "Delete a folder"; edit "Move a feature")');
  });

  test("a change above the first scenario is a description edit", () => {
    const after = folders.replace("Features live in folders.", "Features live in folders, nested.");
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Edit Folders (description)");
    expect(body).toContain("(description)");
  });

  test("a renamed feature with nothing else changed is a rename", () => {
    const after = folders.replace("# Folders", "# Spec folders");
    const { title } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after },
    ]);
    expect(title).toBe("Rename feature: Folders -> Spec folders");
  });

  test("a new feature file is an add, a gone one a delete", () => {
    expect(summarizeSavedChanges([{ path: "specs/seed.feature.md", before: null, after: folders }]).title).toBe(
      "Add feature: Folders",
    );
    expect(summarizeSavedChanges([{ path: "specs/seed.feature.md", before: folders, after: null }]).title).toBe(
      "Delete feature: Folders",
    );
  });

  test("a feature without a heading is named after its file", () => {
    const { title } = summarizeSavedChanges([
      { path: "specs/quote-policy.feature.md", before: null, after: "## One @v1 [proposed]\n\nbody\n" },
    ]);
    expect(title).toBe("Add feature: Quote Policy");
  });

  test("a feature gone from one path and new at another is a move", () => {
    const { title, body } = summarizeSavedChanges([
      { path: "specs/folders.feature.md", before: folders, after: null },
      { path: "specs/ui/folders.feature.md", before: null, after: folders },
    ]);
    expect(title).toBe("Move feature: Folders");
    expect(body).toBe(`- Move feature: Folders\n\n${AUTO_SAVE_TRAILER}`);
  });
});

describe("pages and folders", () => {
  test("a page is called what its folder calls it", () => {
    const entry = "# Which SDD will win ?\n\n**Author:** david\n\nNotes.\n";
    expect(summarizeSavedChanges([{ path: "notebook/2026-10-17-which-sdd-will-win.md", before: entry, after: `${entry}More.\n` }]).title).toBe(
      "Edit notebook entry: Which SDD will win ?",
    );
    expect(summarizeSavedChanges([{ path: "tasks/ship-v2.md", before: null, after: "# Ship v2\n" }]).title).toBe(
      "Add task: Ship v2",
    );
    expect(summarizeSavedChanges([{ path: "roadmap/q4.md", before: "# Q4\n", after: null }]).title).toBe(
      "Delete roadmap page: Q4",
    );
  });

  test("a page without a heading is named after its file", () => {
    expect(summarizeSavedChanges([{ path: "tasks/fix-the-build.md", before: null, after: "just text\n" }]).title).toBe(
      "Add task: Fix The Build",
    );
  });

  test("a folder display name names the folder", () => {
    const { title, body } = summarizeSavedChanges([
      { path: "specs/app/display-name.txt", before: null, after: "The app itself\n" },
    ]);
    expect(title).toBe("Describe folder: specs/app");
    expect(body).toContain("- Describe folder: specs/app");
    // and so does the file's legacy name
    expect(
      summarizeSavedChanges([{ path: "specs/app/description.txt", before: null, after: "The app\n" }]).title,
    ).toBe("Describe folder: specs/app");
  });

  test("a markdown file outside the special folders is saved by path", () => {
    expect(summarizeSavedChanges([{ path: "README.md", before: "a", after: "b" }]).title).toBe("Edit file: README.md");
  });
});

describe("batches", () => {
  test("several features list their names", () => {
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after: edited },
      { path: "specs/ui/ui.feature.md", before: "# UI\n\n## A @v1 [proposed]\n\nx\n", after: "# UI\n\n## A @v1 [proposed]\n\ny\n" },
      { path: "specs/app/plugins.feature.md", before: null, after: "# Plugins\n" },
    ]);
    expect(title).toBe("Edit 3 features: Folders, UI, Plugins");
    expect(body.split("\n")).toEqual([
      '- Edit feature: Folders (edit "Move a feature")',
      '- Edit feature: UI (edit "A")',
      "- Add feature: Plugins",
      "",
      AUTO_SAVE_TRAILER,
    ]);
  });

  test("several kinds are counted, with the names in the body", () => {
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/folders.feature.md", before: folders, after: edited },
      { path: "specs/app/plugins.feature.md", before: null, after: "# Plugins\n" },
      { path: "notebook/2026-10-17-x.md", before: "# X\n", after: "# X\n\nmore\n" },
      { path: "specs/app/description.txt", before: null, after: "The app\n" },
      { path: "specs/folder-order.txt", before: "app\nui\n", after: "ui\napp\n" },
    ]);
    expect(title).toBe("Edit 2 features, 1 notebook entry, 1 folder description, 1 folder order");
    expect(body).toContain("- Edit notebook entry: X");
    expect(body).toContain("- Describe folder: specs/app");
    expect(body).toContain("- Reorder folders in: specs");
  });

  // specs/ui/folders.feature.md "order features": a feature-order.txt is
  // named by the folder whose features it orders.
  test("a feature order reads as a reorder of the folder's features", () => {
    expect(
      summarizeSavedChanges([{ path: "specs/ui/feature-order.txt", before: null, after: "folders.feature.md\n" }]).title,
    ).toBe("Reorder features in: specs/ui");
    const { title, body } = summarizeSavedChanges([
      { path: "specs/ui/feature-order.txt", before: null, after: "folders.feature.md\n" },
      { path: "specs/folder-order.txt", before: "app\nui\n", after: "ui\napp\n" },
    ]);
    expect(title).toBe("Reorder 1 feature order, 1 folder order");
    expect(body).toContain("- Reorder features in: specs/ui");
    expect(body).toContain("- Reorder folders in: specs");
  });

  test("the same verb everywhere keeps it", () => {
    const { title } = summarizeSavedChanges([
      { path: "notebook/a.md", before: null, after: "# A\n" },
      { path: "notebook/b.md", before: null, after: "# B\n" },
    ]);
    expect(title).toBe("Add 2 notebook entries: A, B");
  });

  test("names stop at the title limit with a count of the rest", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `specs/feature-${i}.feature.md`,
      before: null,
      after: `# Feature number ${i} with a long name\n`,
    }));
    const { title } = summarizeSavedChanges(files);
    expect(title.length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(title).toMatch(/^Add 12 features: Feature number 0 with a long name, .*\+\d+ more$/);
  });

  test("a single name too long for the title is cut", () => {
    const { title } = summarizeSavedChanges([
      { path: "specs/x.feature.md", before: null, after: `# ${"Long ".repeat(30)}\n` },
    ]);
    expect(title.length).toBe(TITLE_LIMIT);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("what is left out", () => {
  test("the app's own folder is not what changed", () => {
    const { title, body } = summarizeSavedChanges([
      { path: ".specdriven/automerge/specs/ui/folders.feature.md/changes-1.bin" },
      { path: "specs/ui/folders.feature.md", before: folders, after: edited },
    ]);
    expect(title).toBe("Edit Folders: Move a feature");
    expect(body).not.toContain(".specdriven");
  });

  test("files not read are saved by path; only such files make a plain save", () => {
    const { title, body } = summarizeSavedChanges([{ path: "images/a.png" }, { path: "models/cart.model.json" }]);
    expect(title).toBe("Save 2 files");
    expect(body).toContain("- Save images/a.png");
  });

  test("nothing but the app's own documents is said so", () => {
    const { title } = summarizeSavedChanges([{ path: ".specdriven/automerge/specs/a.feature.md/changes-1.bin" }]);
    expect(title).toBe(DOCUMENTS_TITLE);
  });

  test("no files at all keeps the old title", () => {
    expect(summarizeSavedChanges([]).title).toBe(FALLBACK_TITLE);
  });
});

describe("pathsInStatus", () => {
  test("reads modified, untracked, renamed and quoted entries", () => {
    const porcelain = [
      " M specs/ui/folders.feature.md",
      "?? specs/new.feature.md",
      "?? specs/newdir/",
      "R  old.md -> new.md",
      '?? "specs/caf\\303\\251 \\"x\\".feature.md"',
      "",
    ].join("\n");
    expect(pathsInStatus(porcelain)).toEqual([
      "specs/ui/folders.feature.md",
      "specs/new.feature.md",
      "specs/newdir/",
      "new.md",
      'specs/café "x".feature.md',
    ]);
  });
});
