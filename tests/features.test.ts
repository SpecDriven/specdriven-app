import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  createFeature,
  listFeatures,
  readFeature,
  renameFeature,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
  slugify,
} from "../src/server/features";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-feat-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(dir: string, ...args: string[]) {
  const res = await $`git -C ${dir} ${args}`.quiet().nothrow();
  if (res.exitCode !== 0 && args[0] !== "pull") {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res;
}

/** Create an origin repo plus two clones, so pulls and pushes hit real git machinery. */
async function twoClones() {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const a = join(root, "a");
  const b = join(root, "b");
  await $`git clone ${origin} ${a}`.quiet().nothrow();
  await $`git clone ${origin} ${b}`.quiet().nothrow();
  for (const dir of [a, b]) {
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "user.name", "Test");
    // Pin the local branch name so `git push` maps onto origin/main
    // regardless of the machine's init.defaultBranch.
    await git(dir, "checkout", "-B", "main");
  }
  await Bun.write(join(a, "seed.feature.md"), "# Seed\n");
  await git(a, "add", ".");
  await git(a, "commit", "-m", "seed");
  await git(a, "push", "origin", "HEAD:main");
  await git(a, "branch", "--set-upstream-to=origin/main");
  await git(b, "pull", "origin", "main");
  await git(b, "branch", "--set-upstream-to=origin/main");
  return { a, b };
}

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

// specs/ui.spec.md "Main page": the Edit link edits the feature name — the
// file's `# <name>` heading — not the file name. The change is committed and
// pushed; the other clone sees the new name on pull, at the same file.
test("renameFeature rewrites the heading, commits and pushes", async () => {
  const { a, b } = await twoClones();
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
    "# One\n\nsome description\n\n## First v1 [published]\n\nbody\n",
  );
  await renameFeature(root, "one.feature.md", "Uno");
  expect(await readFeature(root, "one.feature.md")).toBe(
    "# Uno\n\nsome description\n\n## First v1 [published]\n\nbody\n",
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

// Scenario: Scenario is automatically saved locally and pushed to GitHub —
// the save itself only writes locally (no data loss even offline); the reload
// cron does the commit and push.
test("saveFeature writes locally with proposed chips and no commit", async () => {
  const { a } = await twoClones();
  const result = await saveFeature(
    a,
    "seed.feature.md",
    "# Seed\n\n## One v1\n\nbody\n",
  );
  expect(result.status).toBe("saved");
  expect(result.content).toContain("## One v1 [proposed]");
  expect(await readFeature(a, "seed.feature.md")).toContain("## One v1 [proposed]");
  // not committed: the working tree is dirty until the reload cron syncs
  const status = await git(a, "status", "--porcelain");
  expect(status.stdout.toString()).toContain("seed.feature.md");
});

test("saveFeature keeps published scenarios immutable", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic v1\n\nold body\n",
  );
  expect(
    saveFeature(
      root,
      "quote.feature.md",
      "# Quote\n\n## Basic v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
});

// Publishing a proposed scenario upgrades the proposed chip to published.
test("publishFeature upgrades proposed scenarios to published", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Basic v1\n\nbody\n");
  const result = await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic v1 [published]");
  expect(text).not.toContain("[proposed]");
});

// Scenario "publish each scenario individually": a targeted publish marks only
// that scenario [published], leaving the others as they were.
test("publishFeature with a scenario target publishes only that scenario", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic v1\n\none\n\n## Extra v1\n\ntwo\n",
  );
  const result = await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
    { name: "Basic", version: 1 },
  );
  expect(result.status).toBe("published");
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic v1 [published]");
  expect(text).toContain("## Extra v1 [proposed]");
});

// Same scenario name, different versions: only the targeted version flips.
test("publishFeature with a scenario target is version-specific", async () => {
  await createFeature(root, "Quote");
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic v1\n\nold\n\n## Basic v2\n\nnew\n",
  );
  await publishFeature(
    root,
    "quote.feature.md",
    (await readFeature(root, "quote.feature.md"))!,
    { name: "Basic", version: 2 },
  );
  const text = await readFeature(root, "quote.feature.md");
  expect(text).toContain("## Basic v1 [proposed]");
  expect(text).toContain("## Basic v2 [published]");
});

test("publishFeature rejects a scenario target that is not in the content", async () => {
  await createFeature(root, "Quote");
  expect(
    publishFeature(root, "quote.feature.md", "# Quote\n\n## Basic v1\n\nbody\n", {
      name: "Missing",
      version: 3,
    }),
  ).rejects.toThrow('Scenario "Missing" v3 not found');
});

// An individual publish is committed and pushed like a whole-feature publish.
test("scenario publish commits and pushes to origin", async () => {
  const { a, b } = await twoClones();
  const result = await publishFeature(
    a,
    "seed.feature.md",
    "# Seed\n\n## One v1\n\nbody\n\n## Two v1\n\nbody\n",
    { name: "One", version: 1 },
  );
  expect(result.status).toBe("published");
  expect(result.message).toBe("committed and pushed");
  await git(b, "pull");
  const text = await readFeature(b, "seed.feature.md");
  expect(text).toContain("## One v1 [published]");
  expect(text).not.toContain("## Two v1 [published]");
});

// Scenario: Publish feature with successful merge — pull, then save.
test("publishFeature pulls cleanly and saves when there is no conflict", async () => {
  const { a, b } = await twoClones();
  // b adds an unrelated file and pushes
  await Bun.write(join(b, "other.feature.md"), "# Other\n");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "other");
  await git(b, "push");
  // a saves seed.feature.md — the pull merges b's change in first
  const result = await publishFeature(
    a,
    "seed.feature.md",
    "# Seed\n\n## One v1\n\nbody\n",
  );
  expect(result.status).toBe("published");
  expect(await readFeature(a, "other.feature.md")).toBe("# Other\n");
  expect(await readFeature(a, "seed.feature.md")).toContain("## One v1 [published]");
});

// crud-feature.spec.md "Publish feature with successful merge": after saving,
// do a git commit and push — the other clone must see the change on pull.
test("publishFeature commits and pushes to origin", async () => {
  const { a, b } = await twoClones();
  const result = await publishFeature(a, "seed.feature.md", "# Seed v2\n");
  expect(result.status).toBe("published");
  expect(result.message).toBe("committed and pushed");
  await git(b, "pull");
  expect(await readFeature(b, "seed.feature.md")).toBe("# Seed v2\n");
});

// Scenario: Publish feature with merge conflict — surface both sides, then resolve.
test("conflicting saves surface theirs and can be resolved", async () => {
  const { a, b } = await twoClones();
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

test("saving into a plain directory (no standalone git repo) still works", async () => {
  await createFeature(root, "Standalone");
  const result = await publishFeature(root, "standalone.feature.md", "# Standalone\nedited\n");
  expect(result.status).toBe("published");
  expect(await readFeature(root, "standalone.feature.md")).toBe("# Standalone\nedited\n");
});

// specs/ui.spec.md: "If a scenario is already published, then it is immutable."
test("published scenarios are immutable, but new versions may be added", async () => {
  await createFeature(root, "Quote");
  await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic v1\n\nold body\n",
  );
  expect(await readFeature(root, "quote.feature.md")).toContain(
    "## Basic v1 [published]",
  );

  // changing a published scenario's body is rejected
  expect(
    publishFeature(
      root,
      "quote.feature.md",
      "# Quote\n\n## Basic v1 [published]\n\nnew body\n",
    ),
  ).rejects.toThrow("immutable");
  // dropping a published scenario is rejected
  expect(publishFeature(root, "quote.feature.md", "# Quote\n")).rejects.toThrow("immutable");

  // adding a new version alongside the published one is fine
  const result = await publishFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic v1 [published]\n\nold body\n\n## Basic v2\n\nnew body\n",
  );
  expect(result.status).toBe("published");
  expect(await readFeature(root, "quote.feature.md")).toContain("## Basic v2 [published]");
});
