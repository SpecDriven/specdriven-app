import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, needsDataRepo, STATE_FILE } from "../src/server/state";

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
