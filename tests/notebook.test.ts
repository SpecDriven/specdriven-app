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
import {
  NOTEBOOK,
  NOTEBOOK_FOLDER,
  ROADMAP,
  createPage,
  importPageDrift,
  isPageFolderPath,
  listPages,
  readPage,
  renamePageFile,
  savePage,
} from "../src/server/pages";
import {
  byNewest,
  createEntry,
  entryFileOf,
  entryUrl,
  relinkEntries,
  setEntryKind,
  setSupersedes,
  supersededBy,
  today,
} from "../src/server/notebook";
import { normalizeNotebook } from "../src/server/state";
import { git, stopServers, twoClones } from "./helpers/fixtures";

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
  // Even with every other folder asked for, the notebook is not made.
  await syncDataDir(clones.a, { roadmap: true, tasks: true, models: true });
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

// Issue #122: an entry renamed in the app kept its old file name, so the url
// went on naming a title the entry no longer had — and the retired slug then
// refused the original title forever. Renaming moves the file too, keeping
// the date in front of it so the folder still reads in order.
test("renaming an entry keeps its date and takes the new title's slug", async () => {
  const fileName = await createEntry(root, "Always use worktrees", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  const result = await renamePageFile(
    root,
    NOTEBOOK,
    fileName,
    "Multiple Claude sessions without worktrees",
  );
  expect(result.fileName).toBe(
    "notebook/2026-09-12-multiple-claude-sessions-without-worktrees.md",
  );
  expect(result.name).toBe("Multiple Claude sessions without worktrees");
  expect(await Bun.file(join(root, fileName)).exists()).toBe(false);
  // The heading moved with the file, so the two can never drift apart again,
  // and the author, date and kind the entry was signed with are untouched.
  const renamed = await readPage(root, NOTEBOOK, result.fileName);
  expect(renamed?.name).toBe("Multiple Claude sessions without worktrees");
  expect(renamed?.author).toBe("ada");
  expect(renamed?.date).toBe("2026-09-12");
  expect(renamed?.kind).toBe("Observation");
});

// The document moves with the markdown, or the drift pass mints a fresh one
// at the new path and drops the orphan — losing the entry's merge history.
test("renaming an entry carries its document along", async () => {
  const fileName = await createEntry(root, "Spec first", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  const before = await loadPageDoc(root, fileName);
  const docid = await Bun.file(join(root, pageDocDirRel(fileName), "docid")).text();
  const { fileName: to } = await renamePageFile(root, NOTEBOOK, fileName, "Spec before code");
  expect(await exists(join(root, pageDocDirRel(fileName)))).toBe(false);
  expect(await exists(join(root, pageDocDirRel(to)))).toBe(true);
  // The same document, not a new one: the lineage — and so every merge the
  // entry has been through — survived the move.
  expect(await Bun.file(join(root, pageDocDirRel(to), "docid")).text()).toBe(docid);
  expect((await loadPageDoc(root, to))?.doc.name).toBe("Spec before code");
  expect(before).not.toBeNull();
});

// The guards createPage already has, in the same words — and the case the
// issue left behind: an entry whose heading already drifted from its file
// name is renamed back to the title it displays, which slugifies to the name
// it already has. That repairs the heading rather than failing.
test("renaming an entry validates, and an unchanged slug only repairs the heading", async () => {
  const fileName = await createEntry(root, "Spec first", "Observation", { date: "2026-09-12" });
  expect(renamePageFile(root, NOTEBOOK, fileName, "   ")).rejects.toThrow(
    "Notebook entry name is required",
  );
  expect(renamePageFile(root, NOTEBOOK, "notebook/2026-09-12-ghost.md", "Boo")).rejects.toThrow(
    "Notebook entry not found",
  );
  // Renaming onto a slug another entry holds is refused, the way creating one
  // over it is.
  await createEntry(root, "Ship on Fridays", "Decision", { date: "2026-09-12" });
  expect(renamePageFile(root, NOTEBOOK, fileName, "Ship on Fridays")).rejects.toThrow(
    "Notebook entry already exists",
  );
  // A heading that drifted from the file name: renaming to it is not an error.
  await savePage(
    root,
    NOTEBOOK,
    fileName,
    serializePage({ ...parsePage((await readPage(root, NOTEBOOK, fileName))!.content), name: "Drifted" }),
  );
  const same = await renamePageFile(root, NOTEBOOK, fileName, "Spec first");
  expect(same).toEqual({
    fileName,
    name: "Spec first",
    message: "file name unchanged",
  });
  expect((await readPage(root, NOTEBOOK, fileName))?.name).toBe("Spec first");
});

// Issue #122 itself: the entry was renamed to an observation, and the
// original title could never be used again. Once the rename moves the file,
// the old slug is free for the decision the rename was made to allow.
test("the slug a renamed entry gave up is free for a new entry", async () => {
  const fileName = await createEntry(root, "Always use worktrees", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  await renamePageFile(root, NOTEBOOK, fileName, "Multiple Claude sessions without worktrees");
  const decision = await createEntry(root, "Always use worktrees", "Decision", {
    date: "2026-09-12",
    author: "ada",
  });
  expect(decision).toBe(fileName);
  expect((await readPage(root, NOTEBOOK, decision))?.kind).toBe("Decision");
});

// "the notebook never rewrites history, it adds to it" — but a link that no
// longer resolves drops the badge silently, so the links naming a renamed
// entry follow it. Unlike a feature file rename, where links go stale.
test("supersedes links and body links follow a renamed entry", async () => {
  const earlier = await createEntry(root, "Photo reminder at 24 hours", "Decision", {
    date: "2026-07-28",
    author: "ada",
  });
  const later = await createEntry(root, "Photo reminder at four hours", "Decision", {
    date: "2026-08-19",
    author: "grace",
  });
  await setSupersedes(root, later, { title: "Photo reminder at 24 hours", url: entryUrl(earlier) });
  // A hand-typed cross-link in a third entry's body, beside links that name
  // nothing of ours and must be left exactly as they are.
  const other = await createEntry(root, "Hail day", "Observation", { date: "2026-08-05" });
  await savePage(
    root,
    NOTEBOOK,
    other,
    serializePage({
      ...parsePage((await readPage(root, NOTEBOOK, other))!.content),
      body: `See [the decision](${entryUrl(earlier)}) and [the site](https://example.com/notebook/x).`,
    }),
  );

  const { fileName: to } = await relinkAndRename(earlier, "Photo reminder at one day");
  expect(to).toBe("notebook/2026-07-28-photo-reminder-at-one-day.md");

  // The link text is the writer's own words and is kept; only the url moved.
  const linking = await readPage(root, NOTEBOOK, later);
  expect(linking?.supersedes).toEqual({
    title: "Photo reminder at 24 hours",
    url: entryUrl(to),
  });
  const body = (await readPage(root, NOTEBOOK, other))!.content;
  expect(body).toContain(`[the decision](${entryUrl(to)})`);
  expect(body).toContain("[the site](https://example.com/notebook/x)");
  // The badge still resolves, so the supersede chain survived the rename.
  const entries = byNewest(await listPages(root, NOTEBOOK));
  expect(supersededBy(entries)[to]?.fileName).toBe(later);
  // Written through the document, not behind its back: the next tick has
  // nothing to reconcile, so the old url cannot come back.
  expect((await loadPageDoc(root, later))?.doc.supersedes?.url).toBe(entryUrl(to));
});

/** Rename an entry the way the notebook's route does — with the relink. */
async function relinkAndRename(fileName: string, name: string) {
  return renamePageFile(root, NOTEBOOK, fileName, name, { relink: relinkEntries });
}

// A roadmap page is renamed by the same call, but takes no date: the prefix
// belongs to the notebook, whose folder reads in order.
test("renaming a roadmap page keeps its folder and takes no date prefix", async () => {
  await createPage(root, ROADMAP, "q3/Plan");
  const nested = await renamePageFile(root, ROADMAP, "roadmap/q3/plan.md", "Better Plan!");
  expect(nested.fileName).toBe("roadmap/q3/better-plan.md");
  // A page whose name merely begins with a year is given no date it never had.
  await createPage(root, ROADMAP, "2026 plan");
  const dated = await renamePageFile(root, ROADMAP, "roadmap/2026-plan.md", "Plan B");
  expect(dated.fileName).toBe("roadmap/plan-b.md");
});

// The rename is a `git mv`, committed and pushed, and the other clone sees
// the entry under its new name — with its document — on the next pull.
test("renaming an entry is a git mv, committed and pushed", async () => {
  const clones = await twoClones(root);
  const fileName = await createEntry(clones.a, "Spec first", "Observation", {
    date: "2026-09-12",
    author: "ada",
  });
  const result = await renamePageFile(clones.a, NOTEBOOK, fileName, "Spec before code");
  const to = "notebook/2026-09-12-spec-before-code.md";
  expect(result).toEqual({
    fileName: to,
    name: "Spec before code",
    message: "renamed, committed and pushed",
  });
  const log = await git(clones.a, "log", "-1", "--pretty=%s");
  expect(log.stdout.toString()).toContain(`Rename notebook entry: ${fileName} -> ${to}`);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, to)).exists()).toBe(true);
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.b, pageDocDirRel(to)))).toBe(true);
});
