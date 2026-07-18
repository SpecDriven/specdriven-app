import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  createFeature,
  listFeatures,
  readFeature,
  saveFeature,
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
  await Bun.write(join(a, "seed.feature"), "Feature: Seed\n");
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
test("createFeature writes a new .feature file and lists it", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  expect(fileName).toBe("quote-policy.feature");
  expect(await listFeatures(root)).toEqual(["quote-policy.feature"]);
  expect(await readFeature(root, fileName)).toBe("Feature: Quote Policy\n");
});

test("createFeature refuses to overwrite an existing feature", async () => {
  await createFeature(root, "Quote Policy");
  expect(createFeature(root, "Quote Policy")).rejects.toThrow("already exists");
});

test("path traversal in file names is rejected", async () => {
  expect(readFeature(root, "../evil.feature")).rejects.toThrow("Invalid feature file name");
  expect(saveFeature(root, "no-extension", "x")).rejects.toThrow("Invalid feature file name");
});

// Scenario: save feature with successful merge — pull, then save.
test("saveFeature pulls cleanly and saves when there is no conflict", async () => {
  const { a, b } = await twoClones();
  // b adds an unrelated file and pushes
  await Bun.write(join(b, "other.feature"), "Feature: Other\n");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "other");
  await git(b, "push");
  // a saves seed.feature — the pull merges b's change in first
  const result = await saveFeature(a, "seed.feature", "Feature: Seed\n\nScenario: One @v1\nbody\n");
  expect(result.status).toBe("saved");
  expect(await readFeature(a, "other.feature")).toBe("Feature: Other\n");
  expect(await readFeature(a, "seed.feature")).toContain("Scenario: One @v1");
});

// crud-feature.spec.md "save feature with successful merge": after saving,
// do a git commit and push — the other clone must see the change on pull.
test("saveFeature commits and pushes to origin", async () => {
  const { a, b } = await twoClones();
  const result = await saveFeature(a, "seed.feature", "Feature: Seed v2\n");
  expect(result.status).toBe("saved");
  expect(result.message).toBe("committed and pushed");
  await git(b, "pull");
  expect(await readFeature(b, "seed.feature")).toBe("Feature: Seed v2\n");
});

// Scenario: save feature with merge conflict — surface both sides, then resolve.
test("conflicting saves surface theirs and can be resolved", async () => {
  const { a, b } = await twoClones();
  // b edits seed.feature and pushes
  await Bun.write(join(b, "seed.feature"), "Feature: Seed (theirs)\n");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "theirs");
  await git(b, "push");
  // a has committed a different edit locally, then tries to save
  await Bun.write(join(a, "seed.feature"), "Feature: Seed (local)\n");
  await git(a, "add", ".");
  await git(a, "commit", "-m", "local");

  const ours = "Feature: Seed (ours)\n";
  const result = await saveFeature(a, "seed.feature", ours);
  expect(result.status).toBe("conflict");
  expect(result.theirs).toBe("Feature: Seed (theirs)\n");
  expect(result.ours).toBe(ours);

  // accept theirs
  const resolved = await resolveFeatureConflict(a, "seed.feature", result.theirs!);
  expect(resolved.status).toBe("saved");
  expect(await readFeature(a, "seed.feature")).toBe("Feature: Seed (theirs)\n");
  // crud-feature.spec.md "save feature with merge conflict": the resolution
  // is committed and pushed — origin has the merge.
  expect(resolved.message).toContain("committed and pushed");
  await git(b, "pull");
  expect(await readFeature(b, "seed.feature")).toBe("Feature: Seed (theirs)\n");
  // merge is complete: repo is clean enough to save again
  const again = await saveFeature(a, "seed.feature", "Feature: Seed final\n");
  expect(again.status).toBe("saved");
});

test("saving into a plain directory (no standalone git repo) still works", async () => {
  await createFeature(root, "Standalone");
  const result = await saveFeature(root, "standalone.feature", "Feature: Standalone\nedited\n");
  expect(result.status).toBe("saved");
  expect(await readFeature(root, "standalone.feature")).toBe("Feature: Standalone\nedited\n");
});
