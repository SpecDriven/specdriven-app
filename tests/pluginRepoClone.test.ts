// How a plugin repository — a marketplace or a plugin's own — is cloned
// (specs/app/plugins.feature.md "A plugin repository is cloned by the first
// way that works"): the system git, then the git bundled with the app, then
// the GitHub CLI, each tried when the one before it fails, whatever the Git
// access setting says.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneMethods, clonePluginRepo, cloneThrough, setGitEngine, type CloneMethod } from "../src/server/git";
import { installFakeGh } from "./helpers/binPath";
import { seededOrigin } from "./helpers/fixtures";

let work: string;
const savedPath = process.env.PATH;
const savedHosted = process.env.SPECDRIVEN_HOSTED;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "specdriven-plugin-clone-"));
  delete process.env.SPECDRIVEN_HOSTED;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  if (savedHosted === undefined) delete process.env.SPECDRIVEN_HOSTED;
  else process.env.SPECDRIVEN_HOSTED = savedHosted;
  setGitEngine(null); // also forgets the gh this test may have put on PATH
  await rm(work, { recursive: true, force: true });
});

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A stand-in way of cloning that records its call, then fails or writes a marker file. */
function method(label: string, calls: string[], outcome: "ok" | "fail"): CloneMethod {
  return {
    label,
    clone: async (url, dir) => {
      calls.push(label);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "by"), label);
      if (outcome === "fail") throw new Error(`Could not clone ${url}: ${label} broke`);
    },
  };
}

test("the system git is tried first, then the built-in git, then the GitHub CLI", () => {
  // The test PATH holds git and no gh (tests/preload.ts).
  expect(cloneMethods().map((m) => m.label)).toEqual(["system git", "built-in git"]);

  const gh = installFakeGh();
  setGitEngine(null);
  try {
    expect(cloneMethods().map((m) => m.label)).toEqual(["system git", "built-in git", "GitHub CLI"]);
    // The order does not follow the Git access setting.
    setGitEngine("gh");
    expect(cloneMethods().map((m) => m.label)).toEqual(["system git", "built-in git", "GitHub CLI"]);
    // A hosted worker never clones with gh.
    process.env.SPECDRIVEN_HOSTED = "1";
    expect(cloneMethods().map((m) => m.label)).toEqual(["system git", "built-in git"]);
  } finally {
    gh.restore();
  }

  // No git installed: the built-in one alone (gh needs git to clone).
  process.env.PATH = work;
  setGitEngine(null);
  expect(cloneMethods().map((m) => m.label)).toEqual(["built-in git"]);
});

test("a way that fails hands over to the next, which starts from an empty folder", async () => {
  const calls: string[] = [];
  const dir = join(work, "clone");
  await cloneThrough(
    [method("system git", calls, "fail"), method("built-in git", calls, "ok"), method("GitHub CLI", calls, "ok")],
    "https://example.test/plugins.git",
    dir,
  );
  // The third way is never reached once the second works.
  expect(calls).toEqual(["system git", "built-in git"]);
  expect(await readFile(join(dir, "by"), "utf8")).toBe("built-in git");

  // The first way working is the only one run.
  calls.length = 0;
  await rm(dir, { recursive: true, force: true });
  await cloneThrough([method("system git", calls, "ok"), method("built-in git", calls, "ok")], "u", dir);
  expect(calls).toEqual(["system git"]);
});

test("when every way fails the error names each with its reason, and nothing is left behind", async () => {
  const calls: string[] = [];
  const dir = join(work, "clone");
  const url = "https://example.test/plugins.git";
  const failed = cloneThrough(
    [method("system git", calls, "fail"), method("built-in git", calls, "fail"), method("GitHub CLI", calls, "fail")],
    url,
    dir,
  );
  await expect(failed).rejects.toThrow(
    `Could not clone ${url} — system git: system git broke; built-in git: built-in git broke; GitHub CLI: GitHub CLI broke`,
  );
  expect(calls).toEqual(["system git", "built-in git", "GitHub CLI"]);
  expect(await exists(dir)).toBe(false);
});

test("a plugin repository is cloned whichever engine Settings names, and with no git installed at all", async () => {
  const origin = await seededOrigin(work);
  setGitEngine("js");
  await clonePluginRepo(origin, join(work, "with-git"));
  expect(await exists(join(work, "with-git", ".git"))).toBe(true);

  // Nothing on PATH: the system git is skipped and the built-in git clones.
  process.env.PATH = join(work, "empty-bin");
  setGitEngine("cli");
  await clonePluginRepo(origin, join(work, "without-git"));
  expect(await exists(join(work, "without-git", ".git"))).toBe(true);

  await expect(clonePluginRepo(join(work, "nowhere"), join(work, "missing"))).rejects.toThrow(/Could not clone/);
  expect(await exists(join(work, "missing"))).toBe(false);
});
