import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  needsDataRepo,
  normalizeCodeGen,
  normalizeCodeGenTarget,
  normalizeGoogleCalendar,
  normalizeScenarioPreviewLines,
  settingsDirectory,
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

// Code gen switch (specs/agents/claude.spec.md): on unless switched off, so
// the default is an absent key and only `false` turns it off.
test("code generation is on unless explicitly switched off", () => {
  expect(normalizeCodeGen(undefined)).toBe(true);
  expect(normalizeCodeGen(true)).toBe(true);
  expect(normalizeCodeGen("nope")).toBe(true);
  expect(normalizeCodeGen(false)).toBe(false);
});

test("the code gen switch round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", codeGen: false }, dir);
  expect(normalizeCodeGen((await readState(dir)).codeGen)).toBe(false);
});

// Where "Start session" runs (specs/agents/claude.feature.md): the last
// "Run in" choice; absent or unusable means "not chosen", and the client
// falls back on whether Claude.app is installed.
test("the session target is only ever desktop or cli", () => {
  expect(normalizeCodeGenTarget("desktop")).toBe("desktop");
  expect(normalizeCodeGenTarget("pane")).toBe("pane");
  expect(normalizeCodeGenTarget("pi")).toBe("pi");
  expect(normalizeCodeGenTarget("codex")).toBe("codex");
  expect(normalizeCodeGenTarget(undefined)).toBeNull();
  expect(normalizeCodeGenTarget("terminal")).toBeNull();
  // The headless `claude -p` target is gone; a settings file that still
  // names it reads as "not chosen".
  expect(normalizeCodeGenTarget("cli")).toBeNull();
});

test("the session target round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", codeGenTarget: "desktop" }, dir);
  expect(normalizeCodeGenTarget((await readState(dir)).codeGenTarget)).toBe("desktop");
});

// Session records live beside the settings file (src/server/agent.ts), so
// they follow the same local-then-home rule as a settings save.
test("the settings directory is the project's, unless only the home file exists", async () => {
  expect(await settingsDirectory(dir)).toBe(join(dir, ".specdriven"));
  await Bun.write(homeStatePath(), JSON.stringify({ dataRepo: "from-home" }));
  expect(await settingsDirectory(dir)).toBe(home);
  await Bun.write(statePath(dir), JSON.stringify({ dataRepo: "from-project" }));
  expect(await settingsDirectory(dir)).toBe(join(dir, ".specdriven"));
});

// The Google Calendar switch (specs/app/tasks.feature.md "Add task to Google
// Calendar"): opt-in like the tasks folder, so a settings file that never
// mentions it means off.
test("the Google Calendar setting is off unless explicitly turned on", () => {
  expect(normalizeGoogleCalendar(undefined)).toBe(false);
  expect(normalizeGoogleCalendar("true")).toBe(false);
  expect(normalizeGoogleCalendar(false)).toBe(false);
  expect(normalizeGoogleCalendar(true)).toBe(true);
});
