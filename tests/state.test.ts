import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  needsDataRepo,
  normalizeScenarioPreviewLines,
  DEFAULT_SCENARIO_PREVIEW_LINES,
  LEGACY_STATE_FILE,
  statePath,
  homeStatePath,
} from "../src/server/state";

let dir: string;
let home: string;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-state-"));
  // Point the home fallback at an empty temp dir, so these tests never read
  // or write the developer's own ~/.specdriven/settings.json.
  home = await mkdtemp(join(tmpdir(), "specdriven-home-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

// specs/app-start.spec.md: if the settings file does not contain the name of the
// last data repo, the user must be asked for one.
test("missing settings file means the user must be asked for a data repo", async () => {
  const state = await readState(dir);
  expect(needsDataRepo(state)).toBe(true);
});

test("a settings file without a dataRepo means the user must be asked", async () => {
  await Bun.write(statePath(dir), "{}");
  expect(needsDataRepo(await readState(dir))).toBe(true);
});

test("a corrupt settings file is treated as empty state", async () => {
  await Bun.write(statePath(dir), "not json");
  expect(needsDataRepo(await readState(dir))).toBe(true);
});

// specs/app-start.spec.md "Settings file": ./.specdriven/settings.json first,
// then ~/.specdriven/settings.json.
test("the home settings file is used when the project has none", async () => {
  await Bun.write(homeStatePath(), JSON.stringify({ dataRepo: "from-home" }));
  const state = await readState(dir);
  expect(state.dataRepo).toBe("from-home");
  expect(needsDataRepo(state)).toBe(false);
});

test("the project settings file wins over the home settings file", async () => {
  await Bun.write(homeStatePath(), JSON.stringify({ dataRepo: "from-home" }));
  await Bun.write(statePath(dir), JSON.stringify({ dataRepo: "from-project" }));
  expect((await readState(dir)).dataRepo).toBe("from-project");
});

// specs/app-start.spec.md: saves go back to whichever settings file was read.
test("settings are saved back to the home settings file when only it exists", async () => {
  await Bun.write(homeStatePath(), JSON.stringify({ dataRepo: "from-home" }));
  await writeState({ dataRepo: "from-home", scenarioPreviewLines: 3 }, dir);
  expect((await Bun.file(homeStatePath()).json()).scenarioPreviewLines).toBe(3);
  expect(await Bun.file(statePath(dir)).exists()).toBe(false);
});

test("a project settings file keeps saves local and leaves the home settings file alone", async () => {
  await Bun.write(homeStatePath(), JSON.stringify({ dataRepo: "from-home" }));
  await Bun.write(statePath(dir), JSON.stringify({ dataRepo: "from-project" }));
  await writeState({ dataRepo: "from-project", scenarioPreviewLines: 3 }, dir);
  expect((await Bun.file(statePath(dir)).json()).scenarioPreviewLines).toBe(3);
  expect((await Bun.file(homeStatePath()).json()).scenarioPreviewLines).toBeUndefined();
});

// specs/app-start.spec.md: the pre-settings.json layout still reads, and the
// next save migrates it.
test("a legacy .specdriven file is read and migrated on the next save", async () => {
  const legacy = join(dir, LEGACY_STATE_FILE);
  await Bun.write(legacy, JSON.stringify({ dataRepo: "legacy" }));
  expect((await readState(dir)).dataRepo).toBe("legacy");

  await writeState({ dataRepo: "legacy", scenarioPreviewLines: 5 }, dir);
  expect(await Bun.file(legacy).exists()).toBe(false);
  expect((await Bun.file(statePath(dir)).json()).scenarioPreviewLines).toBe(5);
  expect((await readState(dir)).dataRepo).toBe("legacy");
});

test("recorded data repo round-trips and suppresses the prompt", async () => {
  await writeState({ dataRepo: "data" }, dir);
  const state = await readState(dir);
  expect(state.dataRepo).toBe("data");
  expect(needsDataRepo(state)).toBe(false);
});

// specs/ui.spec.md: Settings (data reload frequency) are saved to the settings file.
test("reload frequency round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", reloadFrequencySeconds: 30 }, dir);
  const state = await readState(dir);
  expect(state.reloadFrequencySeconds).toBe(30);
});

// specs/git-operations.spec.md: the chosen git engine is a setting in the
// settings file; absent means the default (gh wherever it is installed).
test("git engine round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", gitEngine: "cli" }, dir);
  expect((await readState(dir)).gitEngine).toBe("cli");
  await writeState({ dataRepo: "data", gitEngine: "gh" }, dir);
  expect((await readState(dir)).gitEngine).toBe("gh");
  await writeState({ dataRepo: "data" }, dir);
  expect((await readState(dir)).gitEngine).toBeUndefined();
});

// specs/ui.spec.md "Scenario List": the number of Markdown lines rendered per
// scenario in the list is configurable in Settings and saved to the settings file.
test("scenario preview lines round-trip through the settings file", async () => {
  await writeState({ dataRepo: "data", scenarioPreviewLines: 4 }, dir);
  const state = await readState(dir);
  expect(state.scenarioPreviewLines).toBe(4);
});

test("scenario preview lines default to 8 and are at least 1", () => {
  expect(normalizeScenarioPreviewLines(undefined)).toBe(DEFAULT_SCENARIO_PREVIEW_LINES);
  expect(normalizeScenarioPreviewLines("nope")).toBe(DEFAULT_SCENARIO_PREVIEW_LINES);
  expect(normalizeScenarioPreviewLines(0)).toBe(DEFAULT_SCENARIO_PREVIEW_LINES);
  expect(normalizeScenarioPreviewLines(-3)).toBe(DEFAULT_SCENARIO_PREVIEW_LINES);
  expect(normalizeScenarioPreviewLines(4.9)).toBe(4);
  expect(normalizeScenarioPreviewLines(1)).toBe(1);
});
