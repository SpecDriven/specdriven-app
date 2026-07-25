import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import {
  parseGitHubUrl,
  looksLikeRepoUrl,
  cloneDir,
  dataRepoDir,
  ensureClone,
  resolveDataRepo,
} from "../src/server/repo";
import { engineFor, setGitEngine } from "../src/server/git";
import { git, stopServers } from "./helpers/fixtures";
import { serveRepos } from "./helpers/gitHttpServer";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-repo-"));
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  delete process.env.SPECDRIVEN_GITHUB_URL;
  delete process.env.SPECDRIVEN_REPOS_DIR;
  await rm(root, { recursive: true, force: true });
});

// specs/app-start.spec.md: data repo format is a regular gitHub url,
// e.g. https://github.com/SpecDriven/data-insurance.
test("parses a regular GitHub url", () => {
  expect(parseGitHubUrl("https://github.com/SpecDriven/data-insurance")).toEqual({
    url: "https://github.com/SpecDriven/data-insurance",
    owner: "SpecDriven",
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
    owner: "SpecDriven",
    name: "data-insurance",
  });
});

test("accepts ssh remotes; the url form does not pick the transport", () => {
  expect(parseGitHubUrl("git@github.com:SpecDriven/data-insurance.git")).toEqual({
    url: "https://github.com/SpecDriven/data-insurance",
    owner: "SpecDriven",
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
  expect(cloneDir("/home/user/dev/specdriven", "data-insurance")).toBe(
    "/home/user/dev/data-insurance",
  );
});

test("dataRepoDir resolves urls and paths to their local directory without cloning", () => {
  expect(dataRepoDir("https://github.com/SpecDriven/data-insurance", "/home/user/dev/specdriven")).toBe(
    "/home/user/dev/data-insurance",
  );
  expect(dataRepoDir("data", "/home/user/dev/specdriven")).toBe("/home/user/dev/specdriven/data");
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
async function seededOrigin(at = "origin.git"): Promise<string> {
  const origin = join(root, at);
  await $`git init --bare -b main ${origin}`.quiet();
  const seed = join(root, "seed");
  await $`git clone ${origin} ${seed}`.quiet().nothrow();
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await git(seed, "checkout", "-B", "main");
  await Bun.write(join(seed, "seed.feature.md"), "# Seed\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "seed");
  await git(seed, "push", "origin", "main");
  await rm(seed, { recursive: true, force: true });
  return origin;
}

// A local-path origin cannot be reached by the built-in engine — the facade
// falls back to system git (specs/git-operations.spec.md), so pre-existing
// setups keep working.
test("ensureClone clones on first use and reuses an existing clone", async () => {
  const origin = await seededOrigin();
  const dir = join(root, "clone");
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "seed.feature.md")).exists()).toBe(true);
  expect(engineFor(dir)).toBe("cli"); // pinned by the fallback
  // second call is a no-op on the pre-existing clone
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "seed.feature.md")).exists()).toBe(true);
});

test("ensureClone surfaces clone failures (no access / no such repo)", async () => {
  expect(ensureClone(join(root, "no-such-origin.git"), join(root, "x"))).rejects.toThrow(
    "Could not clone",
  );
});

// specs/git-operations.spec.md: a GitHub data repo url is cloned over
// smart-HTTP by the built-in engine — no git installation involved.
test("resolveDataRepo clones a GitHub url with the built-in engine", async () => {
  await seededOrigin("test/origin.git");
  const server = serveRepos(root);
  process.env.SPECDRIVEN_GITHUB_URL = server.url;
  process.env.SPECDRIVEN_REPOS_DIR = join(root, "repos");
  try {
    const dir = await resolveDataRepo("https://github.com/test/origin", root);
    expect(dir).toBe(join(root, "repos", "origin"));
    expect(await Bun.file(join(dir, "seed.feature.md")).exists()).toBe(true);
    expect(engineFor(dir)).toBe("js"); // no fallback needed over http
    // reuse without re-cloning
    expect(await resolveDataRepo("https://github.com/test/origin", root)).toBe(dir);
  } finally {
    server.stop();
  }
});

// Clones from the old ssh-scheme era: the app-managed clone's origin is
// rewritten to https once, so both engines can keep talking to GitHub.
test("ensureClone rewrites an ssh-form origin to https", async () => {
  const origin = await seededOrigin();
  const dir = join(root, "clone");
  await ensureClone(origin, dir); // makes the clone (system git fallback)
  await git(dir, "remote", "set-url", "origin", "git@github.com:owner/data.git");
  await ensureClone("https://github.com/owner/data", dir);
  const url = await git(dir, "remote", "get-url", "origin");
  expect(url.stdout.toString().trim()).toBe("https://github.com/owner/data.git");
});

// A non-GitHub origin is left untouched by the migration.
test("ensureClone leaves non-GitHub origins alone", async () => {
  const origin = await seededOrigin();
  const dir = join(root, "clone");
  await ensureClone(origin, dir);
  await ensureClone(origin, dir);
  const url = await git(dir, "remote", "get-url", "origin");
  expect(url.stdout.toString().trim()).toBe(origin);
});
