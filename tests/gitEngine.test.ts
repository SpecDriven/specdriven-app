// Git engine selection (specs/git-operations.spec.md): the GitHub CLI is the
// default wherever gh is installed, Settings can force either engine, and an
// engine whose binary is missing is a clear error rather than a hang. The gh
// engine itself is exercised against a stub gh on PATH (helpers/binPath.ts),
// so nothing here talks to real GitHub.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  cliGitAvailable,
  clone,
  commitAndPush,
  currentEngine,
  ghAccount,
  ghAvailable,
  ghSignedIn,
  normalizeGitEngine,
  pull,
  setGitEngine,
} from "../src/server/git";
import { FAKE_GH_ACCOUNT, installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { git } from "./helpers/fixtures";

let root: string;
let gh: FakeGh | null = null;
const realPath = process.env.PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-engine-"));
});

afterEach(async () => {
  gh?.restore();
  gh = null;
  setGitEngine(null);
  process.env.PATH = realPath;
  await rm(root, { recursive: true, force: true });
});

/** Put a stub gh on PATH and let the engine layer notice it. */
function withGh(options?: Parameters<typeof installFakeGh>[0]): FakeGh {
  gh = installFakeGh(options);
  setGitEngine(null); // drops what gh reported before this one existed
  return gh;
}

test("normalizeGitEngine accepts cli and gh only", () => {
  expect(normalizeGitEngine("cli")).toBe("cli");
  expect(normalizeGitEngine("gh")).toBe("gh");
  expect(normalizeGitEngine("js")).toBeNull(); // the retired built-in engine
  expect(normalizeGitEngine("https")).toBeNull(); // older scheme values
  expect(normalizeGitEngine(undefined)).toBeNull();
});

// Scenario: the GitHub CLI is the default when it is installed.
test("the default engine follows what is installed; the setting overrides it", () => {
  expect(ghAvailable()).toBe(false); // the preloaded PATH hides the real gh
  expect(currentEngine()).toBe("cli");

  withGh();
  expect(ghAvailable()).toBe(true);
  expect(currentEngine()).toBe("gh");

  setGitEngine("cli");
  expect(currentEngine()).toBe("cli");
  setGitEngine(null);
  expect(currentEngine()).toBe("gh");
});

test("gh reports its sign-in state and account", async () => {
  const stub = withGh();
  expect(await ghSignedIn()).toBe(true);
  // The account's email is private, so the noreply address stands in.
  expect(await ghAccount()).toEqual(FAKE_GH_ACCOUNT);
  expect(stub.calls()).toContain("api user");
});

test("gh installed but signed out has no account", async () => {
  withGh({ signedIn: false });
  expect(ghAvailable()).toBe(true);
  expect(await ghSignedIn()).toBe(false);
  expect(await ghAccount()).toBeNull();
});

// Scenario: clone a GitHub repo through the GitHub CLI.
test("the gh engine clones GitHub repos with `gh repo clone`", async () => {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const seed = join(root, "seed");
  await $`git clone ${origin} ${seed}`.quiet().nothrow();
  await git(seed, "config", "user.email", "t@example.com");
  await git(seed, "config", "user.name", "T");
  await git(seed, "checkout", "-B", "main");
  await Bun.write(join(seed, "seed.feature.md"), "# Seed\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "seed");
  await git(seed, "push", "origin", "HEAD:main");

  const stub = withGh({ origin });
  const dir = join(root, "clone");
  await clone("https://github.com/octo/data-insurance", dir);
  expect(await Bun.file(join(dir, "seed.feature.md")).exists()).toBe(true);
  expect(stub.calls()).toContain("repo clone");
});

test("the gh engine leaves non-GitHub urls to plain git clone", async () => {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const stub = withGh({ origin });
  await clone(origin, join(root, "clone"));
  expect(stub.calls()).not.toContain("repo clone");
});

test("a clone gh cannot do surfaces as a clone failure", async () => {
  withGh(); // no origin: the stub reports "Repository not found"
  expect(clone("https://github.com/octo/nope", join(root, "x"))).rejects.toThrow(
    "Could not clone",
  );
});

// specs/git-operations.spec.md: the gh account authors the data-repo commits.
test("commits on the gh engine are authored by the gh account", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await Bun.write(join(repo, "one.feature.md"), "# One\n");

  withGh();
  const res = await commitAndPush(repo, "one.feature.md", "Add one");
  expect(res.pushed).toBe(false); // no upstream on a local-only repo
  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe(
    `${FAKE_GH_ACCOUNT.name} <${FAKE_GH_ACCOUNT.email}>`,
  );
});

// Signed out of gh there is nothing for it to contribute, so the repo's own
// git identity keeps authoring — the machine's setup is not overridden.
test("with gh signed out the repo's own git identity still authors commits", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await Bun.write(join(repo, "one.feature.md"), "# One\n");

  withGh({ signedIn: false });
  await commitAndPush(repo, "one.feature.md", "Add one");
  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe("Repo Config <repo@example.com>");
});

// Domain outcomes are the same answer on either engine.
test("a plain directory and a repo without an upstream skip the pull", async () => {
  expect((await pull(root)).message).toContain("not a standalone git repository");

  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  expect((await pull(repo)).message).toContain("no upstream");
});

test("choosing the GitHub CLI engine without gh installed is a clear error", async () => {
  expect(ghAvailable()).toBe(false);
  setGitEngine("gh");
  expect(pull(root)).rejects.toThrow(
    "GitHub CLI selected but no gh found — switch Git engine to System git in Settings",
  );
});

test("without any git binary every operation fails with one clear error", async () => {
  expect(cliGitAvailable()).toBe(true); // sanity: the preloaded PATH has git
  process.env.PATH = "/nonexistent";
  expect(cliGitAvailable()).toBe(false);
  expect(pull(root)).rejects.toThrow("No git found — install git to work with repositories");
});
