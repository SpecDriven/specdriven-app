// Automates specs/ui/app-start.feature.md "Settings file": the settings file
// is YAML, settings.yaml, and a settings.json an older version of the app
// left is converted — once, when the app starts, or on the first save —
// with the JSON file kept beside it as settings.json.bak, so an existing
// installation keeps its settings.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { isYamlPath, parseSettingsText } from "../src/server/settingsFormat";
import { convertSettingsFile, upgradeSettingsFile } from "../src/server/settingsUpgrade";
import {
  HOME_SETTINGS_ENV,
  homeStatePath,
  jsonBackupPath,
  jsonStatePath,
  LEGACY_JSON_STATE_FILE,
  readSettingsFileView,
  readState,
  SETTINGS_VERSION,
  settingsDirectory,
  settingsFile,
  STATE_FILE,
  statePath,
  writeState,
} from "../src/server/state";
import { stopServers } from "./helpers/fixtures";
import { readSettings, writeSettings } from "./helpers/settingsFile";

let root: string;
let home: string;
/** The project's settings.yaml, and the settings.json from before it. */
let yaml: string;
let json: string;
const realEnv = Object.fromEntries(
  ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", HOME_SETTINGS_ENV].map((name) => [name, process.env[name]]),
);

/** A settings file as an older app left it: JSON, and from before versions. */
const OLD = {
  dataRepo: "/specs/b",
  recentDataRepos: ["/specs/a", "/specs/b"],
  reloadFrequencySeconds: 0,
  ghostty: true,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-settings-yaml-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-settings-yaml-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  delete process.env[HOME_SETTINGS_ENV];
  yaml = statePath(root);
  json = jsonStatePath(yaml);
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const files = async (dir: string) => (await readdir(dir)).sort();
const text = (path: string) => Bun.file(path).text();

test("settings are saved as YAML, in settings.yaml", async () => {
  expect([STATE_FILE, LEGACY_JSON_STATE_FILE]).toEqual(["settings.yaml", "settings.json"]);
  expect(yaml).toBe(join(root, ".specdriven", "settings.yaml"));
  expect(homeStatePath()).toBe(join(home, "settings.yaml"));
  // The file's name says which format it holds.
  expect([isYamlPath(yaml), isYamlPath(json), isYamlPath(`${yaml}.v0.bak`)]).toEqual([true, false, false]);
  await writeState({ dataRepo: "/specs/a", ghostty: true, recentFolders: [{ path: "/specs/a", kind: "spec" }] }, root);
  expect(await text(yaml)).toBe(
    ["dataRepo: /specs/a", "ghostty: true", "recentFolders:", "  - path: /specs/a", "    kind: spec", ""].join("\n"),
  );
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.yaml"]);
});

test("every value comes back from settings.yaml as it was saved", async () => {
  // What YAML would read as something else when written bare, long values
  // it might fold, and keys that are paths and urls.
  const strings = [
    "", " ", "  padded  ", "true", "False", "yes", "no", "on", "off", "null", "~", "123", "-1", "+1", ".5", "1e3",
    "0x1F", "0o17", "2026-11-11", "12:30", "- item", "# not a comment", "a: b", "a #b", "key:", "@at", "*star",
    "&amp", "!bang", "%pct", "{brace", "[bracket", "'single'", '"double"', "back\\slash", "tab\there", "two\nlines",
    "trailing newline\n", "C:\\Users\\ann\\specs", "https://github.com/acme/specs", "ws://localhost:3030", "é ü 日本 🙂",
    `${"a long value that goes on and on ".repeat(12)}end`,
  ];
  const state = {
    settingsVersion: SETTINGS_VERSION,
    dataRepo: "C:\\Users\\ann\\specs",
    syncServerUrl: "",
    autosaveIntervalSeconds: 6,
    ghostty: false,
    recentFolders: [
      { path: "https://github.com/acme/specs", kind: "spec" },
      { path: "/Users/ann/dev/a folder: with #odd, [chars]", kind: "code" },
    ],
    logLevels: { git: "error", "net sync": "debug" },
    plugins: {
      enabled: [],
      repos: {
        "https://github.com/acme/specs": { enabled: ["models", "123", "true"] },
        "/Users/ann/dev/specs": { enabled: [] },
        "C:\\specs": {},
        "": { enabled: ["x"] },
      },
    },
    pluginSettings: {
      acme: { strings, zero: 0, float: 1.5, big: 9007199254740991, negative: -3, nothing: null, list: [1, "1", true, "true", null, [], {}] },
      "odd key: #1": { "true": "true", "123": 123, "~": null },
    },
  };
  await writeState(state as never, root);
  expect(await readSettings(yaml)).toEqual(state);
  // A second save of what was read writes the same file.
  const saved = await text(yaml);
  await writeState((await readSettings(yaml)) as never, root);
  expect(await text(yaml)).toBe(saved);
});

test("a settings.json from before YAML is read as it is, until it is converted", async () => {
  await writeSettings(json, OLD);
  const before = await text(json);
  expect(await settingsFile(root)).toBe(json);
  expect((await readState(root)).dataRepo).toBe("/specs/b");
  expect(await settingsDirectory(root)).toBe(join(root, ".specdriven"));
  // Reading converts nothing.
  expect(await text(json)).toBe(before);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json"]);
});

test("converting writes the same settings as settings.yaml and keeps settings.json as settings.json.bak", async () => {
  await writeSettings(json, OLD);
  const before = await text(json);
  expect(await convertSettingsFile(root)).toEqual({ path: yaml, backup: jsonBackupPath(json) });
  // Only the format changed: no upgrade step ran, nothing was cleaned up.
  expect(await readSettings(yaml)).toEqual(OLD);
  expect(await text(jsonBackupPath(json))).toBe(before);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml"]);
  expect(await settingsFile(root)).toBe(yaml);
  // Once is enough.
  const after = await text(yaml);
  expect(await convertSettingsFile(root)).toBeNull();
  expect(await text(yaml)).toBe(after);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml"]);
});

test("an older settings.json is converted, then upgraded to this app's format", async () => {
  await writeSettings(json, OLD);
  const result = await upgradeSettingsFile(root);
  expect(result).toMatchObject({ from: 0, to: SETTINGS_VERSION, path: yaml, backup: `${yaml}.v0.bak` });
  expect(result?.converted).toEqual({ path: yaml, backup: jsonBackupPath(json) });
  const saved = await readSettings(yaml);
  expect(saved.settingsVersion).toBe(SETTINGS_VERSION);
  expect(saved.recentFolders).toHaveLength(2);
  expect(saved.ghostty).toBe(true);
  expect(Object.keys(saved)).not.toContain("recentDataRepos");
  // The file as it was, in both steps: the JSON one, and the YAML one before the upgrade.
  expect(await readSettings(jsonBackupPath(json))).toEqual(OLD);
  expect(parseSettingsText(await text(`${yaml}.v0.bak`), yaml)).toEqual(OLD);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml", "settings.yaml.v0.bak"]);
  // A second start changes nothing.
  const after = await text(yaml);
  expect(await upgradeSettingsFile(root)).toMatchObject({ backup: null });
  expect(await text(yaml)).toBe(after);
});

test("starting the app converts a settings.json", async () => {
  await writeSettings(json, OLD);
  await applyStartupState();
  expect((await readSettings(yaml)).dataRepo).toBe("/specs/b");
  expect(await Bun.file(json).exists()).toBe(false);
  expect(await readSettings(jsonBackupPath(json))).toEqual(OLD);
});

test("settings.yaml wins over a settings.json beside it, which is left alone", async () => {
  await writeSettings(yaml, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/yaml" });
  await writeSettings(json, { dataRepo: "/specs/json" });
  const stray = await text(json);
  expect((await readState(root)).dataRepo).toBe("/specs/yaml");
  expect(await convertSettingsFile(root)).toBeNull();
  expect(await upgradeSettingsFile(root)).toMatchObject({ path: yaml, backup: null });
  await writeState({ ...(await readState(root)), ghostty: true }, root);
  expect((await readSettings(yaml)).ghostty).toBe(true);
  expect(await text(json)).toBe(stray);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json", "settings.yaml"]);
});

test("a save converts a settings.json the start did not", async () => {
  await writeSettings(json, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/b" });
  const before = await text(json);
  await writeState({ ...(await readState(root)), ghostty: true }, root);
  expect(await readSettings(yaml)).toMatchObject({ dataRepo: "/specs/b", ghostty: true });
  expect(await text(jsonBackupPath(json))).toBe(before);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml"]);
});

test("a settings.json that does not parse is not converted; the next save sets it aside", async () => {
  await Bun.write(json, "{ not json");
  expect(await convertSettingsFile(root)).toBeNull();
  expect(await upgradeSettingsFile(root)).toBeNull();
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json"]);
  // Empty state, as an unreadable settings file always was.
  expect(await readState(root)).toEqual({});
  await writeState({ dataRepo: "/specs/a" }, root);
  expect((await readState(root)).dataRepo).toBe("/specs/a");
  expect(await text(jsonBackupPath(json))).toBe("{ not json");
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml"]);
});

test("the home settings.json is converted where it is, and saves stay in the home folder", async () => {
  const homeJson = jsonStatePath(homeStatePath());
  await writeSettings(homeJson, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/home" });
  expect((await readState(root)).dataRepo).toBe("/specs/home");
  expect(await settingsDirectory(root)).toBe(home);
  expect((await upgradeSettingsFile(root))?.converted).toEqual({ path: homeStatePath(), backup: jsonBackupPath(homeJson) });
  expect(await files(home)).toEqual(["settings.json.bak", "settings.yaml"]);
  await writeState({ ...(await readState(root)), ghostty: true }, root);
  expect(await readSettings(homeStatePath())).toMatchObject({ dataRepo: "/specs/home", ghostty: true });
  // No project settings file grew beside it.
  expect(await files(root)).toEqual([]);
});

test("a project settings.json still wins over the home settings file", async () => {
  await writeSettings(homeStatePath(), { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/home" });
  await writeSettings(json, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/project" });
  const homeText = await text(homeStatePath());
  expect((await readState(root)).dataRepo).toBe("/specs/project");
  expect(await settingsDirectory(root)).toBe(join(root, ".specdriven"));
  await writeState({ ...(await readState(root)), ghostty: true }, root);
  expect(await readSettings(yaml)).toMatchObject({ dataRepo: "/specs/project", ghostty: true });
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json.bak", "settings.yaml"]);
  expect(await text(homeStatePath())).toBe(homeText);
});

test("the desktop app converts the home settings.json, not one under its app data", async () => {
  process.env[HOME_SETTINGS_ENV] = "1";
  const homeJson = jsonStatePath(homeStatePath());
  await writeSettings(homeJson, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/home" });
  await writeSettings(json, { settingsVersion: SETTINGS_VERSION, dataRepo: "/specs/app-data" });
  const appData = await text(json);
  expect((await readState(root)).dataRepo).toBe("/specs/home");
  expect((await upgradeSettingsFile(root))?.converted?.path).toBe(homeStatePath());
  expect(await files(home)).toEqual(["settings.json.bak", "settings.yaml"]);
  expect(await text(json)).toBe(appData);
  expect(await files(join(root, ".specdriven"))).toEqual(["settings.json"]);
});

test("the settings file view shows a home settings.json that has not been converted", async () => {
  const homeJson = jsonStatePath(homeStatePath());
  await writeSettings(homeJson, { ghostty: true });
  expect(await readSettingsFileView(root)).toMatchObject({ path: homeJson, exists: true, settings: { ghostty: true } });
  await Bun.write(homeJson, "{ not json");
  expect((await readSettingsFileView(root)).error).toBe("The file is not valid JSON.");
  // Converted, it is the YAML file that is shown.
  await writeSettings(homeJson, { ghostty: true });
  await convertSettingsFile(root);
  expect(await readSettingsFileView(root)).toMatchObject({ path: homeStatePath(), exists: true, settings: { ghostty: true } });
});
