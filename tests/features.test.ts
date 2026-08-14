import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  createFolder,
  deleteFeature,
  listFeatures,
  moveFeature,
  readFeature,
  renameFeature,
  renameFeatureFile,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
  slugify,
} from "../src/server/features";
import { projectFeature } from "../src/server/automerge/project";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import type { GitEngine } from "../src/server/git";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
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
  expect(fileName).toBe("quote-policy.feature.md");
  expect(await listFeatures(root)).toEqual([
    { fileName: "quote-policy.feature.md", name: "Quote Policy" },
  ]);
  expect(await readFeature(root, fileName)).toBe("# Quote Policy\n");
});

// specs/ui.spec.md "Main page": the sidebar shows feature names, not file
// names — the name comes from the `# <name>` heading, with the file stem as
// the fallback for files without one.
test("listFeatures returns display names, falling back to the stem", async () => {
  await Bun.write(join(root, "quote-policy.feature.md"), "# Quote & Policy!\n");
  await Bun.write(join(root, "no-heading.feature.md"), "just text\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "no-heading.feature.md", name: "No Heading" },
    { fileName: "quote-policy.feature.md", name: "Quote & Policy!" },
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
  const result = await renameFeature(root, "quote.feature.md", "Policy");
  expect(result.fileName).toBe("quote.feature.md");
  expect(result.name).toBe("Policy");
  expect(await readFeature(root, "quote.feature.md")).toBe("# Policy\n");
  expect(await listFeatures(root)).toEqual([
    { fileName: "quote.feature.md", name: "Policy" },
  ]);
});

// Scenarios and description survive a rename untouched; a file without a
// `# <name>` heading gains one.
test("renameFeature only touches the heading, adding one when missing", async () => {
  await Bun.write(
    join(root, "one.feature.md"),
    "# One\n\nsome description\n\n## First @v1 [published]\n\nbody\n",
  );
  await renameFeature(root, "one.feature.md", "Uno");
  expect(await readFeature(root, "one.feature.md")).toBe(
    "# Uno\n\nsome description\n\n## First @v1 [published]\n\nbody\n",
  );
  await Bun.write(join(root, "bare.feature.md"), "just text\n");
  await renameFeature(root, "bare.feature.md", "Named Now");
  expect(await readFeature(root, "bare.feature.md")).toBe("# Named Now\n\njust text\n");
});

test("renameFeature refuses missing files and empty names", async () => {
  await createFeature(root, "One");
  expect(renameFeature(root, "ghost.feature.md", "Spirit")).rejects.toThrow("not found");
  expect(renameFeature(root, "one.feature.md", "   ")).rejects.toThrow("required");
  expect(renameFeature(root, "../evil.feature.md", "Fine")).rejects.toThrow(
    "Invalid feature file name",
  );
  // renaming to the current name is a no-op, not an error
  const same = await renameFeature(root, "one.feature.md", "One");
  expect(same).toEqual({
    fileName: "one.feature.md",
    name: "One",
    message: "feature name unchanged",
  });
});

// The stem is slugified like a created file's; folder and extension are kept.
test("renameFeatureFile keeps the folder, slugifies the stem, and validates", async () => {
  await createFeature(root, "billing/Quote");
  const result = await renameFeatureFile(root, "billing/quote.feature.md", "Better Quote!");
  expect(result.fileName).toBe("billing/better-quote.feature.md");
  expect(await readFeature(root, "billing/better-quote.feature.md")).toBe("# Quote\n");
  expect(renameFeatureFile(root, "billing/better-quote.feature.md", "  ")).rejects.toThrow(
    "File name is required",
  );
  expect(renameFeatureFile(root, "ghost.feature.md", "spirit")).rejects.toThrow("not found");
  // renaming to the current stem is a no-op, not an error
  const same = await renameFeatureFile(root, "billing/better-quote.feature.md", "Better Quote");
  expect(same).toEqual({
    fileName: "billing/better-quote.feature.md",
    message: "file name unchanged",
  });
  // renaming onto an existing file is refused
  await createFeature(root, "billing/Other");
  expect(renameFeatureFile(root, "billing/other.feature.md", "Better Quote")).rejects.toThrow(
    "already exists",
  );
});

test("deleteFeature works in a plain directory and validates", async () => {
  await createFeature(root, "Quote");
  const result = await deleteFeature(root, "quote.feature.md");
  expect(result.message).toBe("deleted locally (not a git repository)");
  expect(await listFeatures(root)).toEqual([]);
  expect(deleteFeature(root, "quote.feature.md")).rejects.toThrow("not found");
  expect(deleteFeature(root, "../evil.feature.md")).rejects.toThrow("Invalid feature file name");
});

test("saveFeature keeps published scenarios immutable", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold body\n",
  );
  expect(
    saveFeature(
      root,
      "quote.feature.md",
      "# Quote\n\n## Basic @v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
});

// Publishing a proposed scenario upgrades the proposed chip to published.
test("publishFeature upgrades proposed scenarios to published", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
  const result = await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic @v1 [published]");
  expect(text).not.toContain("[proposed]");
});

// Scenario "publish each scenario individually": a targeted publish marks only
// that scenario [published], leaving the others as they were.
test("publishFeature with a scenario target publishes only that scenario", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\none\n\n## Extra @v1\n\ntwo\n",
  );
  const result = await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
    { name: "Basic", version: 1 },
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic @v1 [published]");
  expect(text).toContain("## Extra @v1 [proposed]");
});

// Same scenario name, different versions: only the targeted version flips.
test("publishFeature with a scenario target is version-specific", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold\n\n## Basic @v2\n\nnew\n",
  );
  await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
    { name: "Basic", version: 2 },
  );
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic @v1 [proposed]");
  expect(text).toContain("## Basic @v2 [published]");
});

// specs/crud-feature.spec.md "Feature file format": content that is not a
// well-formed feature file never reaches the data repo — the file on disk is
// left exactly as it was, so there is nothing for the next sync to push.
describe("content is validated before it is written to the data repo", () => {
  const GOOD = "# Quote\n\n## Basic @v1 [published]\n\nbody\n";
  const BROKEN: Record<string, string> = {
    "the heading lost its name": "# \n\n## Basic @v1 [published]\n\nbody\n",
    "text sits above the heading": "git diff# Quote\n\n## Basic @v1 [published]\n\nbody\n",
    "there is no feature heading": "## Basic @v1 [published]\n\nbody\n",
    "the file is empty": "",
  };

  beforeEach(async () => {
    await createFeature(root, "Quote");
    await publishFeature(root, "quote.feature.md", GOOD);
  });

  for (const [why, content] of Object.entries(BROKEN)) {
    test(`saveFeature refuses content where ${why}`, async () => {
      expect(saveFeature(root, "quote.feature.md", content)).rejects.toThrow(
        "Refusing to write quote.feature.md",
      );
      expect(await readFeature(root, "quote.feature.md")).toBe(GOOD);
    });

    test(`publishFeature refuses content where ${why}`, async () => {
      expect(publishFeature(root, "quote.feature.md", content)).rejects.toThrow(
        "Refusing to write quote.feature.md",
      );
      expect(await readFeature(root, "quote.feature.md")).toBe(GOOD);
    });
  }

  // The bug this guards against: a feature whose name was lost round-tripped
  // through parse → serialize, prepending one more nameless `# ` per save.
  test("a save cannot append a second feature heading", async () => {
    expect(saveFeature(root, "quote.feature.md", `# \n\n${GOOD}`)).rejects.toThrow(
      "Refusing to write",
    );
  });
});

test("publishFeature rejects a scenario target that is not in the content", async () => {
  await createFeature(root, "Quote");
  expect(
    publishFeature(root, "quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n", {
      name: "Missing",
      version: 3,
    }),
  ).rejects.toThrow('Scenario "Missing" v3 not found');
});

test("saving into a plain directory (no standalone git repo) still works", async () => {
  await createFeature(root, "Standalone");
  const result = await publishFeature(root, "standalone.feature.md", "# Standalone\nedited\n");
  expect(result.status).toBe("published");
  // The file holds the doc's canonical projection: parse-equal to the input,
  // normalized formatting (blank line after the heading, trailing newline).
  expect(await readFeature(root, "standalone.feature.md")).toBe("# Standalone\n\nedited\n");
});

// specs/ui.spec.md: "If a scenario is already published, then it is immutable."
test("published scenarios are immutable, but new versions may be added", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nold body\n",
  );
  expect(await readFeature(root, "quote.feature.md")).toContain(
    "## Basic @v1 [published]",
  );

  // changing a published scenario's body is rejected
  expect(
    publishFeature(
      root,
      "quote.feature.md",
      "# Quote\n\n## Basic @v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
  // dropping a published scenario is rejected
  expect(publishFeature(root, "quote.feature.md", "# Quote\n")).rejects.toThrow("immutable");

  // adding a new version alongside the published one is fine
  const result = await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1 [published]\n\nold body\n\n## Basic @v2\n\nnew body\n",
  );
  expect(result.status).toBe("published");
  expect(await readFeature(root, "quote.feature.md")).toContain("## Basic @v2 [published]");
});

// Every push/pull flow runs on all three git engines
// (specs/git-operations.spec.md): plain system git, the GitHub CLI (a stub gh
// on PATH) and the bundled JavaScript one, against the same smart-HTTP-served
// origin.
for (const engine of ["cli", "gh", "js"] as GitEngine[]) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // specs/ui.spec.md "Main page": the Edit link edits the feature name — the
    // file's `# <name>` heading — not the file name. The change is committed and
    // pushed; the other clone sees the new name on pull, at the same file.
    test("renameFeature rewrites the heading, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await renameFeature(a, "seed.feature.md", "Sprout Policy");
      expect(result).toEqual({
        fileName: "seed.feature.md",
        name: "Sprout Policy",
        message: "committed and pushed",
      });
      expect(await readFeature(a, "seed.feature.md")).toBe("# Sprout Policy\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Rename feature: Seed -> Sprout Policy");
      await git(b, "pull");
      expect(await readFeature(b, "seed.feature.md")).toBe("# Sprout Policy\n");
    });

    // specs/ui.spec.md "Feature entry menu" (File → Rename): renames the
    // underlying file — a `git mv`, committed and pushed; the other clone sees
    // the file under its new name on pull.
    test("renameFeatureFile renames via git mv, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await renameFeatureFile(a, "seed.feature.md", "Sprout");
      expect(result).toEqual({
        fileName: "sprout.feature.md",
        message: "renamed, committed and pushed",
      });
      expect(await readFeature(a, "seed.feature.md")).toBeNull();
      expect(await readFeature(a, "sprout.feature.md")).toBe("# Seed\n");
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain(
        "Rename file: seed.feature.md -> sprout.feature.md",
      );
      await git(b, "pull");
      expect(await readFeature(b, "sprout.feature.md")).toBe("# Seed\n");
      expect(await readFeature(b, "seed.feature.md")).toBeNull();
    });

    // specs/ui.spec.md "Feature entry menu" (Delete): a `git rm`, committed and
    // pushed — the other clone loses the file on pull.
    test("deleteFeature removes the file, commits and pushes", async () => {
      const { a, b } = await twoClones(root);
      const result = await deleteFeature(a, "seed.feature.md");
      expect(result.message).toBe("deleted, committed and pushed");
      expect(await readFeature(a, "seed.feature.md")).toBeNull();
      const log = await git(a, "log", "-1", "--pretty=%s");
      expect(log.stdout.toString()).toContain("Delete feature: seed.feature.md");
      await git(b, "pull");
      expect(await readFeature(b, "seed.feature.md")).toBeNull();
    });

    // Scenario: Scenario is automatically saved locally and pushed to GitHub —
    // the save itself only writes locally (no data loss even offline); the reload
    // cron does the commit and push.
    test("saveFeature writes locally with proposed chips and no commit", async () => {
      const { a } = await twoClones(root);
      const result = await saveFeature(
        a,
        "seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n",
      );
      expect(result.status).toBe("saved");
      expect(result.content).toContain("## One @v1 [proposed]");
      expect(await readFeature(a, "seed.feature.md")).toContain("## One @v1 [proposed]");
      // not committed: the working tree is dirty until the reload cron syncs
      const status = await git(a, "status", "--porcelain");
      expect(status.stdout.toString()).toContain("seed.feature.md");
    });

    // An individual publish is committed and pushed like a whole-feature publish.
    test("scenario publish commits and pushes to origin", async () => {
      const { a, b } = await twoClones(root);
      const result = await publishFeature(
        a,
        "seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n\n## Two @v1\n\nbody\n",
        { name: "One", version: 1 },
      );
      expect(result.status).toBe("published");
      expect(result.message).toBe("committed and pushed");
      await git(b, "pull");
      const text = await readFeature(b, "seed.feature.md");
      expect(text).toContain("## One @v1 [published]");
      expect(text).not.toContain("## Two @v1 [published]");
    });

    // Scenario: Publish feature with successful merge — pull, then save.
    test("publishFeature pulls cleanly and saves when there is no conflict", async () => {
      const { a, b } = await twoClones(root);
      // b adds an unrelated file and pushes
      await Bun.write(join(b, "other.feature.md"), "# Other\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "other");
      await git(b, "push");
      // a saves seed.feature.md — the pull merges b's change in first
      const result = await publishFeature(
        a,
        "seed.feature.md",
        "# Seed\n\n## One @v1\n\nbody\n",
      );
      expect(result.status).toBe("published");
      expect(await readFeature(a, "other.feature.md")).toBe("# Other\n");
      expect(await readFeature(a, "seed.feature.md")).toContain("## One @v1 [published]");
    });

    // crud-feature.spec.md "Publish feature with successful merge": after saving,
    // do a git commit and push — the other clone must see the change on pull.
    test("publishFeature commits and pushes to origin", async () => {
      const { a, b } = await twoClones(root);
      const result = await publishFeature(a, "seed.feature.md", "# Seed v2\n");
      expect(result.status).toBe("published");
      expect(result.message).toBe("committed and pushed");
      await git(b, "pull");
      expect(await readFeature(b, "seed.feature.md")).toBe("# Seed v2\n");
    });

    // Scenario: Publish feature with merge conflict — surface both sides, then resolve.
    test("conflicting saves surface theirs and can be resolved", async () => {
      const { a, b } = await twoClones(root);
      // b edits seed.feature.md and pushes
      await Bun.write(join(b, "seed.feature.md"), "# Seed (theirs)\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "theirs");
      await git(b, "push");
      // a has committed a different edit locally, then tries to save
      await Bun.write(join(a, "seed.feature.md"), "# Seed (local)\n");
      await git(a, "add", ".");
      await git(a, "commit", "-m", "local");

      const ours = "# Seed (ours)\n";
      const result = await publishFeature(a, "seed.feature.md", ours);
      expect(result.status).toBe("conflict");
      expect(result.theirs).toBe("# Seed (theirs)\n");
      expect(result.ours).toBe(ours);

      // accept theirs
      const resolved = await resolveFeatureConflict(a, "seed.feature.md", result.theirs!);
      expect(resolved.status).toBe("published");
      expect(await readFeature(a, "seed.feature.md")).toBe("# Seed (theirs)\n");
      // crud-feature.spec.md "Publish feature with merge conflict": the resolution
      // is committed and pushed — origin has the merge.
      expect(resolved.message).toContain("committed and pushed");
      await git(b, "pull");
      expect(await readFeature(b, "seed.feature.md")).toBe("# Seed (theirs)\n");
      // merge is complete: repo is clean enough to save again
      const again = await publishFeature(a, "seed.feature.md", "# Seed final\n");
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
        await expect(publishFeature(a, "seed.feature.md", "# Seed v2\n")).rejects.toThrow(
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
      await Bun.write(join(b, "seed.feature.md"), "# Seed (theirs)\n");
      await git(b, "add", ".");
      await git(b, "commit", "-m", "theirs");
      await git(b, "push");
      await Bun.write(join(a, "seed.feature.md"), "# Seed (local)\n");
      await git(a, "add", ".");
      await git(a, "commit", "-m", "local");

      const result = await publishFeature(a, "seed.feature.md", "# Seed (ours)\n");
      expect(result.status).toBe("conflict");
      const resolved = await resolveFeatureConflict(a, "seed.feature.md", "# Seed (manual)\n");
      expect(resolved.status).toBe("published");

      const parents = await git(a, "log", "-1", "--pretty=%P");
      expect(parents.stdout.toString().trim().split(/\s+/)).toHaveLength(2);
      await git(b, "pull");
      expect(await readFeature(b, "seed.feature.md")).toBe("# Seed (manual)\n");
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
    const before = (await loadFeatureDoc(root, file))!.doc.scenarios[0]!;
    await saveFeature(root, file, "# Quote\n\n## Basic @v1\n\nbody, edited\n");
    const after = (await loadFeatureDoc(root, file))!.doc.scenarios[0]!;
    expect(after.id).toBe(before.id);
  });

  test("moving a feature moves its doc directory along", async () => {
    const file = await createFeature(root, "Quote");
    await createFolder(root, "billing");
    const moved = await moveFeature(root, file, "billing");
    expect(await loadFeatureDoc(root, file)).toBeNull();
    await lockstep(moved.fileName);
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
