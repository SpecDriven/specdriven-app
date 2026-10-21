import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  createFolder,
  deleteDraftScenario,
  deleteFeature,
  listFeatures,
  moveFeature,
  readFeature,
  readFeatureForEditor,
  renameFeature,
  renameFeatureFile,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
  slugify,
} from "../src/server/features";
import { importDrift } from "../src/server/automerge/driftSync";
import { projectFeature } from "../src/server/automerge/project";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { gitEngines } from "./helpers/engines";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;
let fakeGh: FakeGh | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-feat-"));
});

afterEach(async () => {
  stopServers();
  fakeGh?.restore();
  fakeGh = null;
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

test("slugify produces kebab-case file stems", () => {
  expect(slugify("Quote Policy")).toBe("quote-policy");
  expect(slugify("  Weird!! Name?? ")).toBe("weird-name");
});

// Scenario: create new feature — new file is created in the local filesystem.
test("createFeature writes a new .feature.md file and lists it", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  expect(fileName).toBe("specs/quote-policy.feature.md");
  expect(await listFeatures(root)).toEqual([
    { fileName: "specs/quote-policy.feature.md", name: "Quote Policy", scenarios: [] },
  ]);
  expect(await readFeature(root, fileName)).toBe("# Quote Policy\n");
});

// specs/ui/ui.feature.md "Main page": the sidebar shows feature names, not file
// names — the name comes from the `# <name>` heading, with the file stem as
// the fallback for files without one.
test("listFeatures returns display names, falling back to the stem", async () => {
  await Bun.write(join(root, "specs/quote-policy.feature.md"), "# Quote & Policy!\n");
  await Bun.write(join(root, "specs/no-heading.feature.md"), "just text\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "specs/no-heading.feature.md", name: "No Heading", scenarios: [] },
    { fileName: "specs/quote-policy.feature.md", name: "Quote & Policy!", scenarios: [] },
  ]);
});

// Scenario-level code gen selection (specs/agents/claude.feature.md): the
// listing carries each file's scenario names and versions, so the sidebar
// can offer them for selection.
test("listFeatures carries each file's scenario names and versions", async () => {
  await Bun.write(
    join(root, "specs/quotes.feature.md"),
    "# Quotes\n\n## Basic @v1 [published]\n\nbody\n\n## Renewal @v2\n\nbody\n",
  );
  expect(await listFeatures(root)).toEqual([
    {
      fileName: "specs/quotes.feature.md",
      name: "Quotes",
      scenarios: [
        { name: "Basic", version: 1, status: "published" },
        { name: "Renewal", version: 2, status: "draft" },
      ],
    },
  ]);
});

test("createFeature refuses to overwrite an existing feature", async () => {
  await createFeature(root, "Quote Policy");
  expect(createFeature(root, "Quote Policy")).rejects.toThrow("already exists");
});

test("path traversal and non-.feature.md file names are rejected", async () => {
  expect(readFeature(root, "../evil.feature.md")).rejects.toThrow("Invalid feature file name");
  expect(publishFeature(root, "no-extension", "x")).rejects.toThrow("Invalid feature file name");
  expect(readFeature(root, "legacy.feature")).rejects.toThrow("Invalid feature file name");
});

test("renameFeature works in a plain directory (no git repo)", async () => {
  await createFeature(root, "Quote");
  const result = await renameFeature(root, "specs/quote.feature.md", "Policy");
  expect(result.fileName).toBe("specs/quote.feature.md");
  expect(result.name).toBe("Policy");
  expect(await readFeature(root, "specs/quote.feature.md")).toBe("# Policy\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "specs/quote.feature.md", name: "Policy", scenarios: [] },
  ]);
});

// Scenarios and description survive a rename untouched — the write numbers
// the headings by position (parser.ts `S<n>:`), nothing more; a file without
// a `# <name>` heading gains one.
test("renameFeature only touches the heading, adding one when missing", async () => {
  await Bun.write(
    join(root, "specs/one.feature.md"),
    "# One\n\nsome description\n\n## First @v1 [published]\n\nbody\n",
  );
  await renameFeature(root, "specs/one.feature.md", "Uno");
  expect(await readFeature(root, "specs/one.feature.md")).toBe(
    "# Uno\n\nsome description\n\n## S1: First @v1 [published]\n\nbody\n",
  );
  await Bun.write(join(root, "specs/bare.feature.md"), "just text\n");
  await renameFeature(root, "specs/bare.feature.md", "Named Now");
  expect(await readFeature(root, "specs/bare.feature.md")).toBe("# Named Now\n\njust text\n");
});

// specs/ui/ui.feature.md "User-entered text is cleaned up".
test("a feature's typed name is saved cleaned", async () => {
  const fileName = await createFeature(root, " billing / Quote   Policy ");
  expect(fileName).toBe("specs/billing/quote-policy.feature.md");
  expect(await readFeature(root, fileName)).toBe("# Quote Policy\n");
  const renamed = await renameFeature(root, fileName, "  Quote \t Policy  v2 ");
  expect(renamed.name).toBe("Quote Policy v2");
});

test("renameFeature refuses missing files and empty names", async () => {
  await createFeature(root, "One");
  expect(renameFeature(root, "specs/ghost.feature.md", "Spirit")).rejects.toThrow("not found");
  expect(renameFeature(root, "specs/one.feature.md", "   ")).rejects.toThrow("required");
  expect(renameFeature(root, "../evil.feature.md", "Fine")).rejects.toThrow(
    "Invalid feature file name",
  );
  // renaming to the current name is a no-op, not an error
  const same = await renameFeature(root, "specs/one.feature.md", "One");
  expect(same).toEqual({
    fileName: "specs/one.feature.md",
    name: "One",
    message: "feature name unchanged",
  });
});

// The stem is slugified like a created file's; folder and extension are kept.
test("renameFeatureFile keeps the folder, slugifies the stem, and validates", async () => {
  await createFeature(root, "billing/Quote");
  const result = await renameFeatureFile(root, "specs/billing/quote.feature.md", "Better Quote!");
  expect(result.fileName).toBe("specs/billing/better-quote.feature.md");
  expect(await readFeature(root, "specs/billing/better-quote.feature.md")).toBe("# Quote\n");
  expect(renameFeatureFile(root, "specs/billing/better-quote.feature.md", "  ")).rejects.toThrow(
    "File name is required",
  );
  expect(renameFeatureFile(root, "specs/ghost.feature.md", "spirit")).rejects.toThrow("not found");
  // renaming to the current stem is a no-op, not an error
  const same = await renameFeatureFile(root, "specs/billing/better-quote.feature.md", "Better Quote");
  expect(same).toEqual({
    fileName: "specs/billing/better-quote.feature.md",
    message: "file name unchanged",
  });
  // renaming onto an existing file is refused
  await createFeature(root, "billing/Other");
  expect(renameFeatureFile(root, "specs/billing/other.feature.md", "Better Quote")).rejects.toThrow(
    "already exists",
  );
});

test("deleteFeature works in a plain directory and validates", async () => {
  await createFeature(root, "Quote");
  const result = await deleteFeature(root, "specs/quote.feature.md");
  expect(result.message).toBe("deleted locally (not a git repository)");
  expect(await listFeatures(root)).toEqual([]);
  expect(deleteFeature(root, "specs/quote.feature.md")).rejects.toThrow("not found");
  expect(deleteFeature(root, "../evil.feature.md")).rejects.toThrow("Invalid feature file name");
});

test("saveFeature keeps published scenarios immutable", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold body\n",
  );
  expect(
    saveFeature(
      root,
      "specs/quote.feature.md",
      "# Quote\n\n## Basic @v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
});

test("saveFeature refuses to demote a published scenario", async () => {
  await createFeature(root, "Quote");
  await publishFeature(root, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nold body\n");
  for (const status of ["proposed", "draft"]) {
    expect(
      saveFeature(root, "specs/quote.feature.md", `# Quote\n\n## Basic @v1 [${status}]\n\nold body\n`),
    ).rejects.toThrow("immutable");
  }
});

// An edit made to the file on disk is only absorbed into the document on the
// next sync tick; an editor save landing first must not write over it.
describe("a save racing an unsynced disk edit", () => {
  const file = "specs/race.feature.md";
  // The file as the app writes it: headings numbered by position.
  const seed = "# Race\n\n## S1: Hello @v1 [proposed]\n\n- **Given** x\n";

  beforeEach(async () => {
    await createFeature(root, "Race", seed);
  });

  test("keeps the disk edit alongside the save", async () => {
    await Bun.write(
      join(root, file),
      "# Race\n\ndescribed on disk\n\n## Hello @v1 [proposed]\n\n- **Given** x\n\n" +
        "## Disk only @v1 [proposed]\n\n- **Given** from disk\n",
    );
    const saved = await saveFeature(root, file, "# Race\n\n## Hello @v1 [proposed]\n\n- **Given** x edited here\n");

    const md = (await readFeature(root, file))!;
    expect(md).toContain("described on disk");
    expect(md).toContain("x edited here");
    // The disk edit carried no numbers, so it reads in the legacy order —
    // by name — and the write numbers what it kept.
    expect(md).toContain("## S1: Disk only @v1 [proposed]");
    expect(md).toContain("## S2: Hello @v1 [proposed]");
    expect(saved.content).toBe(md);
    expect(projectFeature((await loadFeatureDoc(root, file))!.doc)).toBe(md);
  });

  test("an editor that already holds the disk edit saves it once", async () => {
    const onDisk = seed.replace("- **Given** x", "- **Given** x\n- **And** y");
    await Bun.write(join(root, file), onDisk);
    await saveFeature(root, file, onDisk);
    expect(await readFeature(root, file)).toBe(onDisk);
  });

  test("refuses a save that changed the same text as the disk edit", async () => {
    const onDisk = seed.replace("- **Given** x", "- **Given** x from disk");
    await Bun.write(join(root, file), onDisk);
    expect(
      saveFeature(root, file, seed.replace("- **Given** x", "- **Given** x from the editor")),
    ).rejects.toThrow("edited on disk");
    expect(await readFeature(root, file)).toBe(onDisk);
  });

  test("does not fold in a disk edit that tampers with a published scenario", async () => {
    await publishFeature(root, file, seed);
    const published = (await readFeature(root, file))!;
    await Bun.write(join(root, file), published.replace("- **Given** x", "- **Given** tampered"));
    const withNew = `${published}\n## New @v1 [proposed]\n\n- **Given** z\n`;
    // The save's published-immutability check reads the file, so the save is
    // refused; the drift pass then repairs the file from the document.
    expect(saveFeature(root, file, withNew)).rejects.toThrow("immutable");
    expect(projectFeature((await loadFeatureDoc(root, file))!.doc)).toBe(published);
  });
});

// specs/editor/editor-autosave.feature.md "Autosave Waits While a Code Fence
// Is Open": the editor buffer ends inside a fence for a few keystrokes
// whenever one is typed. Parsed as is, every scenario heading after the open
// fence is fenced content, so the scenarios under them vanish from the text
// and reconcile would delete them from the document as if the user had — the
// way a [proposed] scenario was once erased. The save is refused instead.
describe("a save whose text ends inside a code fence", () => {
  const file = "specs/fence.feature.md";
  const closed =
    "# Fence\n\n## S1: Context @v1 [proposed]\n\n```gherkin\nGiven a priority context\n```\n\n" +
    "## S2: Selecting a priority segment @v1 [proposed]\n\nGiven a segment <Priority>\n\n" +
    "Examples:\n| Priority |\n| high |\n";
  // The closing fence of the first scenario is momentarily missing.
  const open = closed.replace("Given a priority context\n```\n", "Given a priority context\n");

  beforeEach(async () => {
    await createFeature(root, "Fence", closed);
  });

  test("is refused, and keeps the scenario the open fence would swallow", async () => {
    expect(saveFeature(root, file, open)).rejects.toThrow(
      "Refusing to write specs/fence.feature.md — the code fence opened on line 5 is never closed",
    );
    expect(await readFeature(root, file)).toBe(closed);
    const doc = (await loadFeatureDoc(root, file))!.doc;
    expect(doc.specs.map((e) => e.name)).toEqual(["Context", "Selecting a priority segment"]);
    expect(projectFeature(doc)).toBe(closed);
  });

  test("lands once the fence is closed again", async () => {
    const edited = closed.replace("Given a priority context", "Given a priority context typed");
    expect(saveFeature(root, file, open)).rejects.toThrow("never closed");
    await saveFeature(root, file, edited);
    expect(await readFeature(root, file)).toBe(edited);
    expect((await loadFeatureDoc(root, file))!.doc.specs).toHaveLength(2);
  });

  test("a publish is refused the same way", async () => {
    expect(publishFeature(root, file, open)).rejects.toThrow("never closed");
    expect(await readFeature(root, file)).toBe(closed);
  });

  test("a file left open on disk is not absorbed by the drift pass", async () => {
    await Bun.write(join(root, file), open);
    expect(await importDrift(root)).toBe("");
    const doc = (await loadFeatureDoc(root, file))!.doc;
    expect(doc.specs.map((e) => e.name)).toEqual(["Context", "Selecting a priority segment"]);
    // The disk file is left for whoever is mid-edit there to finish.
    expect(await Bun.file(join(root, file)).text()).toBe(open);
  });
});

// Publishing a proposed scenario upgrades the proposed chip to published.
test("publishFeature upgrades proposed scenarios to published", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
  const result = await publishFeature(
    root,
    "specs/quote.feature.md",
    (await readFeature(root, "specs/quote.feature.md"))!,
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "specs/quote.feature.md");
  expect(text).toContain("## S1: Basic @v1 [published]");
  expect(text).not.toContain("[proposed]");
});

// Scenario "publish each scenario individually": a targeted publish marks only
// that scenario [published], leaving the others as they were.
test("publishFeature with a scenario target publishes only that scenario", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\none\n\n## Extra @v1\n\ntwo\n",
  );
  const result = await publishFeature(
    root,
    "specs/quote.feature.md",
    (await readFeature(root, "specs/quote.feature.md"))!,
    { name: "Basic", version: 1 },
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "specs/quote.feature.md");
  expect(text).toContain("## S1: Basic @v1 [published]");
  expect(text).toContain("## S2: Extra @v1 [proposed]");
});

// crud-feature.md "Scenario status": a scenario saved with an
// explicit [draft] chip lands in the Automerge document but never in the
// .feature.md — and the save result / editor read still hand it back, so the
// client keeps showing it.
test("saveFeature keeps a [draft] scenario out of the file but not out of the editor", async () => {
  await createFeature(root, "Quote");
  const result = await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const text = await readFeature(root, "specs/quote.feature.md");
  expect(text).toContain("## S1: Basic @v1 [proposed]");
  expect(text).not.toContain("Idea");
  const loaded = await loadFeatureDoc(root, "specs/quote.feature.md");
  expect(loaded!.doc.specs.map((s) => `${s.name}:${s.status}`)).toContain("Idea:draft");
  // The editor's wire format numbers by position in the text it carries,
  // drafts included (serializeFeature); the file above holds only S1.
  expect(result.content).toContain("## Idea @v1 [draft]");
  expect(await readFeatureForEditor(root, "specs/quote.feature.md")).toContain("## Idea @v1 [draft]");
});

// Why draft deletion needs a route of its own: markdown cannot say a draft
// is gone, so saving the feature without it removes nothing.
test("saving a feature without its draft leaves the draft in place", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await saveFeature(root, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
  expect(result.content).toContain("## Idea @v1 [draft]");
});

// specs/ui/ui.feature.md "Scenario editor": Delete on a draft removes it from
// the document — the file never held it, and the editor stops showing it.
test("deleteDraftScenario removes the draft from the document", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await deleteDraftScenario(root, "specs/quote.feature.md", { name: "Idea", version: 1 });
  expect(result.status).toBe("saved");
  expect(result.content).not.toContain("Idea");
  expect(result.content).toContain("## S1: Basic @v1 [proposed]");
  const loaded = await loadFeatureDoc(root, "specs/quote.feature.md");
  expect(loaded!.doc.specs.map((s) => s.name)).toEqual(["Basic"]);
  expect(await readFeatureForEditor(root, "specs/quote.feature.md")).not.toContain("Idea");
  // The scenario the file does hold is untouched.
  expect(await readFeature(root, "specs/quote.feature.md")).toContain("## S1: Basic @v1 [proposed]");
});

// The delete is version-specific: two drafts under one name are two scenarios.
test("deleteDraftScenario deletes only the targeted version", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Idea @v1 [draft]\n\nold\n\n## Idea @v2 [draft]\n\nnew\n",
  );
  const result = await deleteDraftScenario(root, "specs/quote.feature.md", { name: "Idea", version: 1 });
  expect(result.content).not.toContain("Idea @v1");
  expect(result.content).toContain("## Idea @v2 [draft]");
});

// Drafts only: a proposed or published scenario is deleted by saving the
// feature without it, and a published one cannot be deleted at all.
test("deleteDraftScenario refuses a scenario that is not a draft", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
  expect(
    deleteDraftScenario(root, "specs/quote.feature.md", { name: "Basic", version: 1 }),
  ).rejects.toThrow(/not found/);
  expect(await readFeature(root, "specs/quote.feature.md")).toContain("## S1: Basic @v1 [proposed]");
});

test("deleteDraftScenario reports an unknown scenario rather than deleting nothing quietly", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "specs/quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  expect(
    deleteDraftScenario(root, "specs/quote.feature.md", { name: "Idea", version: 7 }),
  ).rejects.toThrow(/not found/);
  expect(await readFeatureForEditor(root, "specs/quote.feature.md")).toContain("## Idea @v1 [draft]");
});

// Publish All leaves drafts alone: they stay drafts, out of the file.
test("publishFeature leaves drafts unpublished and out of the file", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await publishFeature(
    root,
    "specs/quote.feature.md",
    (await readFeatureForEditor(root, "specs/quote.feature.md"))!,
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "specs/quote.feature.md");
  expect(text).toContain("## S1: Basic @v1 [published]");
  expect(text).not.toContain("Idea");
  expect(await readFeatureForEditor(root, "specs/quote.feature.md")).toContain("## Idea @v1 [draft]");
});

// Publishing a draft from its own card is an explicit action on that
// scenario: it promotes into the file as [published].
test("a draft publishes when targeted individually", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const result = await publishFeature(
    root,
    "specs/quote.feature.md",
    (await readFeatureForEditor(root, "specs/quote.feature.md"))!,
    { name: "Idea", version: 1 },
  );
  expect(result.status).toBe("published");
  expect(await readFeature(root, "specs/quote.feature.md")).toContain("## S1: Idea @v1 [published]");
});

// Same scenario name, different versions: only the targeted version flips.
test("publishFeature with a scenario target is version-specific", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold\n\n## Basic @v2\n\nnew\n",
  );
  await publishFeature(
    root,
    "specs/quote.feature.md",
    (await readFeature(root, "specs/quote.feature.md"))!,
    { name: "Basic", version: 2 },
  );
  const text = await readFeature(root, "specs/quote.feature.md");
  expect(text).toContain("## S1: Basic @v1 [proposed]");
  expect(text).toContain("## S2: Basic @v2 [published]");
});

// crud-feature.md "Feature file format": content that is not a
// well-formed feature file never reaches the data repo — the file on disk is
// left exactly as it was, so there is nothing for the next sync to push.
describe("content is validated before it is written to the data repo", () => {
  const GOOD = "# Quote\n\n## S1: Basic @v1 [published]\n\nbody\n";
  const BROKEN: Record<string, string> = {
    "the heading lost its name": "# \n\n## Basic @v1 [published]\n\nbody\n",
    "text sits above the heading": "git diff# Quote\n\n## Basic @v1 [published]\n\nbody\n",
    "there is no feature heading": "## Basic @v1 [published]\n\nbody\n",
    "the file is empty": "",
  };

  beforeEach(async () => {
    await createFeature(root, "Quote");
    await publishFeature(root, "specs/quote.feature.md", GOOD);
  });

  for (const [why, content] of Object.entries(BROKEN)) {
    test(`saveFeature refuses content where ${why}`, async () => {
      expect(saveFeature(root, "specs/quote.feature.md", content)).rejects.toThrow(
        "Refusing to write specs/quote.feature.md",
      );
      expect(await readFeature(root, "specs/quote.feature.md")).toBe(GOOD);
    });

    test(`publishFeature refuses content where ${why}`, async () => {
      expect(publishFeature(root, "specs/quote.feature.md", content)).rejects.toThrow(
        "Refusing to write specs/quote.feature.md",
      );
      expect(await readFeature(root, "specs/quote.feature.md")).toBe(GOOD);
    });
  }

  // The bug this guards against: a feature whose name was lost round-tripped
  // through parse → serialize, prepending one more nameless `# ` per save.
  test("a save cannot append a second feature heading", async () => {
    expect(saveFeature(root, "specs/quote.feature.md", `# \n\n${GOOD}`)).rejects.toThrow(
      "Refusing to write",
    );
  });
});

test("publishFeature rejects a scenario target that is not in the content", async () => {
  await createFeature(root, "Quote");
  expect(
    publishFeature(root, "specs/quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n", {
      name: "Missing",
      version: 3,
    }),
  ).rejects.toThrow('Scenario "Missing" v3 not found');
});

test("saving into a plain directory (no standalone git repo) still works", async () => {
  await createFeature(root, "Standalone");
  const result = await publishFeature(root, "specs/standalone.feature.md", "# Standalone\nedited\n");
  expect(result.status).toBe("published");
  // The file holds the doc's canonical projection: parse-equal to the input,
  // normalized formatting (blank line after the heading, trailing newline).
  expect(await readFeature(root, "specs/standalone.feature.md")).toBe("# Standalone\n\nedited\n");
});

// specs/ui/ui.feature.md: "If a scenario is already published, then it is
// immutable."
test("published scenarios are immutable, but new versions may be added", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold body\n",
  );
  expect(await readFeature(root, "specs/quote.feature.md")).toContain(
    "## S1: Basic @v1 [published]",
  );

  // changing a published scenario's body is rejected
  expect(
    publishFeature(
      root,
      "specs/quote.feature.md",
      "# Quote\n\n## Basic @v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
  // dropping a published scenario is rejected
  expect(publishFeature(root, "specs/quote.feature.md", "# Quote\n")).rejects.toThrow("immutable");

  // adding a new version alongside the published one is fine
  const result = await publishFeature(
    root,
    "specs/quote.feature.md",
    "# Quote\n\n## Basic @v1 [published]\n\nold body\n\n## Basic @v2\n\nnew body\n",
  );
  expect(result.status).toBe("published");
  expect(await readFeature(root, "specs/quote.feature.md")).toContain("## S2: Basic @v2 [published]");
});

// Every push/pull flow runs against a local-path origin on the system-git
// engine, and on all three — plain system git, the GitHub CLI (a stub gh on
// PATH) and the bundled JavaScript one — under SPECDRIVEN_ALL_ENGINES=1
// (helpers/engines.ts).
for (const engine of gitEngines()) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // specs/ui/ui.feature.md "Main page": the Edit link edits the feature name
    // — the file's `# <name>` heading — not the file name. The change is
    // committed and pushed; the other clone sees the new name on pull, at the
    // same file.
    test("renameFeature rewrites the heading, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await renameFeature(a, "specs/seed.feature.md", "Sprout Policy");
      expect(result).toEqual({
        fileName: "specs/seed.feature.md",
        name: "Sprout Policy",
        message: "committed and pushed",
      });
      expect(await readFeature(a, "specs/seed.feature.md")).toBe("# Sprout Policy\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Rename feature: Seed -> Sprout Policy");
      await git(b, "pull");
      expect(await readFeature(b, "specs/seed.feature.md")).toBe("# Sprout Policy\n");
    });

    // specs/ui/ui.feature.md "Feature entry menu" (File → Rename): renames the
    // underlying file — a `git mv`, committed and pushed; the other clone sees
    // the file under its new name on pull.
    test("renameFeatureFile renames via git mv, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await renameFeatureFile(a, "specs/seed.feature.md", "Sprout");
      expect(result).toEqual({
        fileName: "specs/sprout.feature.md",
        message: "renamed, committed and pushed",
      });
      expect(await readFeature(a, "specs/seed.feature.md")).toBeNull();
      expect(await readFeature(a, "specs/sprout.feature.md")).toBe("# Seed\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain(
        "Rename file: specs/seed.feature.md -> specs/sprout.feature.md",
      );
      await git(b, "pull");
      expect(await readFeature(b, "specs/sprout.feature.md")).toBe("# Seed\n");
      expect(await readFeature(b, "specs/seed.feature.md")).toBeNull();
    });

    // specs/ui/ui.feature.md "Feature entry menu" (Delete): a `git rm`,
    // committed and pushed — the other clone loses the file on pull.
    test("deleteFeature removes the file, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await deleteFeature(a, "specs/seed.feature.md");
      expect(result.message).toBe("deleted, committed and pushed");
      expect(await readFeature(a, "specs/seed.feature.md")).toBeNull();
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Delete feature: specs/seed.feature.md");
      await git(b, "pull");
      expect(await readFeature(b, "specs/seed.feature.md")).toBeNull();
    });

    // Scenario: Scenario is automatically saved locally and pushed to GitHub —
    // the save itself only writes locally (no data loss even offline); the reload
    // cron does the commit and push.
    test("saveFeature writes locally with proposed chips and no commit", async () => {
      const { a } = await twoClones(root);
      const result = await saveFeature(
        a,
        "specs/seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n",
      );
      expect(result.status).toBe("saved");
      expect(result.content).toContain("## S1: One @v1 [proposed]");
      expect(await readFeature(a, "specs/seed.feature.md")).toContain("## S1: One @v1 [proposed]");
      // not committed: the working tree is dirty until the reload cron syncs
      const status = await git(a, "status", "--porcelain");
      expect(status.stdout.toString()).toContain("specs/seed.feature.md");
    });

    // An individual publish is committed and pushed like a whole-feature publish.
    test("scenario publish commits and pushes to origin", async () => {
      const { a, b } = await twoClones(root);
      const result = await publishFeature(
        a,
        "specs/seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n\n## Two @v1\n\nbody\n",
        { name: "One", version: 1 },
      );
      expect(result.status).toBe("published");
      expect(result.message).toBe("committed and pushed");
      await git(b, "pull");
      const text = await readFeature(b, "specs/seed.feature.md");
      expect(text).toContain("## S1: One @v1 [published]");
      expect(text).not.toContain("Two @v1 [published]");
    });

    // Scenario: Publish feature with successful merge — pull, then save.
    test("publishFeature pulls cleanly and saves when there is no conflict", async () => {
      const { a, b } = await twoClones(root);
      // b adds an unrelated file and pushes
      await Bun.write(join(b, "specs/other.feature.md"), "# Other\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "other");
      await git(b, "push");
      // a saves seed.feature.md — the pull merges b's change in first
      const result = await publishFeature(
        a,
        "specs/seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n",
      );
      expect(result.status).toBe("published");
      expect(await readFeature(a, "specs/other.feature.md")).toBe("# Other\n");
      expect(await readFeature(a, "specs/seed.feature.md")).toContain("## S1: One @v1 [published]");
    });

    // crud-feature.spec.md "Publish feature with successful merge": after saving,
    // do a git commit and push — the other clone must see the change on pull.
    test("publishFeature commits and pushes to origin", async () => {
      const { a, b } = await twoClones(root);
      const result = await publishFeature(a, "specs/seed.feature.md", "# Seed v2\n");
      expect(result.status).toBe("published");
      expect(result.message).toBe("committed and pushed");
      await git(b, "pull");
      expect(await readFeature(b, "specs/seed.feature.md")).toBe("# Seed v2\n");
    });

    // Scenario: Publish feature with merge conflict — surface both sides, then resolve.
    test("conflicting saves surface theirs and can be resolved", async () => {
      const { a, b } = await twoClones(root);
      // b edits seed.feature.md and pushes
      await Bun.write(join(b, "specs/seed.feature.md"), "# Seed (theirs)\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "theirs");
      await git(b, "push");
      // a has committed a different edit locally, then tries to save
      await Bun.write(join(a, "specs/seed.feature.md"), "# Seed (local)\n");
      await git(a, "add", ".");
      await git(a, "commit", "-m", "local");

      const ours = "# Seed (ours)\n";
      const result = await publishFeature(a, "specs/seed.feature.md", ours);
      expect(result.status).toBe("conflict");
      expect(result.theirs).toBe("# Seed (theirs)\n");
      expect(result.ours).toBe(ours);

      // accept theirs
      const resolved = await resolveFeatureConflict(a, "specs/seed.feature.md", result.theirs!);
      expect(resolved.status).toBe("published");
      expect(await readFeature(a, "specs/seed.feature.md")).toBe("# Seed (theirs)\n");
      // crud-feature.spec.md "Publish feature with merge conflict": the resolution
      // is committed and pushed — origin has the merge.
      expect(resolved.message).toContain("committed and pushed");
      await git(b, "pull");
      expect(await readFeature(b, "specs/seed.feature.md")).toBe("# Seed (theirs)\n");
      // merge is complete: repo is clean enough to save again
      const again = await publishFeature(a, "specs/seed.feature.md", "# Seed final\n");
      expect(again.status).toBe("published");
    });

    // A pull that fails outright — here for want of credentials — is an
    // error, not a merge conflict: publish must not open a conflict dialog
    // whose "theirs" pane claims the file is missing on the remote.
    test("publish reports a failed pull as an error, not a conflict", async () => {
      const { a } = await twoClones(root);
      const wall = Bun.serve({
        port: 0,
        fetch: () =>
          new Response("auth required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="wall"' },
          }),
      });
      try {
        await git(a, "remote", "set-url", "origin", `http://127.0.0.1:${wall.port}/origin.git`);
        await expect(publishFeature(a, "specs/seed.feature.md", "# Seed v2\n")).rejects.toThrow(
          "Publish failed — git pull:",
        );
      } finally {
        wall.stop(true);
      }
    });

    // The resolution is a true merge: a two-parent commit both clones converge
    // on, not a plain commit that abandons one side's history.
    test("conflict resolution creates a merge commit both clones converge on", async () => {
      const { a, b } = await twoClones(root);
      await Bun.write(join(b, "specs/seed.feature.md"), "# Seed (theirs)\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "theirs");
      await git(b, "push");
      await Bun.write(join(a, "specs/seed.feature.md"), "# Seed (local)\n");
      await git(a, "add", ".");
      await git(a, "commit", "-m", "local");

      const result = await publishFeature(a, "specs/seed.feature.md", "# Seed (ours)\n");
      expect(result.status).toBe("conflict");
      const resolved = await resolveFeatureConflict(a, "specs/seed.feature.md", "# Seed (manual)\n");
      expect(resolved.status).toBe("published");

      const parents = await git(a, "log", "-1", "--pretty=%P");
      expect(parents.stdout.toString().trim().split(/\s+/)).toHaveLength(2);
      await git(b, "pull");
      expect(await readFeature(b, "specs/seed.feature.md")).toBe("# Seed (manual)\n");
    });
  });
}

// The Automerge document is the system of record; the markdown file is its
// projection (src/server/automerge/). After every mutation through the CRUD
// layer the two must agree — a peer must never receive one without the other.
describe("doc/markdown lockstep", () => {
  const lockstep = async (fileName: string) => {
    const md = await readFeature(root, fileName);
    const loaded = await loadFeatureDoc(root, fileName);
    expect(loaded).not.toBeNull();
    expect(md).not.toBeNull();
    expect(projectFeature(loaded!.doc)).toBe(md!);
  };

  test("create, save, publish and rename keep doc and markdown in lockstep", async () => {
    const file = await createFeature(root, "Quote");
    await lockstep(file);
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody\n");
    await lockstep(file);
    await publishFeature(root, file, (await readFeature(root, file))!);
    await lockstep(file);
    await renameFeature(root, file, "Quote 2");
    await lockstep(file);
  });

  test("a scenario keeps its doc identity across saves", async () => {
    const file = await createFeature(root, "Quote");
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody\n");
    const before = (await loadFeatureDoc(root, file))!.doc.specs[0]!;
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody, edited\n");
    const after = (await loadFeatureDoc(root, file))!.doc.specs[0]!;
    expect(after.id).toBe(before.id);
  });

  test("moving a feature moves its doc directory along", async () => {
    const file = await createFeature(root, "Quote");
    await createFolder(root, "billing");
    const moved = await moveFeature(root, file, "billing");
    expect(await loadFeatureDoc(root, file)).toBeNull();
    await lockstep(moved.fileName);
  });

  test("a save after a move does not recreate the retired path", async () => {
    const file = await createFeature(root, "Quote");
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody\n");
    await createFolder(root, "billing");
    const moved = await moveFeature(root, file, "billing");
    await expect(
      saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nstale editor\n"),
    ).rejects.toThrow("Feature file not found");
    expect(await readFeature(root, file)).toBeNull();
    expect(await loadFeatureDoc(root, file)).toBeNull();
    expect(await readFeature(root, moved.fileName)).toContain("body");
  });

  test("a save after a file rename does not recreate the old name", async () => {
    const file = await createFeature(root, "Quote");
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody\n");
    const renamed = await renameFeatureFile(root, file, "quotation");
    await expect(
      saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nstale editor\n"),
    ).rejects.toThrow("Feature file not found");
    expect(await readFeature(root, file)).toBeNull();
    expect(await readFeature(root, renamed.fileName)).toContain("body");
  });

  test("renaming a feature file moves its doc directory along", async () => {
    const file = await createFeature(root, "Quote");
    const renamed = await renameFeatureFile(root, file, "quotation");
    expect(await loadFeatureDoc(root, file)).toBeNull();
    await lockstep(renamed.fileName);
  });

  test("deleting a feature deletes its doc directory", async () => {
    const file = await createFeature(root, "Quote");
    await deleteFeature(root, file);
    expect(await loadFeatureDoc(root, file)).toBeNull();
  });
});

// Every write overwrites the file with the document's projection, not just
// the editor's save (which folds the disk edit in itself — "a save racing an
// unsynced disk edit" above): a file edited on disk since the last sync tick
// (importDrift) is absorbed first and the write folded in on top, by the same
// rule, so no path drops a disk edit unseen.
describe("a write over a file edited on disk since the last sync tick", () => {
  const file = "specs/billing/race.feature.md";
  const start = "# Race\n\n## Hello @v1 [proposed]\n\n- **Given** x\n";

  const seed = async () => {
    await Bun.write(join(root, file), start);
    await importDrift(root);
    // A file written before the scenario numbers is adopted as it is
    // (driftSync importDrift, project.ts isProjectionOf): no rewrite.
    expect(await readFeature(root, file)).toBe(start);
  };

  const inLockstep = async () => {
    const md = (await readFeature(root, file))!;
    expect(projectFeature((await loadFeatureDoc(root, file))!.doc)).toBe(md);
    // Nothing is left over for the next tick to absorb — or to lose.
    expect(await importDrift(root)).toBe("");
    return md;
  };

  test("a publish keeps the disk edit alongside what it publishes", async () => {
    await seed();
    await Bun.write(join(root, file), start + "\n## Disk-only @v1 [proposed]\n\nfrom disk\n");
    const result = await publishFeature(root, file, start, { name: "Hello", version: 1 });
    expect(result.status).toBe("published");
    // The disk edit carried no numbers, so it reads in the legacy order —
    // by name — and the publish writes the numbers.
    expect(await inLockstep()).toBe(
      "# Race\n\n## S1: Disk-only @v1 [proposed]\n\nfrom disk\n\n" +
        "## S2: Hello @v1 [published]\n\n- **Given** x\n",
    );
  });

  test("a publish that changed the same text as the disk edit is refused", async () => {
    await seed();
    const onDisk = start.replace("- **Given** x", "- **Given** x from disk");
    await Bun.write(join(root, file), onDisk);
    await expect(
      publishFeature(root, file, start.replace("- **Given** x", "- **Given** x from the editor")),
    ).rejects.toThrow("edited on disk");
    expect(await readFeature(root, file)).toBe(onDisk);
  });

  test("a disk edit that no longer parses refuses the save instead of overwriting it", async () => {
    await seed();
    const broken = "junk above the heading\n" + start;
    await Bun.write(join(root, file), broken);
    await expect(
      saveFeature(root, file, "# Race\n\n## Hello @v1 [proposed]\n\n- **Given** z\n"),
    ).rejects.toThrow("changed on disk");
    expect(await readFeature(root, file)).toBe(broken);
  });
});

// The two ways a save once lost scenario text with no error, now kept
// (parser.ts splitTests, trimBlankLines) and checked here through the whole
// write: parse, reconcile into the document, project, write.
describe("a save keeps body text the parser once dropped", () => {
  const file = "specs/kept.feature.md";
  const start = "# Kept\n\n## S1: A @v1 [proposed]\n\nGiven x\n\n## S2: B @v1 [proposed]\n\nGiven y\n";

  beforeEach(async () => {
    await createFeature(root, "Kept", start);
  });

  // specs/external-links/test-traceability.feature.md "a Tests heading over
  // the author's own notes stays in the body"
  test("a Tests heading with notes under it survives the save", async () => {
    const edited = start.replace(
      "Given x\n",
      "Given x\n\n### Tests\n\nManual checklist:\n- open the app\n- see https://example.com/dash\n\nAnd then more steps\n",
    );
    await saveFeature(root, file, edited);
    expect(await readFeature(root, file)).toBe(edited);
    const doc = (await loadFeatureDoc(root, file))!.doc;
    expect(doc.specs[0]!.body).toContain("And then more steps");
    expect([...doc.specs[0]!.tests]).toEqual([]);
  });

  // specs/editor/editor-autosave.feature.md "Autosave Waits While a Code
  // Fence Is Open": the indented fence line is content, not a fence, and
  // the file written says so too — the next save is not refused.
  test("a body opening with an indented fence line saves, and saves again", async () => {
    const edited = start.replace("Given x\n", "    ```\n    indented code\n");
    await saveFeature(root, file, edited);
    expect(await readFeature(root, file)).toBe(edited);
    const again = (await readFeatureForEditor(root, file))!;
    await saveFeature(root, file, again.replace("Given y", "Given y edited"));
    const doc = (await loadFeatureDoc(root, file))!.doc;
    expect(doc.specs.map((e) => e.body)).toEqual(["    ```\n    indented code", "Given y edited"]);
  });
});
