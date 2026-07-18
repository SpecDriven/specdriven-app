import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import {
  parseGitHubUrl,
  looksLikeRepoUrl,
  cloneDir,
  ensureClone,
  resolveDataRepo,
} from "../src/server/repo";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-repo-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// specs/app-start.spec.md: data repo format is a regular gitHub url,
// e.g. https://github.com/SpecDriven/data-insurance
test("parses a regular GitHub url", () => {
  expect(parseGitHubUrl("https://github.com/SpecDriven/data-insurance")).toEqual({
    url: "https://github.com/SpecDriven/data-insurance",
    name: "data-insurance",
  });
});

test("accepts .git suffix, trailing slash, and scheme-less variants", () => {
  expect(parseGitHubUrl("https://github.com/SpecDriven/data-insurance.git")?.name).toBe(
    "data-insurance",
  );
  expect(parseGitHubUrl("https://github.com/SpecDriven/data-insurance/")?.name).toBe(
    "data-insurance",
  );
  expect(parseGitHubUrl("github.com/SpecDriven/data-insurance")).toEqual({
    url: "https://github.com/SpecDriven/data-insurance",
    name: "data-insurance",
  });
});

test("accepts ssh remotes", () => {
  expect(parseGitHubUrl("git@github.com:SpecDriven/data-insurance.git")).toEqual({
    url: "git@github.com:SpecDriven/data-insurance.git",
    name: "data-insurance",
  });
});

test("rejects paths, non-GitHub urls, and traversal-shaped names", () => {
  expect(parseGitHubUrl("data")).toBeNull();
  expect(parseGitHubUrl("../data-insurance")).toBeNull();
  expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
  expect(parseGitHubUrl("https://github.com/owner/repo/tree/main")).toBeNull();
  expect(parseGitHubUrl("https://github.com/owner/..")).toBeNull();
});

test("looksLikeRepoUrl separates urls from local paths", () => {
  expect(looksLikeRepoUrl("https://github.com/owner/repo/tree/main")).toBe(true);
  expect(looksLikeRepoUrl("git@github.com:owner/repo")).toBe(true);
  expect(looksLikeRepoUrl("data")).toBe(false);
  expect(looksLikeRepoUrl("../data-insurance")).toBe(false);
});

test("a GitHub repo maps to a sibling directory of the app root", () => {
  expect(cloneDir("/home/user/dev/sd_fable", "data-insurance")).toBe(
    "/home/user/dev/data-insurance",
  );
});

test("resolveDataRepo resolves plain names and paths against the app root", async () => {
  expect(await resolveDataRepo("data", root)).toBe(resolve(root, "data"));
  expect(await resolveDataRepo("../data-insurance", root)).toBe(resolve(root, "..", "data-insurance"));
  expect(await resolveDataRepo("/abs/path", root)).toBe("/abs/path");
});

test("url-shaped input that is not a GitHub repo url is rejected, not treated as a path", async () => {
  expect(resolveDataRepo("https://github.com/owner/repo/tree/main", root)).rejects.toThrow(
    "Unsupported data repo URL",
  );
  expect(resolveDataRepo("https://gitlab.com/owner/repo", root)).rejects.toThrow(
    "Unsupported data repo URL",
  );
});

/** A local origin with one commit, standing in for a GitHub remote. */
async function seededOrigin(): Promise<string> {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const seed = join(root, "seed");
  await $`git clone ${origin} ${seed}`.quiet().nothrow();
  await $`git -C ${seed} config user.email test@example.com`.quiet();
  await $`git -C ${seed} config user.name Test`.quiet();
  await $`git -C ${seed} checkout -B main`.quiet().nothrow();
  await Bun.write(join(seed, "seed.feature"), "Feature: Seed\n");
  await $`git -C ${seed} add .`.quiet();
  await $`git -C ${seed} commit -m seed`.quiet();
  await $`git -C ${seed} push origin main`.quiet();
  return origin;
}

test("ensureClone clones on first use and reuses an existing clone", async () => {
  const origin = await seededOrigin();
  const dir = join(root, "clone");
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "seed.feature")).exists()).toBe(true);
  // second call is a no-op on the pre-existing clone
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "seed.feature")).exists()).toBe(true);
});

test("ensureClone surfaces clone failures (no access / no such repo)", async () => {
  expect(ensureClone(join(root, "no-such-origin.git"), join(root, "x"))).rejects.toThrow(
    "Could not clone",
  );
});
