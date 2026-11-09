// Automates specs/ui/app-start.feature.md "Settings file": the settings file
// carries the version of its format, and a new version of the app upgrades
// an older file — once, at start, keeping the file as it was beside it —
// while a file a newer app wrote is read as it is and never lowered.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { settingsBackupPath, upgradeSettingsFile } from "../src/server/settingsUpgrade";
import {
  readState,
  SETTINGS_UPGRADES,
  SETTINGS_VERSION,
  settingsVersionOf,
  upgradeSettings,
} from "../src/server/state";
import { stopServers } from "./helpers/fixtures";

let root: string;
let home: string;
let file: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

/** A settings file from before versions: the two folder lists and their open times. */
const VERSION_0 = {
  dataRepo: "/specs/b",
  recentDataRepos: ["/specs/a", "/specs/b"],
  recentCodeRepos: ["/code/a"],
  recentFolderOpenedAt: { spec: { "/specs/b": 2 }, code: { "/code/a": 1 } },
  reloadFrequencySeconds: 0,
  ghostty: true,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-settings-version-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-settings-version-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  file = join(root, ".specdriven", "settings.json");
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  stopServers();
  setGitEngine(null);
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

const writeRaw = (value: unknown) =>
  Bun.write(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
const readRaw = () => Bun.file(file).text();

test("there is one upgrade step per version, from 1 up to this app's", () => {
  expect(SETTINGS_UPGRADES.map((s) => s.version)).toEqual(
    Array.from({ length: SETTINGS_VERSION }, (_, i) => i + 1),
  );
  for (const step of SETTINGS_UPGRADES) expect(step.summary.trim()).not.toBe("");
});

test("a file without a version, or with a malformed one, is version 0", () => {
  expect(settingsVersionOf({})).toBe(0);
  for (const v of ["1", -1, 1.5, null, Number.NaN]) expect(settingsVersionOf({ settingsVersion: v })).toBe(0);
  expect(settingsVersionOf({ settingsVersion: 3 })).toBe(3);
});

test("an older file has the steps it has not had and is stamped with this app's version", () => {
  const state: Record<string, unknown> = structuredClone(VERSION_0);
  const result = upgradeSettings(state);
  expect(result).toEqual({
    from: 0,
    to: SETTINGS_VERSION,
    tooNew: false,
    steps: SETTINGS_UPGRADES.map((s) => s.summary),
  });
  expect(state).toEqual({
    settingsVersion: SETTINGS_VERSION,
    dataRepo: "/specs/b",
    recentFolders: [
      { path: "/specs/b", kind: "spec" },
      { path: "/code/a", kind: "code" },
      { path: "/specs/a", kind: "spec" },
    ],
    reloadFrequencySeconds: 0,
    ghostty: true,
  });
  // A current file has nothing to do.
  const again = upgradeSettings(state);
  expect(again.steps).toEqual([]);
  expect(again.from).toBe(SETTINGS_VERSION);
});

test("a file a newer app wrote is left as it is, its version not lowered", () => {
  const newer = { settingsVersion: SETTINGS_VERSION + 1, recentDataRepos: ["/kept"], someNewKey: { x: 1 } };
  const state: Record<string, unknown> = structuredClone(newer);
  expect(upgradeSettings(state)).toEqual({
    from: SETTINGS_VERSION + 1,
    to: SETTINGS_VERSION + 1,
    tooNew: true,
    steps: [],
  });
  expect(state).toEqual(newer);
});

test("readState reads an older file in this app's format, without touching the file", async () => {
  await writeRaw(VERSION_0);
  const before = await readRaw();
  const state = await readState(root);
  expect(state.settingsVersion).toBe(SETTINGS_VERSION);
  expect(state.recentFolders?.[0]).toEqual({ path: "/specs/b", kind: "spec" });
  expect(Object.keys(state)).not.toContain("recentDataRepos");
  expect(await readRaw()).toBe(before);
});

test("upgrading the file saves it in this app's format and keeps the old one beside it", async () => {
  await writeRaw(VERSION_0);
  const before = await readRaw();
  const result = await upgradeSettingsFile(root);
  const backup = settingsBackupPath(file, 0);
  expect(result).toMatchObject({ from: 0, to: SETTINGS_VERSION, tooNew: false, path: file, backup });
  expect(await Bun.file(backup).text()).toBe(before);
  const saved = JSON.parse(await readRaw());
  expect(saved.settingsVersion).toBe(SETTINGS_VERSION);
  expect(saved.recentFolders).toHaveLength(3);
  expect(saved.ghostty).toBe(true);
  for (const key of ["recentDataRepos", "recentCodeRepos", "recentFolderOpenedAt"]) {
    expect(Object.keys(saved)).not.toContain(key);
  }
  // Once is enough: a second start changes nothing and makes no new copy.
  const after = await readRaw();
  expect((await upgradeSettingsFile(root))?.backup).toBeNull();
  expect(await readRaw()).toBe(after);
  expect((await readdir(join(root, ".specdriven"))).sort()).toEqual(["settings.json", "settings.json.v0.bak"]);
});

test("a backup already there is kept, as it holds the oldest file", async () => {
  await writeRaw(VERSION_0);
  await Bun.write(settingsBackupPath(file, 0), "the first one\n");
  await upgradeSettingsFile(root);
  expect(await Bun.file(settingsBackupPath(file, 0)).text()).toBe("the first one\n");
  expect(JSON.parse(await readRaw()).settingsVersion).toBe(SETTINGS_VERSION);
});

test("a newer app's file, an unreadable file and no file are left alone", async () => {
  expect(await upgradeSettingsFile(root)).toBeNull();
  await writeRaw({ settingsVersion: SETTINGS_VERSION + 1, recentDataRepos: ["/kept"] });
  const newer = await readRaw();
  expect(await upgradeSettingsFile(root)).toMatchObject({ tooNew: true, backup: null });
  expect(await readRaw()).toBe(newer);
  await writeRaw("{ not json");
  expect(await upgradeSettingsFile(root)).toBeNull();
  expect(await readRaw()).toBe("{ not json");
  expect(await readdir(join(root, ".specdriven"))).toEqual(["settings.json"]);
});

test("starting the app upgrades an older settings file", async () => {
  await writeRaw(VERSION_0);
  await applyStartupState();
  const saved = JSON.parse(await readRaw());
  expect(saved.settingsVersion).toBe(SETTINGS_VERSION);
  expect(saved.recentFolders).toBeDefined();
  expect(await Bun.file(settingsBackupPath(file, 0)).exists()).toBe(true);
});
