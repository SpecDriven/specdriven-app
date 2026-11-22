// The profile through the app (specs/app/plugins.feature.md "The profile
// lists enabled plugins in tab order"): a settings file from before plugins
// is read as the matching list once and rewritten as `plugins.enabled`;
// `PUT /api/state` takes the list whole, or one legacy switch at a time as an
// alias; and `GET /api/state` lists the plugins in the profile's order.
// Specs is on that list ("Specs is a built-in plugin"): a list from before
// it was reads with it first, and a folder's list is made from its data the
// first time the folder is opened ("A folder's plugins are picked from its
// data the first time it opens").

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, matchApi, reloader, syncedOnStart } from "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import { profileManifests } from "../src/plugins/builtin/manifests";
import { dataChecked, readProfile, seedFromData } from "../src/plugins/profile";
import { hasSpecs } from "../src/plugins/builtin/specs/host";
import { SETTINGS_VERSION, statePath, writeState } from "../src/server/state";
import { readSettings } from "./helpers/settingsFile";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-profile-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-profile-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  await syncPlugins({});
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

async function settingsFile(): Promise<Record<string, unknown>> {
  return readSettings(statePath(root));
}

async function put(body: unknown): Promise<Response> {
  return (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  ))!;
}

type StateBody = { plugins: { id: string; enabled: boolean; active: boolean; installed: boolean; error?: string }[] } & Record<string, unknown>;

async function state(): Promise<StateBody> {
  return (await (await handleApi(new Request("http://localhost/api/state")))!.json()) as StateBody;
}

test("a settings file with the old switches is rewritten as the profile on start, and works as it did", async () => {
  // No data repo: nothing to sync on start; the switches are the point.
  await writeState({ reloadFrequencySeconds: 0, testing: true, roadmap: true, notebook: false }, root);
  await applyStartupState();

  const file = await settingsFile();
  expect(file.plugins).toEqual({ enabled: ["specs", "roadmap", "tests", "self-fix"], format: 2 });
  for (const key of ["testing", "roadmap", "notebook", "tasks", "models", "issues"]) {
    expect(key in file).toBe(false);
  }
  // The routes follow the profile, and the old fields still read as before.
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect(matchApi("GET", "/api/roadmap")).not.toBeNull();
  expect(matchApi("GET", "/api/notebook")).toBeNull();
  const s = await state();
  expect(s.plugins.map((p) => [p.id, p.enabled])).toEqual([
    ["specs", true],
    ["roadmap", true],
    ["tests", true],
    ["self-fix", true],
    ["tasks", false],
    ["notebook", false],
    ["issues", false],
  ]);
  expect([s.testing, s.roadmap, s.notebook, s.tasks]).toEqual([true, true, false, false]);
});

test("a fresh install shows Specs alone without a settings write", async () => {
  await applyStartupState();
  await expect(readFile(statePath(root), "utf8")).rejects.toThrow();
  expect((await state()).plugins.map((p) => [p.id, p.enabled])).toEqual([
    ["specs", true],
    ["roadmap", false],
    ["tasks", false],
    ["notebook", false],
    ["issues", false],
    ["tests", false],
    ["self-fix", false],
  ]);
});

// Each data folder keeps its own plugins (specs/app/plugins.feature.md): a
// folder opened for the first time shows Specs alone, and switching folders
// switches the plugins with them.
test("each data folder keeps its own plugins, and a new one shows Specs alone", async () => {
  const a = join(root, "repo-a");
  const b = join(root, "repo-b");
  await mkdir(a);
  await mkdir(b);
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});

  expect((await put({ dataRepo: a })).status).toBe(200);
  let res = await put({ plugins: { enabled: ["specs", "tests", "issues"] } });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "specs",
    "tests",
    "issues",
  ]);
  expect(matchApi("GET", "/api/tests")).not.toBeNull();

  // A new folder, with nothing in it: Specs alone, recorded as looked at.
  res = await put({ dataRepo: b });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["specs"]);
  expect(matchApi("GET", "/api/tests")).toBeNull();
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: {
      [a]: { enabled: ["specs", "tests", "issues"], checked: true },
      [b]: { enabled: ["specs"], checked: true },
    },
  });
  await put({ testing: true });

  // Back to the first folder: its list, its routes.
  res = await put({ dataRepo: a });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "specs",
    "tests",
    "issues",
  ]);
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: {
      [a]: { enabled: ["specs", "tests", "issues"], checked: true },
      [b]: { enabled: ["specs", "tests"], checked: true },
    },
  });
});

test("an older device-wide list carries over to the folder that is open", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a, plugins: { enabled: ["roadmap"] } }, root);
  await applyStartupState();
  // The list is from before Specs was a plugin, when every folder had it:
  // it goes first, and the file says its lists name it from here on.
  expect((await settingsFile()).plugins).toEqual({ format: 2, repos: { [a]: { enabled: ["specs", "roadmap"] } } });
  expect(
    (await state()).plugins.filter((p) => p.enabled).map((p) => p.id),
  ).toEqual(["specs", "roadmap"]);
  // The page asking for its state is the folder being opened: looked at, once.
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: { [a]: { enabled: ["specs", "roadmap"], checked: true } },
  });
});

// An app from before per-folder lists showed the manifests' defaults — the
// Notebook — to a file naming a folder with no list and none of the old
// switches: someone who never changed a plugin. The folder keeps showing it.
test("an older file with a folder but no plugin list keeps the Notebook on in that folder", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a }, root);
  await applyStartupState();
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: { [a]: { enabled: ["specs", "notebook", "self-fix"] } },
  });
  expect(
    (await state()).plugins.filter((p) => p.enabled).map((p) => p.id),
  ).toEqual(["specs", "notebook", "self-fix"]);
});

// The file this app writes when it records a folder says it keeps
// per-folder lists, so a restart never reads it as an older file.
test("a folder picked in this app still shows Specs alone after a restart", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});
  expect((await put({ dataRepo: a })).status).toBe(200);
  const stored = { format: 2, repos: { [a]: { enabled: ["specs"], checked: true } } };
  expect((await settingsFile()).plugins).toEqual(stored);
  await applyStartupState();
  expect((await state()).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["specs"]);
  expect((await settingsFile()).plugins).toEqual(stored);
});

test("PUT /api/state takes the profile whole, or a legacy switch as an alias", async () => {
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});

  // The list whole: order is tab order, and the file carries it.
  let res = await put({ plugins: { enabled: ["tests", "notebook"] } });
  expect([res.status, await res.clone().text()]).toEqual([200, expect.any(String)]);
  expect(((await res.json()) as StateBody).plugins.slice(0, 2).map((p) => p.id)).toEqual(["tests", "notebook"]);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["tests", "notebook"], format: 2 });
  expect(matchApi("GET", "/api/tests")).not.toBeNull();

  // A legacy switch: on appends to the list, off removes from it; the file
  // never gets the old key back.
  res = await put({ roadmap: true });
  expect(res.status).toBe(200);
  expect((await settingsFile())).toEqual({
    settingsVersion: SETTINGS_VERSION,
    reloadFrequencySeconds: 0,
    plugins: { enabled: ["tests", "notebook", "roadmap"], format: 2 },
  });
  res = await put({ testing: false });
  expect(((await res.json()) as StateBody).testing).toBe(false);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["notebook", "roadmap"], format: 2 });
  expect(matchApi("GET", "/api/tests")).toBeNull();

  // Garbage is refused and changes nothing.
  expect((await put({ plugins: { enabled: "tests" } })).status).toBe(400);
  expect((await put({ plugins: { enabled: ["tests", 3] } })).status).toBe(400);
  expect((await put({ testing: "yes" })).status).toBe(400);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["notebook", "roadmap"], format: 2 });

  // An id nothing provides stays in the list and is reported, not fatal.
  res = await put({ plugins: { enabled: ["acme-jira", "notebook"] } });
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as StateBody).plugins;
  expect(rows[0]).toMatchObject({ id: "acme-jira", enabled: true, active: false, installed: false });
  expect(rows[0]!.error).toMatch(/No installed plugin/);
  expect(rows[1]).toMatchObject({ id: "notebook", enabled: true, active: true });
});

// ---- Specs is a built-in plugin ---------------------------------------------

const enabledIds = async () => (await state()).plugins.filter((p) => p.enabled).map((p) => p.id);

test("Specs is listed first as a built-in plugin, and switching it off holds across a restart", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});
  expect((await put({ dataRepo: a })).status).toBe(200);
  expect((await state()).plugins[0]).toMatchObject({ id: "specs", builtin: true, enabled: true, active: true });

  // Off: the list no longer names it, and the row says so.
  const res = await put({ plugins: { enabled: ["notebook"] } });
  const rows = ((await res.json()) as StateBody).plugins;
  expect(rows.find((p) => p.id === "specs")).toMatchObject({ enabled: false, active: false });
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: { [a]: { enabled: ["notebook"], checked: true } },
  });
  // The spec routes are the core's: they answer with the tab hidden.
  expect(matchApi("GET", "/api/features")).not.toBeNull();

  await applyStartupState();
  expect(await enabledIds()).toEqual(["notebook"]);

  // On again, after the notebook: the order is the list's.
  await put({ plugins: { enabled: ["notebook", "specs"] } });
  expect(await enabledIds()).toEqual(["notebook", "specs"]);
});

test("a list from before Specs was a plugin reads with Specs first", () => {
  const old = { dataRepo: "/a", plugins: { repos: { "/a": { enabled: ["notebook"] } } } };
  expect(readProfile(old, profileManifests).enabled).toEqual(["specs", "notebook"]);
  // Once the file names Specs itself, a list without it has it off.
  const named = { dataRepo: "/a", plugins: { format: 2, repos: { "/a": { enabled: ["notebook"] } } } };
  expect(readProfile(named, profileManifests).enabled).toEqual(["notebook"]);
  // No list at all: Specs alone, either way.
  expect(readProfile({ dataRepo: "/b", plugins: { format: 2, repos: {} } }, profileManifests).enabled).toEqual(["specs"]);
});

// ---- a folder's plugins are picked from its data the first time it opens -----

test("the list is made from the data once, what has data goes on and Specs goes off where another has some", () => {
  const seed = (enabled: string[], withData: string[], entry: Record<string, unknown> = {}) => {
    const s: Record<string, unknown> = { dataRepo: "/a", plugins: { format: 2, repos: { "/a": entry } } };
    return { list: seedFromData(s, enabled, withData, profileManifests), plugins: s.plugins };
  };
  // Specs only, notebook only, both, and nothing at all.
  expect(seed(["specs"], ["specs"]).list).toEqual(["specs"]);
  expect(seed(["specs"], ["notebook"]).list).toEqual(["notebook"]);
  expect(seed(["specs"], ["specs", "notebook", "roadmap"]).list).toEqual(["specs", "roadmap", "notebook"]);
  expect(seed(["specs"], []).list).toEqual(["specs"]);
  // What was on stays on, in its order; a plugin with no data does not count against Specs.
  expect(seed(["specs", "self-fix", "notebook"], []).list).toEqual(["specs", "self-fix", "notebook"]);
  expect(seed(["specs", "self-fix"], ["tasks"]).list).toEqual(["self-fix", "tasks"]);
  // The folder is marked, with its list.
  expect(seed(["specs"], ["notebook"]).plugins).toEqual({
    format: 2,
    repos: { "/a": { enabled: ["notebook"], checked: true } },
  });
  // The mark is what stops a second look.
  const once: Record<string, unknown> = { dataRepo: "/a", plugins: { format: 2, repos: {} } };
  expect(dataChecked(once)).toBe(false);
  expect(seedFromData(once, ["specs"], ["notebook"], profileManifests)).toEqual(["notebook"]);
  expect(dataChecked(once)).toBe(true);
  expect(seedFromData(once, ["notebook"], ["specs"], profileManifests)).toBeNull();
  // Looked at before: left alone, whatever the data says now.
  expect(seed(["notebook"], ["specs"], { enabled: ["notebook"], checked: true }).list).toBeNull();
  // No folder open: nothing to make a list for.
  expect(seedFromData({}, ["specs"], ["notebook"], profileManifests)).toBeNull();
});

test("a folder has Specs data once a feature file lies under its specs folder", async () => {
  const dir = join(root, "repo-a");
  await mkdir(join(dir, "specs", "billing"), { recursive: true });
  // The folder the app makes for every data folder is no data, nor is a
  // feature file left outside it.
  expect(await hasSpecs(dir)).toBe(false);
  await writeFile(join(dir, "stray.feature.md"), "# Stray\n");
  await writeFile(join(dir, "specs", "notes.md"), "# Notes\n");
  expect(await hasSpecs(dir)).toBe(false);
  await writeFile(join(dir, "specs", "billing", "quote.feature.md"), "# Quote\n");
  expect(await hasSpecs(dir)).toBe(true);
  // A folder that is not there yet has none.
  expect(await hasSpecs(join(root, "missing"))).toBe(false);
});

test("a folder of notebook entries opens on the Notebook alone, and one with specs too shows both", async () => {
  const notes = join(root, "notes");
  const both = join(root, "both");
  await mkdir(join(notes, "notebook"), { recursive: true });
  await writeFile(join(notes, "notebook", "2026-11-20-first.md"), "# First\n");
  await mkdir(join(both, "notebook"), { recursive: true });
  await writeFile(join(both, "notebook", "2026-11-20-first.md"), "# First\n");
  await mkdir(join(both, "specs"), { recursive: true });
  await writeFile(join(both, "specs", "quote.feature.md"), "# Feature: Quote\n");
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});

  let res = await put({ dataRepo: notes });
  expect(res.status).toBe(200);
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["notebook"]);
  expect(matchApi("GET", "/api/notebook")).not.toBeNull();

  res = await put({ dataRepo: both });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "specs",
    "notebook",
  ]);

  // The choice is made once: Specs switched on by hand in the first folder
  // stays on, though the folder still holds no feature.
  await put({ dataRepo: notes });
  await put({ plugins: { enabled: ["specs", "notebook"] } });
  await put({ dataRepo: both });
  res = await put({ dataRepo: notes });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "specs",
    "notebook",
  ]);
});

test("a folder used before the check is looked at once, its tasks go on and its empty Specs off", async () => {
  const a = join(root, "repo-a");
  await mkdir(join(a, "tasks"), { recursive: true });
  await writeFile(join(a, "tasks", "ship.md"), "# Ship\n");
  // A list from before Specs was a plugin, with Tasks switched off by hand.
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a, plugins: { repos: { [a]: { enabled: ["self-fix"] } } } }, root);
  await applyStartupState();
  expect(await enabledIds()).toEqual(["self-fix", "tasks"]);
  expect((await settingsFile()).plugins).toEqual({
    format: 2,
    repos: { [a]: { enabled: ["self-fix", "tasks"], checked: true } },
  });
});
