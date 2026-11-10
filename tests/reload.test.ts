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
  pullProblem,
  syncDataDir,
} from "../src/server/reload";
import { setGitEngine } from "../src/server/git";
import { writeState } from "../src/server/state";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { gitEngines } from "./helpers/engines";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let dir: string;
let home: string;
let fakeGh: FakeGh | null = null;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-reload-"));
  // Point the ~/.specdriven fallback (specs/ui/app-start.feature.md) at an
  // empty temp dir, so a developer's own settings file can't configure these
  // tests.
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

// crud-feature.md: reload frequency is "every n seconds", set in
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

// The reload tick (pull + commit/push) runs against a local-path origin on
// the system-git engine, and on all three under SPECDRIVEN_ALL_ENGINES=1
// (helpers/engines.ts).
for (const engine of gitEngines()) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    // crud-feature.spec.md "Scenario is automatically saved locally and pushed to
    // GitHub": on the reload tick, after the git pull, saved scenarios are
    // committed and pushed.
    test("reload commits and pushes locally saved scenarios after the pull", async () => {
      const { a: data, originDir } = await twoClones(dir);
      await writeState({ dataRepo: "a" }, dir);

      // an auto-saved (uncommitted) scenario is waiting in the working tree
      await Bun.write(
        join(data, "specs/seed.feature.md"),
        "# Seed\n\n## One @v1 [proposed]\n\nbody\n",
      );

      const message = await reloadData(dir);
      expect(message).toContain("saved scenarios committed and pushed");
      const status = await $`git -C ${data} status --porcelain`.quiet();
      expect(status.stdout.toString().trim()).toBe("");
      const originLog = await $`git -C ${originDir} log --oneline -1`.quiet();
      expect(originLog.stdout.toString()).toContain("Add scenario to Seed: One");
    });

    // specs/ui/ui.feature.md "Auto-save commits say what changed": the title
    // names the feature and the scenario; the body says what happened and
    // ends with the auto-save trailer.
    test("the auto-save commit names the feature and the scenarios that changed", async () => {
      const { a: data, originDir } = await twoClones(dir);
      await writeState({ dataRepo: "a" }, dir);
      const file = join(data, "specs/seed.feature.md");
      await Bun.write(file, "# Seed\n\n## One @v1 [proposed]\n\nbody\n\n## Two @v1 [proposed]\n\nbody\n");
      await git(data, "add", "-A");
      await git(data, "commit", "-m", "seed");

      await Bun.write(file, "# Seed\n\n## One @v1 [proposed]\n\nchanged\n\n## Three @v1 [proposed]\n\nnew\n");
      await reloadData(dir);
      const log = await $`git -C ${originDir} log --format=%s%n%b -1`.quiet();
      const lines = log.stdout.toString().trim().split("\n");
      expect(lines[0]).toBe("Edit Seed: One, Three, Two");
      expect(lines).toContain('- Edit feature: Seed (edit "One"; add "Three"; remove "Two")');
      expect(lines.at(-1)).toBe("Auto-saved by SpecDriven");
    });

    test("reload with a clean tree has nothing to sync", async () => {
      const data = join(dir, "data");
      await $`git init -b main ${data}`.quiet();
      await git(data, "config", "user.email", "test@example.com");
      await git(data, "config", "user.name", "Test");
      await writeState({ dataRepo: "data" }, dir);
      // The first tick stamps the folder's data format marker
      // (specs/app/data-format.feature.md) and commits it; after that a
      // clean tree has nothing to sync.
      const first = await reloadData(dir);
      expect(first).toContain("wrote the data format marker");
      expect(first).toContain("saved scenarios committed");
      expect(await reloadData(dir)).toContain("no saved changes");
    });
  });
}

// specs/ui/navigation.feature.md "a link opens on synced data": a link
// followed behind a failed pull words its miss by the pull, so the tick
// keeps why the last one failed — and forgets it once a pull goes through.
test("a pull that cannot reach the remote is kept as the folder's pull problem", async () => {
  setGitEngine("cli");
  const { a, originDir } = await twoClones(dir);
  expect(pullProblem(a)).toBeNull();
  await syncDataDir(a);
  expect(pullProblem(a)).toBeNull();

  const gone = `${originDir}.gone`;
  await $`mv ${originDir} ${gone}`.quiet();
  await syncDataDir(a);
  expect(pullProblem(a)).toBeTruthy();

  await $`mv ${gone} ${originDir}`.quiet();
  await syncDataDir(a);
  expect(pullProblem(a)).toBeNull();
});
