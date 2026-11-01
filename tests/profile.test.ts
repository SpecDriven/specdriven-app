// `--profile <dir>` (docs/running.md "Settings"): a settings folder of its own for a
// dev run, filled in through the variables every location already reads.

import { test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfile, profileArg } from "../src/server/profile";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

test("profileArg reads --profile <dir> and --profile=<dir>", () => {
  expect(profileArg(["bun", "src/index.ts", "--profile", "/tmp/a"])).toBe("/tmp/a");
  expect(profileArg(["bun", "src/index.ts", "--profile=/tmp/b"])).toBe("/tmp/b");
  expect(profileArg(["bun", "src/index.ts"])).toBeNull();
  expect(profileArg(["bun", "src/index.ts", "--profile"])).toBeNull();
});

test("--profile points settings, home and clones into the folder and makes them", async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-profile-"));
  const target = join(dir, "try");
  const env: Record<string, string | undefined> = {};
  expect(applyProfile(["bun", "x", "--profile", target], env)).toBe(target);
  expect(env).toEqual({
    SPECDRIVEN_ROOT: target,
    SPECDRIVEN_HOME: join(target, "home"),
    SPECDRIVEN_REPOS_DIR: join(target, "repos"),
  });
  expect(existsSync(join(target, "home")) && existsSync(join(target, "repos"))).toBe(true);
});

test("a variable set explicitly wins over --profile; no flag changes nothing", async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-profile-"));
  const env: Record<string, string | undefined> = { SPECDRIVEN_HOME: join(dir, "mine") };
  applyProfile(["bun", "x", `--profile=${join(dir, "p")}`], env);
  expect(env.SPECDRIVEN_HOME).toBe(join(dir, "mine"));
  expect(env.SPECDRIVEN_ROOT).toBe(join(dir, "p"));

  const untouched: Record<string, string | undefined> = {};
  expect(applyProfile(["bun", "x"], untouched)).toBeNull();
  expect(untouched).toEqual({});
});
