// Automates specs/ui/ui.feature.md "Recent folder list": the ▾ beside the
// folder name offers the data folders used before — up to 10, most recent
// first — and picking one switches to it. The list lives in the settings
// file and comes to the client through /api/state.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, reloader } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import {
  MAX_RECENT_DATA_REPOS,
  normalizeRecentDataRepos,
  readState,
  recentDataRepos,
  rememberDataRepo,
  writeState,
} from "../src/server/state";
import { stopServers } from "./helpers/fixtures";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-recent-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-recent-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
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

async function getState() {
  const res = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(res.status).toBe(200);
  return res.json();
}

async function pickFolder(dataRepo: string) {
  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataRepo }),
    }),
  ))!;
  expect(res.status).toBe(200);
  return res.json();
}

/** A plain (non-git) data folder with one feature in it. */
async function dataFolder(name: string): Promise<string> {
  const dir = join(root, name);
  await Bun.write(join(dir, `${name}.feature.md`), `# ${name}\n`);
  return dir;
}

test("a settings file from before the list still offers the one folder it names", () => {
  expect(recentDataRepos({ dataRepo: "/specs/a" })).toEqual(["/specs/a"]);
  expect(recentDataRepos({})).toEqual([]);
});

test("the current folder heads the list, without a duplicate", () => {
  expect(recentDataRepos({ dataRepo: "/b", recentDataRepos: ["/a", "/b", "/c"] })).toEqual([
    "/b",
    "/a",
    "/c",
  ]);
});

test("remembering a folder moves it to the front", () => {
  const state = { dataRepo: "/c", recentDataRepos: ["/a", "/b", "/c"] };
  rememberDataRepo(state, "/b");
  expect(state.recentDataRepos).toEqual(["/b", "/a", "/c"]);
  rememberDataRepo(state, "/new");
  expect(state.recentDataRepos).toEqual(["/new", "/b", "/a", "/c"]);
});

test("the list holds at most 10 folders — the oldest falls off", () => {
  const state: { recentDataRepos?: string[] } = {};
  for (let i = 1; i <= 12; i++) rememberDataRepo(state, `/specs/${i}`);
  expect(MAX_RECENT_DATA_REPOS).toBe(10);
  expect(state.recentDataRepos).toHaveLength(10);
  expect(state.recentDataRepos![0]).toBe("/specs/12");
  expect(state.recentDataRepos).not.toContain("/specs/1");
  expect(state.recentDataRepos).not.toContain("/specs/2");
});

test("a hand-edited list is cleaned: blanks, non-strings and repeats are dropped", () => {
  expect(normalizeRecentDataRepos(["/a", "", " /a ", 3, null, "/b"])).toEqual(["/a", "/b"]);
  expect(normalizeRecentDataRepos("not a list")).toEqual([]);
});

test("GET /api/state carries the recent folders, the current one first", async () => {
  await writeState(
    { dataRepo: "/specs/b", recentDataRepos: ["/specs/a", "/specs/b"], reloadFrequencySeconds: 0 },
    root,
  );
  const state = await getState();
  expect(state.recentDataRepos).toEqual(["/specs/b", "/specs/a"]);
});

test("picking folders builds the list, most recent first, and persists it", async () => {
  const a = await dataFolder("a");
  const b = await dataFolder("b");
  await applyStartupState();

  expect((await pickFolder(a)).recentDataRepos).toEqual([a]);
  expect((await pickFolder(b)).recentDataRepos).toEqual([b, a]);
  // Switching back through the list moves the folder to the front.
  expect((await pickFolder(a)).recentDataRepos).toEqual([a, b]);

  const saved = await readState(root);
  expect(saved.dataRepo).toBe(a);
  expect(saved.recentDataRepos).toEqual([a, b]);
  expect((await getState()).recentDataRepos).toEqual([a, b]);
});

test("a folder the app cannot use is not added to the list", async () => {
  const a = await dataFolder("a");
  await applyStartupState();
  await pickFolder(a);

  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataRepo: "https://gitlab.com/someone/specs" }),
    }),
  ))!;
  expect(res.status).toBe(400);
  expect((await getState()).recentDataRepos).toEqual([a]);
});

test("other settings changes leave the list alone", async () => {
  const a = await dataFolder("a");
  await applyStartupState();
  await pickFolder(a);

  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioPreviewLines: 4 }),
    }),
  ))!;
  expect(res.status).toBe(200);
  expect((await res.json()).recentDataRepos).toEqual([a]);
});
