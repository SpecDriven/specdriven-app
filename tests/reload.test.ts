import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  DEFAULT_RELOAD_SECONDS,
  normalizeReloadSeconds,
  reloadData,
  createReloadScheduler,
} from "../src/server/reload";
import { setGitEngine } from "../src/server/git";
import type { GitEngine } from "../src/server/git";
import { writeState } from "../src/server/state";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { git, stopServers } from "./helpers/fixtures";
import { serveRepos } from "./helpers/gitHttpServer";

let dir: string;
let home: string;
let fakeGh: FakeGh | null = null;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-reload-"));
  // Point the ~/.specdriven fallback (specs/app-start.spec.md) at an empty
  // temp dir, so a developer's own settings file can't configure these tests.
  home = await mkdtemp(join(tmpdir(), "specdriven-reload-home-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  stopServers();
  fakeGh?.restore();
  fakeGh = null;
  setGitEngine(null);
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

// specs/crud-feature.spec.md: reload frequency is "every n seconds", set in
// the Settings screen; unset or invalid values fall back to the default.
test("unset or invalid frequency falls back to the default", () => {
  expect(normalizeReloadSeconds(undefined)).toBe(DEFAULT_RELOAD_SECONDS);
  expect(normalizeReloadSeconds("30")).toBe(DEFAULT_RELOAD_SECONDS);
  expect(normalizeReloadSeconds(-5)).toBe(DEFAULT_RELOAD_SECONDS);
  expect(normalizeReloadSeconds(Number.NaN)).toBe(DEFAULT_RELOAD_SECONDS);
});

test("valid frequencies are floored; 0 (disabled) is preserved", () => {
  expect(normalizeReloadSeconds(30)).toBe(30);
  expect(normalizeReloadSeconds(2.9)).toBe(2);
  expect(normalizeReloadSeconds(0)).toBe(0);
});

test("reload without a configured data repo is skipped", async () => {
  expect(await reloadData(dir)).toContain("skipped");
});

test("reload of a non-git data dir skips the pull instead of failing", async () => {
  await writeState({ dataRepo: "data" }, dir);
  expect(await reloadData(dir)).toContain("skipped pull");
});

test("scheduler runs the task repeatedly at the given frequency", async () => {
  let runs = 0;
  const scheduler = createReloadScheduler(() => {
    runs++;
  });
  scheduler.set(0.01); // 10ms — fractional seconds keep the test fast
  expect(scheduler.seconds).toBe(0.01);
  await Bun.sleep(35);
  scheduler.stop();
  expect(runs).toBeGreaterThanOrEqual(2);
});

test("setting the scheduler to 0 stops it", async () => {
  let runs = 0;
  const scheduler = createReloadScheduler(() => {
    runs++;
  });
  scheduler.set(0.01);
  scheduler.set(0);
  expect(scheduler.seconds).toBe(0);
  await Bun.sleep(30);
  expect(runs).toBe(0);
});

// The reload tick (pull + commit/push) runs on all three git engines
// (specs/git-operations.spec.md), against a smart-HTTP-served origin.
for (const engine of ["cli", "gh", "js"] as GitEngine[]) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // crud-feature.spec.md "Scenario is automatically saved locally and pushed to
    // GitHub": on the reload tick, after the git pull, saved scenarios are
    // committed and pushed.
    test("reload commits and pushes locally saved scenarios after the pull", async () => {
      const origin = join(dir, "origin.git");
      await $`git init --bare -b main ${origin}`.quiet();
      const server = serveRepos(dir);
      const data = join(dir, "data");
      await $`git clone ${server.url}/origin.git ${data}`.quiet().nothrow();
      await git(data, "config", "user.email", "test@example.com");
      await git(data, "config", "user.name", "Test");
      await git(data, "checkout", "-B", "main");
      await Bun.write(join(data, "seed.feature.md"), "# Seed\n");
      await git(data, "add", ".");
      await git(data, "commit", "-m", "seed");
      await git(data, "push", "origin", "HEAD:main");
      await git(data, "branch", "--set-upstream-to=origin/main");
      await writeState({ dataRepo: "data" }, dir);

      // an auto-saved (uncommitted) scenario is waiting in the working tree
      await Bun.write(
        join(data, "seed.feature.md"),
        "# Seed\n\n## One v1 [proposed]\n\nbody\n",
      );

      try {
        const message = await reloadData(dir);
        expect(message).toContain("saved scenarios committed and pushed");
        const status = await $`git -C ${data} status --porcelain`.quiet();
        expect(status.stdout.toString().trim()).toBe("");
        const originLog = await $`git -C ${origin} log --oneline -1`.quiet();
        expect(originLog.stdout.toString()).toContain("Auto-save scenarios");
      } finally {
        server.stop();
      }
    });

    test("reload with a clean tree has nothing to sync", async () => {
      const data = join(dir, "data");
      await $`git init -b main ${data}`.quiet();
      await git(data, "config", "user.email", "test@example.com");
      await git(data, "config", "user.name", "Test");
      await writeState({ dataRepo: "data" }, dir);
      expect(await reloadData(dir)).toContain("no saved changes");
    });
  });
}
