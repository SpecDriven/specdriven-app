import { test, expect, beforeEach, afterEach } from "bun:test";
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
import { writeState } from "../src/server/state";

let dir: string;
let home: string;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-reload-"));
  // Point the ~/.specdriven fallback (specs/app-start.spec.md) at an empty
  // temp dir, so a developer's own settings file can't configure these tests.
  home = await mkdtemp(join(tmpdir(), "specdriven-reload-home-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
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

// crud-feature.spec.md "Scenario is automatically saved locally and pushed to
// GitHub": on the reload tick, after the git pull, saved scenarios are
// committed and pushed.
test("reload commits and pushes locally saved scenarios after the pull", async () => {
  const origin = join(dir, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const data = join(dir, "data");
  await $`git clone ${origin} ${data}`.quiet().nothrow();
  await $`git -C ${data} config user.email test@example.com`.quiet();
  await $`git -C ${data} config user.name Test`.quiet();
  await $`git -C ${data} checkout -B main`.quiet();
  await Bun.write(join(data, "seed.feature.md"), "# Seed\n");
  await $`git -C ${data} add .`.quiet();
  await $`git -C ${data} commit -m seed`.quiet();
  await $`git -C ${data} push origin HEAD:main`.quiet();
  await $`git -C ${data} branch --set-upstream-to=origin/main`.quiet();
  await writeState({ dataRepo: "data" }, dir);

  // an auto-saved (uncommitted) scenario is waiting in the working tree
  await Bun.write(
    join(data, "seed.feature.md"),
    "# Seed\n\n## One v1 [proposed]\n\nbody\n",
  );

  const message = await reloadData(dir);
  expect(message).toContain("saved scenarios committed and pushed");
  const status = await $`git -C ${data} status --porcelain`.quiet();
  expect(status.stdout.toString().trim()).toBe("");
  const originLog = await $`git -C ${origin} log --oneline -1`.quiet();
  expect(originLog.stdout.toString()).toContain("Auto-save scenarios");
});

test("reload with a clean tree has nothing to sync", async () => {
  const data = join(dir, "data");
  await $`git init -b main ${data}`.quiet();
  await $`git -C ${data} config user.email test@example.com`.quiet();
  await $`git -C ${data} config user.name Test`.quiet();
  await writeState({ dataRepo: "data" }, dir);
  expect(await reloadData(dir)).toContain("no saved changes");
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
