// The profile through the app (specs/app/plugins.feature.md "The profile
// lists enabled plugins in tab order"): a settings file from before plugins
// is read as the matching list once and rewritten as `plugins.enabled`;
// `PUT /api/state` takes the list whole, or one legacy switch at a time as an
// alias; and `GET /api/state` lists the plugins in the profile's order.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, matchApi, reloader, syncedOnStart } from "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import { statePath, writeState } from "../src/server/state";

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
  return JSON.parse(await readFile(statePath(root), "utf8")) as Record<string, unknown>;
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
  // The agents, on by default (specs/agents/agent-plugins.feature.md), come with the defaults.
  expect(file.plugins).toEqual({ enabled: ["roadmap", "tests", "self-fix", "agent-claude", "agent-codex", "agent-pi"] });
  for (const key of ["testing", "roadmap", "notebook", "tasks", "models", "issues"]) {
    expect(key in file).toBe(false);
  }
  // The routes follow the profile, and the old fields still read as before.
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect(matchApi("GET", "/api/roadmap")).not.toBeNull();
  expect(matchApi("GET", "/api/notebook")).toBeNull();
  const s = await state();
  expect(s.plugins.map((p) => [p.id, p.enabled])).toEqual([
    ["roadmap", true],
    ["tests", true],
    ["self-fix", true],
    ["agent-claude", true],
    ["agent-codex", true],
    ["agent-pi", true],
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
    ["roadmap", false],
    ["tasks", false],
    ["notebook", false],
    ["issues", false],
    ["tests", false],
    ["self-fix", false],
    ["agent-claude", false],
    ["agent-codex", false],
    ["agent-pi", false],
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
  let res = await put({ plugins: { enabled: ["tests", "issues"] } });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "tests",
    "issues",
  ]);
  expect(matchApi("GET", "/api/tests")).not.toBeNull();

  // A new folder: Specs alone — only the tab-less agents switch themselves
  // on (manifest.autoEnable, specs/agents/agent-plugins.feature.md), and
  // that is all that is written for it until it changes.
  res = await put({ dataRepo: b });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["agent-claude", "agent-codex", "agent-pi"]);
  expect(matchApi("GET", "/api/tests")).toBeNull();
  expect((await settingsFile()).plugins).toEqual({
    repos: {
      [a]: { enabled: ["tests", "issues"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] },
      [b]: { enabled: ["agent-claude", "agent-codex", "agent-pi"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] },
    },
  });
  await put({ testing: true });

  // Back to the first folder: its list, its routes.
  res = await put({ dataRepo: a });
  expect(((await res.json()) as StateBody).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual([
    "tests",
    "issues",
  ]);
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect((await settingsFile()).plugins).toEqual({
    repos: {
      [a]: { enabled: ["tests", "issues"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] },
      [b]: { enabled: ["agent-claude", "agent-codex", "agent-pi", "tests"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] },
    },
  });
});

test("an older device-wide list carries over to the folder that is open", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a, plugins: { enabled: ["roadmap"] } }, root);
  await applyStartupState();
  expect((await settingsFile()).plugins).toEqual({ repos: { [a]: { enabled: ["roadmap", "agent-claude", "agent-codex", "agent-pi"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] } } });
  expect(
    (await state()).plugins.filter((p) => p.enabled).map((p) => p.id),
  ).toEqual(["roadmap", "agent-claude", "agent-codex", "agent-pi"]);
});

// An app from before per-folder lists showed the manifests' defaults — the
// Notebook — to a file naming a folder with no list and none of the old
// switches: someone who never changed a plugin. The folder keeps showing it.
test("an older file with a folder but no plugin list keeps the Notebook on in that folder", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a }, root);
  await applyStartupState();
  expect((await settingsFile()).plugins).toEqual({ repos: { [a]: { enabled: ["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"] } } });
  expect(
    (await state()).plugins.filter((p) => p.enabled).map((p) => p.id),
  ).toEqual(["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"]);
});

// The file this app writes when it records a folder says it keeps
// per-folder lists, so a restart never reads it as an older file.
test("a folder picked in this app still shows Specs alone after a restart", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});
  expect((await put({ dataRepo: a })).status).toBe(200);
  // The agents switched themselves on for the folder; the tabs stay off.
  const agentsOn = { repos: { [a]: { enabled: ["agent-claude", "agent-codex", "agent-pi"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] } } };
  expect((await settingsFile()).plugins).toEqual(agentsOn);
  await applyStartupState();
  expect((await state()).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["agent-claude", "agent-codex", "agent-pi"]);
  expect((await settingsFile()).plugins).toEqual(agentsOn);
});

test("PUT /api/state takes the profile whole, or a legacy switch as an alias", async () => {
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await syncPlugins({});

  // The list whole: order is tab order, and the file carries it.
  let res = await put({ plugins: { enabled: ["tests", "notebook"] } });
  expect([res.status, await res.clone().text()]).toEqual([200, expect.any(String)]);
  expect(((await res.json()) as StateBody).plugins.slice(0, 2).map((p) => p.id)).toEqual(["tests", "notebook"]);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["tests", "notebook"] });
  expect(matchApi("GET", "/api/tests")).not.toBeNull();

  // A legacy switch: on appends to the list, off removes from it; the file
  // never gets the old key back.
  res = await put({ roadmap: true });
  expect(res.status).toBe(200);
  expect((await settingsFile())).toEqual({
    reloadFrequencySeconds: 0,
    plugins: { enabled: ["tests", "notebook", "roadmap"] },
  });
  res = await put({ testing: false });
  expect(((await res.json()) as StateBody).testing).toBe(false);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["notebook", "roadmap"] });
  expect(matchApi("GET", "/api/tests")).toBeNull();

  // Garbage is refused and changes nothing.
  expect((await put({ plugins: { enabled: "tests" } })).status).toBe(400);
  expect((await put({ plugins: { enabled: ["tests", 3] } })).status).toBe(400);
  expect((await put({ testing: "yes" })).status).toBe(400);
  expect((await settingsFile()).plugins).toEqual({ enabled: ["notebook", "roadmap"] });

  // An id nothing provides stays in the list and is reported, not fatal.
  res = await put({ plugins: { enabled: ["acme-jira", "notebook"] } });
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as StateBody).plugins;
  expect(rows[0]).toMatchObject({ id: "acme-jira", enabled: true, active: false, installed: false });
  expect(rows[0]!.error).toMatch(/No installed plugin/);
  expect(rows[1]).toMatchObject({ id: "notebook", enabled: true, active: true });
});

// The plugins that switch themselves on (manifest.autoEnable, specs/agents/
// agent-plugins.feature.md): the coding agents, which have no tab. A folder
// gets them the first time this device opens it with them installed — one
// from before them included — and one switched off there stays off.
test("a tab-less plugin that switches itself on does so once per folder, and a switch-off sticks", async () => {
  const a = join(root, "repo-a");
  await mkdir(a);
  // A folder from before the agent plugins: a list of its own without them.
  await writeState({ reloadFrequencySeconds: 0, dataRepo: a, plugins: { repos: { [a]: { enabled: ["tests"] } } } }, root);
  await applyStartupState();
  expect((await state()).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["tests", "agent-claude", "agent-codex", "agent-pi"]);
  expect((await settingsFile()).plugins).toEqual({
    repos: { [a]: { enabled: ["tests", "agent-claude", "agent-codex", "agent-pi"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] } },
  });
  // Switched off in Settings → Plugins: the next start leaves it off.
  const res = await put({ plugins: { enabled: ["tests", "agent-claude", "agent-pi"] } });
  expect(res.status).toBe(200);
  await applyStartupState();
  expect((await state()).plugins.filter((p) => p.enabled).map((p) => p.id)).toEqual(["tests", "agent-claude", "agent-pi"]);
  expect((await settingsFile()).plugins).toEqual({
    repos: { [a]: { enabled: ["tests", "agent-claude", "agent-pi"], autoEnabled: ["agent-claude", "agent-codex", "agent-pi"] } },
  });
});
