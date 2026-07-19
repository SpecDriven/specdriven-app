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
  STATE_FILE,
} from "../src/server/state";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// specs/app-start.spec.md: if .specdriven does not contain the name of the
// last data repo, the user must be asked for one.
test("missing .specdriven file means the user must be asked for a data repo", async () => {
  const state = await readState(dir);
  expect(needsDataRepo(state)).toBe(true);
});

test(".specdriven without a dataRepo means the user must be asked", async () => {
  await Bun.write(join(dir, STATE_FILE), "{}");
  expect(needsDataRepo(await readState(dir))).toBe(true);
});

test("corrupt .specdriven is treated as empty state", async () => {
  await Bun.write(join(dir, STATE_FILE), "not json");
  expect(needsDataRepo(await readState(dir))).toBe(true);
});

test("recorded data repo round-trips and suppresses the prompt", async () => {
  await writeState({ dataRepo: "data" }, dir);
  const state = await readState(dir);
  expect(state.dataRepo).toBe("data");
  expect(needsDataRepo(state)).toBe(false);
});

// specs/ui.spec.md: Settings (data reload frequency) are saved to .specdriven.
test("reload frequency round-trips through .specdriven", async () => {
  await writeState({ dataRepo: "data", reloadFrequencySeconds: 30 }, dir);
  const state = await readState(dir);
  expect(state.reloadFrequencySeconds).toBe(30);
});

// specs/git-operations.spec.md: the chosen git scheme is a setting in
// .specdriven; absent means auto-discover by probing.
test("git scheme round-trips through .specdriven", async () => {
  await writeState({ dataRepo: "data", gitScheme: "ssh" }, dir);
  expect((await readState(dir)).gitScheme).toBe("ssh");
  await writeState({ dataRepo: "data" }, dir);
  expect((await readState(dir)).gitScheme).toBeUndefined();
});

// specs/ui.spec.md "Scenario List": the number of Markdown lines rendered per
// scenario in the list is configurable in Settings and saved to .specdriven.
test("scenario preview lines round-trip through .specdriven", async () => {
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
