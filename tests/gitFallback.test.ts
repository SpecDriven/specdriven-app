// Git engine selection and fallback (specs/git-operations.spec.md): the
// built-in engine is the default; operations it cannot handle fall back to
// system git and pin the repo there for the rest of the run; forcing the
// cli engine without a git binary is a clear error, not a hang.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  cliGitAvailable,
  currentEngine,
  engineFor,
  normalizeGitEngine,
  pull,
  setGitEngine,
  syncSavedChanges,
} from "../src/server/git";
import { git } from "./helpers/fixtures";

let root: string;
const realPath = process.env.PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-fallback-"));
});

afterEach(async () => {
  setGitEngine(null);
  process.env.PATH = realPath;
  await rm(root, { recursive: true, force: true });
});

test("normalizeGitEngine accepts js and cli only", () => {
  expect(normalizeGitEngine("js")).toBe("js");
  expect(normalizeGitEngine("cli")).toBe("cli");
  expect(normalizeGitEngine("https")).toBeNull(); // old scheme values
  expect(normalizeGitEngine(undefined)).toBeNull();
});

test("the default engine is the built-in one; the setting overrides it", () => {
  expect(currentEngine()).toBe("js");
  setGitEngine("cli");
  expect(currentEngine()).toBe("cli");
  setGitEngine(null);
  expect(currentEngine()).toBe("js");
});

// Domain outcomes are results, not fallback triggers: a plain directory or
// a repo with no upstream answers the same on any engine, staying on js.
test("domain outcomes do not fall back or pin", async () => {
  expect((await pull(root)).message).toContain("not a standalone git repository");
  expect(engineFor(root)).toBe("js");

  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  expect((await pull(repo)).message).toContain("no upstream");
  expect(engineFor(repo)).toBe("js");
});

// A local-path remote is a transport the built-in engine does not speak —
// the operation reruns on system git and the repo is pinned there.
test("unsupported operations fall back to system git and pin the repo", async () => {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const clone = join(root, "clone");
  await $`git clone ${origin} ${clone}`.quiet().nothrow();
  await git(clone, "config", "user.email", "t@example.com");
  await git(clone, "config", "user.name", "T");
  await git(clone, "checkout", "-B", "main");
  await Bun.write(join(clone, "seed.feature.md"), "# Seed\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-m", "seed");
  await git(clone, "push", "origin", "HEAD:main");
  await git(clone, "branch", "--set-upstream-to=origin/main");

  expect(engineFor(clone)).toBe("js");
  const result = await pull(clone);
  expect(result.ok).toBe(true);
  expect(result.message).toContain("(used system git)");
  expect(engineFor(clone)).toBe("cli");

  // pinned: the next operation goes straight to system git and works
  await Bun.write(join(clone, "seed.feature.md"), "# Seed\nedited\n");
  const sync = await syncSavedChanges(clone);
  expect(sync.pushed).toBe(true);
});

// Changing the engine setting clears the per-repo pins.
test("setGitEngine resets fallback pins", async () => {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const clone = join(root, "clone");
  await $`git clone ${origin} ${clone}`.quiet().nothrow();
  await git(clone, "config", "user.email", "t@example.com");
  await git(clone, "config", "user.name", "T");
  await git(clone, "checkout", "-B", "main");
  await Bun.write(join(clone, "a.md"), "a\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-m", "seed");
  await git(clone, "push", "origin", "HEAD:main");
  await git(clone, "branch", "--set-upstream-to=origin/main");

  await pull(clone);
  expect(engineFor(clone)).toBe("cli");
  setGitEngine(null);
  expect(engineFor(clone)).toBe("js");
});

test("forcing the cli engine without git installed is a clear error", async () => {
  expect(cliGitAvailable()).toBe(true); // sanity: dev machines have git
  setGitEngine("cli");
  process.env.PATH = "/nonexistent";
  expect(cliGitAvailable()).toBe(false);
  expect(pull(join(root))).rejects.toThrow(
    "System git selected but no git found — switch Git engine to Built-in in Settings",
  );
});
