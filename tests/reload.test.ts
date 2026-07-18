import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELOAD_SECONDS,
  normalizeReloadSeconds,
  reloadData,
  createReloadScheduler,
} from "../src/server/reload";
import { writeState } from "../src/server/state";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-reload-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
