// Automates specs/editor-autosave.feature.md: the editor saves itself at an
// interval, and that interval is a setting — at least 3 seconds, 6 by default.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { namingInProgress, scenarioSignature } from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";
import {
  DEFAULT_AUTOSAVE_SECONDS,
  MIN_AUTOSAVE_SECONDS,
  normalizeAutosaveSeconds,
  readState,
  statePath,
  writeState,
} from "../src/server/state";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-autosave-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-autosave-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function putState(body: unknown): Promise<Response> {
  return (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
}

test("the autosave interval defaults to 6 seconds and never goes below 3", () => {
  expect(DEFAULT_AUTOSAVE_SECONDS).toBe(6);
  expect(MIN_AUTOSAVE_SECONDS).toBe(3);
  expect(normalizeAutosaveSeconds(undefined)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds("nope")).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(0)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(2)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(3)).toBe(3);
  expect(normalizeAutosaveSeconds(9.7)).toBe(9);
});

test("the autosave interval round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", autosaveIntervalSeconds: 30 }, root);
  expect((await readState(root)).autosaveIntervalSeconds).toBe(30);
});

test("an unset autosave interval is reported as the 6 second default", async () => {
  const res = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(res.status).toBe(200);
  expect(((await res.json()) as { autosaveIntervalSeconds: number }).autosaveIntervalSeconds).toBe(
    DEFAULT_AUTOSAVE_SECONDS,
  );
});

test("Settings saves the autosave interval to the settings file", async () => {
  const res = await putState({ autosaveIntervalSeconds: 12 });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { autosaveIntervalSeconds: number }).autosaveIntervalSeconds).toBe(
    12,
  );
  expect((await Bun.file(statePath(root)).json()).autosaveIntervalSeconds).toBe(12);
});

test("an interval below the 3 second minimum is refused, and changes nothing", async () => {
  await putState({ autosaveIntervalSeconds: 8 });
  const res = await putState({ autosaveIntervalSeconds: 2 });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("3");
  expect((await readState(root)).autosaveIntervalSeconds).toBe(8);
});

test("the minimum itself is accepted", async () => {
  const res = await putState({ autosaveIntervalSeconds: MIN_AUTOSAVE_SECONDS });
  expect(res.status).toBe(200);
  expect((await readState(root)).autosaveIntervalSeconds).toBe(MIN_AUTOSAVE_SECONDS);
});

// A tick only saves when the editor holds something new, so a dialog that is
// opened and read — or one already saved — costs no commit.
test("only changed editor contents make an autosave tick save", () => {
  const s: Scenario = {
    name: "Quote a policy",
    version: 2,
    status: "proposed",
    body: "Given a driver\n",
    tests: ["https://github.com/acme/repo/blob/main/QuoteTest.java"],
  };
  const sig = scenarioSignature(s, 2);
  expect(scenarioSignature({ ...s }, 2)).toBe(sig);
  expect(scenarioSignature({ ...s, body: "Given a driver\nWhen…" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, name: "Quote a claim" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, status: "draft" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, tests: [] }, 2)).not.toBe(sig);
  // The version the dialog will save under, not the one on the object: a new
  // scenario renamed onto an existing name saves under a new version.
  expect(scenarioSignature(s, 3)).not.toBe(sig);
});

test("the autosave interval is independent of the autosync frequency", async () => {
  // Autosync off (0) must not switch autosave off — it has no off switch.
  await putState({ reloadFrequencySeconds: 0, autosaveIntervalSeconds: 5 });
  const state = await readState(root);
  expect(state.reloadFrequencySeconds).toBe(0);
  expect(normalizeAutosaveSeconds(state.autosaveIntervalSeconds)).toBe(5);
});

// While the caret is in the dialog's title field the name is only half typed,
// so no tick saves it — the tick after focus moves on saves it whole.
test("no autosave tick runs while the scenario name is being typed", () => {
  const nameField = { id: "name" } as unknown as Element;
  const body = { id: "body" } as unknown as Element;
  expect(namingInProgress(nameField, nameField)).toBe(true);
  expect(namingInProgress(nameField, body)).toBe(false);
  expect(namingInProgress(nameField, null)).toBe(false);
  // A published scenario has no editable title: nothing holds its ticks back.
  expect(namingInProgress(null, body)).toBe(false);
  expect(namingInProgress(null, null)).toBe(false);
});
