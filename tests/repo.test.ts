import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseGitHubUrl,
  looksLikeRepoUrl,
  cloneDir,
  dataRepoDir,
  ensureClone,
  resolveDataRepo,
} from "../src/server/repo";
import { currentEngine, setGitEngine } from "../src/server/git";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { seededOrigin, stopServers } from "./helpers/fixtures";
import { serveRepos } from "./helpers/gitHttpServer";

let root: string;
let fakeGh: FakeGh | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-repo-"));
});

afterEach(async () => {
  stopServers();
  fakeGh?.restore();
  fakeGh = null;
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
const localOrigin = (at?: string) => seededOrigin(root, at);

test("ensureClone clones on first use and reuses an existing clone", async () => {
  const origin = await localOrigin();
  const dir = join(root, "clone");
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "specs/seed.feature.md")).exists()).toBe(true);
  // second call is a no-op on the pre-existing clone
  await ensureClone(origin, dir);
  expect(await Bun.file(join(dir, "specs/seed.feature.md")).exists()).toBe(true);
});

test("ensureClone surfaces clone failures (no access / no such repo)", async () => {
  expect(ensureClone(join(root, "no-such-origin.git"), join(root, "x"))).rejects.toThrow(
    "Could not clone",
  );
});

// specs/git-operations.spec.md: a data repo url is cloned over smart-HTTP by
// the system-git engine, and the clone is where the configured repo resolves.
test("resolveDataRepo clones a repo url on the system-git engine", async () => {
  await localOrigin("test/origin.git");
  const server = serveRepos(root);
  process.env.SPECDRIVEN_GITHUB_URL = server.url;
  process.env.SPECDRIVEN_REPOS_DIR = join(root, "repos");
  try {
    expect(currentEngine()).toBe("cli"); // no gh on the tests' PATH
    const dir = await resolveDataRepo("https://github.com/test/origin", root);
    expect(dir).toBe(join(root, "repos", "origin"));
    expect(await Bun.file(join(dir, "specs/seed.feature.md")).exists()).toBe(true);
    // reuse without re-cloning
    expect(await resolveDataRepo("https://github.com/test/origin", root)).toBe(dir);
  } finally {
    server.stop();
  }
});

// specs/git-operations.spec.md: on the GitHub CLI engine the clone that backs
// a configured data repo is `gh repo clone`, so it carries gh's credentials.
test("resolveDataRepo clones through gh on the GitHub CLI engine", async () => {
  const origin = await localOrigin();
  fakeGh = installFakeGh({ origin });
  setGitEngine("gh");
  process.env.SPECDRIVEN_REPOS_DIR = join(root, "repos");
  const dir = await resolveDataRepo("https://github.com/test/origin", root);
  expect(dir).toBe(join(root, "repos", "origin"));
  expect(await Bun.file(join(dir, "specs/seed.feature.md")).exists()).toBe(true);
  expect(fakeGh.calls()).toContain("repo clone");
});
