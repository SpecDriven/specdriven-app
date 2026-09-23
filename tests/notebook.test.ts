// specs/app/engineering-notebook.feature.md: the data repo's `notebook`
// folder — dated markdown entries, each an observation or a decision, signed
// by whoever wrote it and shared through git like any page. The switch is the
// one that ships on, and the folder is made by the first entry rather than by
// the switch, so a default-on module writes to nobody's repo on its own.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPageDoc, pageDocDirRel } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { parsePage, serializePage } from "../src/server/parser";
import { syncDataDir } from "../src/server/reload";
import "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import {
  NOTEBOOK,
  NOTEBOOK_FOLDER,
  createPage,
  importPageDrift,
  isPageFolderPath,
  listPages,
  readPage,
  savePage,
} from "../src/server/pages";
import {
  byNewest,
  createEntry,
  entryFileOf,
  entryUrl,
  setEntryKind,
  setSupersedes,
  supersededBy,
  today,
} from "../src/server/notebook";
import { git, stopServers, twoClones } from "./helpers/fixtures";
import { builtinManifests } from "../src/plugins/builtin/manifests";
import { readProfile } from "../src/plugins/profile";

/** The legacy `notebook` switch, read as the profile reads it (src/plugins/profile.ts). */
const normalizeNotebook = (value: unknown): boolean =>
  readProfile(value === undefined ? {} : { notebook: value }, builtinManifests).enabled.includes("notebook");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-notebook-"));
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

// Scenario "The notebook is controlled by a switch in user settings": the one
// module that is on unless it has been turned off, so an absent key means on
// and only `false` switches it off.
test("the notebook setting is on unless explicitly turned off", () => {
  expect(normalizeNotebook(undefined)).toBe(true);
  expect(normalizeNotebook(true)).toBe(true);
  expect(normalizeNotebook("false")).toBe(true);
  expect(normalizeNotebook(false)).toBe(false);
});

// "no `notebook/` folder is created and nothing is committed until the first
// entry is written" — the price of a default-on module.
test("a sync tick never creates the notebook folder", async () => {
  const clones = await twoClones(root);
  await syncDataDir(clones.a);
  expect(await exists(join(clones.a, NOTEBOOK_FOLDER))).toBe(false);
  // Even with every folder's plugin mounted, the notebook is not made.
  await syncPlugins({ roadmap: true, tasks: true, notebook: true });
  try {
    await syncDataDir(clones.a);
  } finally {
    await syncPlugins({ roadmap: false, tasks: false });
  }
  expect(await exists(join(clones.a, NOTEBOOK_FOLDER))).toBe(false);
});

test("notebook paths are the folder and what is under it", () => {
  expect(isPageFolderPath("notebook")).toBe(true);
  expect(isPageFolderPath("notebook/2026-09-12-spec-first.md")).toBe(true);
  expect(isPageFolderPath("notebooks")).toBe(false);
});

// "the file is self-describing": a heading, then the author, date and kind.
test("an entry parses into its metadata and body, and serializes back", () => {
  const text =
    "# Spec before code\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Decision\n\nWe decided.\n";
  const page = parsePage(text);
  expect(page).toEqual({
    name: "Spec before code",
    author: "ada",
    date: "2026-09-12",
    kind: "Decision",
    body: "We decided.",
  });
  expect(serializePage(page)).toBe(text);
});

// The lines may be written in any order by hand; the projection is fixed.
test("the metadata lines parse in any order and project in a fixed one", () => {
  const page = parsePage(
    "# Drift\n\n**Kind:** Observation\n\n**Date:** 2026-09-01\n\n**Author:** grace\n\nIt bit us twice.\n",
  );
  expect(page.kind).toBe("Observation");
  expect(page.author).toBe("grace");
  expect(serializePage(page)).toBe(
    "# Drift\n\n**Author:** grace\n\n**Date:** 2026-09-01\n\n**Kind:** Observation\n\nIt bit us twice.\n",
  );
});

// "a plain markdown file dropped into the folder by hand, with none of those
// lines, is still an entry — its date comes from the file name."
test("a hand-written file is still an entry, dated by its file name", async () => {
  await mkdir(join(root, NOTEBOOK_FOLDER), { recursive: true });
  await writeFile(join(root, NOTEBOOK_FOLDER, "2026-09-12-by-hand.md"), "Just a note.\n");
  await writeFile(join(root, NOTEBOOK_FOLDER, "undated.md"), "# Undated\n");
  const entries = await listPages(root, NOTEBOOK);
  expect(entries).toEqual([
    { fileName: "notebook/2026-09-12-by-hand.md", name: "2026 09 12 By Hand", date: "2026-09-12" },
    { fileName: "notebook/undated.md", name: "Undated" },
  ]);
  // A word that is neither Observation nor Decision degrades rather than
  // being swallowed: the line stays in the body.
  const odd = parsePage("# Odd\n\n**Kind:** Note\n\nbody\n");
  expect(odd.kind).toBeUndefined();
  expect(odd.body).toBe("**Kind:** Note\n\nbody");
});

// A roadmap page named like a date is not given a date it never claimed.
test("only the notebook's files take a date from their name", async () => {
  await mkdir(join(root, "roadmap"), { recursive: true });
  await writeFile(join(root, "roadmap", "2026-09-12-plan.md"), "# Plan\n");
  const [page] = await listPages(root, { folder: "roadmap", label: "roadmap page" });
  expect(page?.date).toBeUndefined();
});

// Scenario "Write an entry": today's date in front of the slug, the author
// and kind written in, committed and pushed at once.
test("an entry is created dated, signed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Spec before code", "Decision", {
    author: "ada",
    date: "2026-09-12",
  });
  expect(fileName).toBe("notebook/2026-09-12-spec-before-code.md");
  // A decision opens with the skeleton; an observation opens empty.
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe(
    "# Spec before code\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Decision\n\n" +
      "## Context\n\n## Decision\n\n## Consequences\n",
  );
  const observation = await createEntry(clones.a, "Drift bit us twice", "Observation", {
    author: "ada",
    date: "2026-09-12",
  });
  expect(await Bun.file(join(clones.a, observation)).text()).toBe(
    "# Drift bit us twice\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Observation\n",
  );
  // Committed and pushed like a new roadmap page — document and all.
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(true);
  expect(await exists(join(clones.b, pageDocDirRel(fileName)))).toBe(true);
});

// "a title whose slug already exists for today is refused" — and a blank one
// is refused before anything is written.
test("a duplicate slug for the same day is refused, and so is a blank title", async () => {
  const clones = await twoClones(root);
  await createEntry(clones.a, "Spec before code", "Decision", { date: "2026-09-12", author: "a" });
  expect(
    createEntry(clones.a, "Spec before code", "Decision", { date: "2026-09-12", author: "a" }),
  ).rejects.toThrow("already exists");
  expect(createEntry(clones.a, "   ", "Observation", { date: "2026-09-12" })).rejects.toThrow(
    "name is required",
  );
  // The same title on another day is a different entry.
  const next = await createEntry(clones.a, "Spec before code", "Decision", {
    date: "2026-09-13",
    author: "a",
  });
  expect(next).toBe("notebook/2026-09-13-spec-before-code.md");
});

// "nested subfolders are not offered — a notebook is flat and chronological":
// a `/` in the title is part of the title, not a folder to make.
test("the notebook is flat: a slash in the title makes no subfolder", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "CI/CD is too slow", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  expect(fileName).toBe("notebook/2026-09-12-ci-cd-is-too-slow.md");
  expect(parsePage(await Bun.file(join(clones.a, fileName)).text()).name).toBe("CI/CD is too slow");
  // The roadmap still nests, so the flag changed only the notebook.
  const page = await createPage(clones.a, { folder: "roadmap", label: "roadmap page" }, "q3/plan");
  expect(page).toBe("roadmap/q3/plan.md");
});

// "the kind is changed later from a chip in the entry's header".
test("an entry's kind is changed through its document", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Maybe", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  const saved = await setEntryKind(clones.a, fileName, "Decision");
  expect(saved.kind).toBe("Decision");
  expect(saved.content).toContain("**Kind:** Decision");
  // The author and date it was created with are untouched.
  expect(saved.author).toBe("ada");
  expect(saved.date).toBe("2026-09-12");
  const loaded = await loadPageDoc(clones.a, fileName);
  expect(loaded?.doc.kind).toBe("Decision");
});

// Scenario "A decision can supersede an earlier one": the newer entry gains
// the line, the earlier one's text is untouched, and the badge is derived.
test("a decision supersedes an earlier one without touching it", async () => {
  const clones = await twoClones(root);
  const earlier = await createEntry(clones.a, "Ship on Fridays", "Decision", {
    date: "2026-09-01",
    author: "ada",
  });
  const before = await Bun.file(join(clones.a, earlier)).text();
  const later = await createEntry(clones.a, "Never ship on Fridays", "Decision", {
    date: "2026-09-12",
    author: "grace",
  });
  const saved = await setSupersedes(clones.a, later, {
    title: "Ship on Fridays",
    url: entryUrl(earlier),
  });
  expect(saved.content).toContain(
    "**Supersedes:** [Ship on Fridays](/notebook/2026-09-01-ship-on-fridays)",
  );
  // The notebook never rewrites history: the earlier entry is byte-identical.
  expect(await Bun.file(join(clones.a, earlier)).text()).toBe(before);

  // The badge is derived from the link, on every read.
  const entries = byNewest(await listPages(clones.a, NOTEBOOK));
  expect(entries.map((e) => e.fileName)).toEqual([later, earlier]);
  expect(supersededBy(entries)[earlier]?.fileName).toBe(later);

  // "removing the line from the newer entry removes the badge."
  await setSupersedes(clones.a, later, null);
  expect(supersededBy(byNewest(await listPages(clones.a, NOTEBOOK)))).toEqual({});
});

test("an entry url round-trips to its file, and a foreign url does not", () => {
  const file = "notebook/2026-09-12-spec-first.md";
  expect(entryUrl(file)).toBe("/notebook/2026-09-12-spec-first");
  expect(entryFileOf(entryUrl(file))).toBe(file);
  // A link written by hand may carry the folder, the suffix, or neither.
  expect(entryFileOf("2026-09-12-spec-first")).toBe(file);
  expect(entryFileOf("/notebook/2026-09-12-spec-first.md")).toBe(file);
  expect(entryFileOf("https://example.com/notebook/x")).toBeNull();
  expect(entryFileOf("../../etc/passwd")).toBeNull();
  expect(entryFileOf("")).toBeNull();
});

// Scenario "Entries are shared through git": a teammate's entry arrives on
// the next tick, with its author and date.
test("entries reach the other clone on a sync tick", async () => {
  const clones = await twoClones(root);
  await createEntry(clones.a, "Drift bit us twice", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  await syncDataDir(clones.b);
  const [entry] = await listPages(clones.b, NOTEBOOK);
  expect(entry).toEqual({
    fileName: "notebook/2026-09-12-drift-bit-us-twice.md",
    name: "Drift bit us twice",
    author: "ada",
    date: "2026-09-12",
    kind: "Observation",
  });
});

// "a person with the setting off still pulls the entries — the switch hides
// the tab, it does not stop the sync": the tick takes no notebook option at
// all, so there is no way to ask it to skip them.
test("the sync tick absorbs notebook drift whatever the other switches say", async () => {
  const clones = await twoClones(root);
  await mkdir(join(clones.a, NOTEBOOK_FOLDER), { recursive: true });
  await writeFile(
    join(clones.a, NOTEBOOK_FOLDER, "2026-09-12-by-hand.md"),
    "# By hand\n\n**Kind:** Decision\n\nWritten on GitHub.\n",
  );
  await syncDataDir(clones.a);
  // The hand-written file was imported into a document and pushed.
  expect(await loadPageDoc(clones.a, "notebook/2026-09-12-by-hand.md")).not.toBeNull();
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, "notebook/2026-09-12-by-hand.md")).exists()).toBe(true);
});

// An entry edited outside the app drifts back into its document, and the file
// is rewritten to the projection — the page behaviour an entry inherits.
test("an entry edited outside the app is absorbed on the next tick", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Spec first", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  await writeFile(
    join(clones.a, fileName),
    "# Spec first\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Decision\n\nChanged on GitHub.\n",
  );
  await importPageDrift(clones.a, NOTEBOOK);
  const loaded = await loadPageDoc(clones.a, fileName);
  expect(loaded?.doc.kind).toBe("Decision");
  expect(loaded?.doc.body).toBe("Changed on GitHub.");
  expect((await readPage(clones.a, NOTEBOOK, fileName))?.kind).toBe("Decision");
});

// Scenario "Entries are shared through git": "when both edit the same entry
// at once, their edits merge at the document level and neither sees a
// conflict, as for any page". Sequenced like the feature-document test
// (tests/automerge/automergeSync.test.ts): the side that pulls a dirty file
// needs the second tick to merge and push.
test("two clones editing one entry merge instead of conflicting", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Spec first", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  await syncDataDir(clones.b); // both peers now share the entry's lineage

  const head = "# Spec first\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Observation\n\n";
  await savePage(clones.a, NOTEBOOK, fileName, `${head}Ada's line.\n`);
  await savePage(clones.b, NOTEBOOK, fileName, `${head}Grace's line.\n`);

  await syncDataDir(clones.a); // pushes A's markdown and ops
  await syncDataDir(clones.b); // pull conflicts on the markdown; the doc merges
  await syncDataDir(clones.b); // pushes the merge
  await syncDataDir(clones.a); // A pulls it back

  const text = await Bun.file(join(clones.a, fileName)).text();
  expect(text).toContain("Ada's line.");
  expect(text).toContain("Grace's line.");
  expect(await Bun.file(join(clones.b, fileName)).text()).toBe(text);
  // The metadata is one value each, not a mix of two.
  const merged = parsePage(text);
  expect(merged.author).toBe("ada");
  expect(merged.date).toBe("2026-09-12");
  expect(merged.kind).toBe("Observation");
});

// The bug the page branch of the conflict resolver first had: a page's chunks
// live under its own document tree, not a feature's, so asking whether the
// other side brought operations with the feature path always said no — and
// the three-way merge was applied on top of a document that already held both
// sides' edits, duplicating one of them.
test("a merged entry holds each side's edit exactly once", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Once", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  await syncDataDir(clones.b);
  const head = "# Once\n\n**Author:** ada\n\n**Date:** 2026-09-12\n\n**Kind:** Observation\n\n";
  await savePage(clones.a, NOTEBOOK, fileName, `${head}AAA\n`);
  await savePage(clones.b, NOTEBOOK, fileName, `${head}BBB\n`);
  await syncDataDir(clones.a);
  await syncDataDir(clones.b);
  await syncDataDir(clones.b);
  await syncDataDir(clones.a);

  const text = await Bun.file(join(clones.a, fileName)).text();
  expect(text.match(/AAA/g)).toHaveLength(1);
  expect(text.match(/BBB/g)).toHaveLength(1);
  // Both clones agree, and no conflict markers survived into the file.
  expect(await Bun.file(join(clones.b, fileName)).text()).toBe(text);
  expect(text).not.toContain("<<<<<<<");
});

test("today reads yyyy-mm-dd in local time", () => {
  expect(today(new Date(2026, 8, 12, 13, 30))).toBe("2026-09-12");
  expect(today(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
});

test("byNewest sorts by date then title", () => {
  const entries = [
    { fileName: "notebook/a.md", name: "B", date: "2026-09-01" },
    { fileName: "notebook/b.md", name: "A", date: "2026-09-12" },
    { fileName: "notebook/c.md", name: "A", date: "2026-09-01" },
    { fileName: "notebook/d.md", name: "Z" },
  ];
  expect(byNewest(entries).map((e) => e.name)).toEqual(["A", "A", "B", "Z"]);
});
