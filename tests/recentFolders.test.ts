// Automates specs/ui/ui.feature.md "Recent folder list": the ▾ beside the
// folder name offers the data folders used before — up to 10, most recent
// first — and picking one switches to it. The list lives in the settings
// file and comes to the client through /api/state.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import {
  MAX_RECENT_DATA_REPOS,
  normalizeDataRepo,
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
  // applyStartupState() fires the app-start sync without awaiting it. Let it
  // finish before teardown, or it runs on into the next test file — and into
  // whatever that file records (tests/telemetry.test.ts saw its git span).
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

test("a folder typed with a trailing slash is the same folder without it", () => {
  expect(normalizeDataRepo(" /specs/a/ ")).toBe("/specs/a");
  expect(normalizeDataRepo("https://github.com/o/specs/")).toBe("https://github.com/o/specs");
  expect(normalizeDataRepo("C:\\specs\\a\\")).toBe("C:\\specs\\a");
  // A root keeps its separator.
  expect(normalizeDataRepo("/")).toBe("/");
  expect(normalizeDataRepo("C:\\")).toBe("C:\\");
  expect(normalizeRecentDataRepos(["/specs/a/", "/specs/a", "/specs/b//"])).toEqual(["/specs/a", "/specs/b"]);
  expect(recentDataRepos({ dataRepo: "/specs/a/", recentDataRepos: ["/specs/a"] })).toEqual(["/specs/a"]);
});

test("picking a folder with a trailing slash saves it without one", async () => {
  const a = await dataFolder("a");
  await applyStartupState();
  const state = await pickFolder(`${a}/`);
  expect(state.dataRepo).toBe(a);
  expect(state.recentDataRepos).toEqual([a]);
  const saved = await readState(root);
  expect(saved.dataRepo).toBe(a);
  expect(saved.recentDataRepos).toEqual([a]);
});

test("a settings file saved with a trailing slash reads back without one", async () => {
  await Bun.write(
    join(root, ".specdriven", "settings.json"),
    JSON.stringify({ dataRepo: "/specs/a/", recentDataRepos: ["/specs/a/", "/specs/b", "/specs/a"] }),
  );
  const saved = await readState(root);
  expect(saved.dataRepo).toBe("/specs/a");
  expect(saved.recentDataRepos).toEqual(["/specs/a", "/specs/b"]);
});

test("GET /api/state carries the recent folders, the current one first", async () => {
  await writeState(
    { dataRepo: "/specs/b", recentDataRepos: ["/specs/a", "/specs/b"], reloadFrequencySeconds: 0 },
    root,
  );
  const state = await getState();
  expect(state.recentDataRepos).toEqual(["/specs/b", "/specs/a"]);
});

test("GET /api/state says where each GitHub url on the list is cloned", async () => {
  const repos = await mkdtemp(join(tmpdir(), "specdriven-recent-repos-"));
  const realRepos = process.env.SPECDRIVEN_REPOS_DIR;
  process.env.SPECDRIVEN_REPOS_DIR = repos;
  try {
    await writeState(
      {
        dataRepo: "/specs/b",
        recentDataRepos: ["https://github.com/acme/specs-insurance", "/specs/b"],
        reloadFrequencySeconds: 0,
      },
      root,
    );
    // Local folders are their own path; only the url gets an entry.
    expect((await getState()).recentDataRepoDirs).toEqual({
      "https://github.com/acme/specs-insurance": join(repos, "specs-insurance"),
    });
  } finally {
    if (realRepos === undefined) delete process.env.SPECDRIVEN_REPOS_DIR;
    else process.env.SPECDRIVEN_REPOS_DIR = realRepos;
    await rm(repos, { recursive: true, force: true });
  }
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

// Manage specification folders (specs/app/spec-folders.feature.md): a
// folder can be taken off the list. Only the list entry goes — nothing on
// disk is touched — and the open folder stays on it.

test("forgetting a folder takes it off the list and says whether it was there", async () => {
  const { forgetDataRepo } = await import("../src/server/state");
  const state = { dataRepo: "/c", recentDataRepos: ["/a", "/b", "/c"] };
  expect(forgetDataRepo(state, "/b")).toBe(true);
  expect(state.recentDataRepos).toEqual(["/a", "/c"]);
  expect(forgetDataRepo(state, " /a ")).toBe(true);
  expect(state.recentDataRepos).toEqual(["/c"]);
  expect(forgetDataRepo(state, "/never")).toBe(false);
  expect(state.recentDataRepos).toEqual(["/c"]);
});

test("PUT /api/state forgetDataRepo removes a folder from the list and persists it, the folder itself untouched", async () => {
  const a = await dataFolder("a");
  const b = await dataFolder("b");
  await applyStartupState();
  await pickFolder(b);
  expect((await pickFolder(a)).recentDataRepos).toEqual([a, b]);

  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetDataRepo: b }),
    }),
  ))!;
  expect(res.status).toBe(200);
  expect((await res.json()).recentDataRepos).toEqual([a]);
  expect((await readState(root)).recentDataRepos).toEqual([a]);
  expect((await getState()).recentDataRepos).toEqual([a]);
  // The folder is still on disk, with its feature in it (moved under specs/
  // when the folder was opened, as every data folder's features are).
  expect(await Bun.file(join(b, "specs", "b.feature.md")).exists()).toBe(true);
  // And forgetting it again is a quiet no-op.
  const again = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetDataRepo: b }),
    }),
  ))!;
  expect(again.status).toBe(200);
  expect((await again.json()).recentDataRepos).toEqual([a]);
});

test("the open folder cannot be removed from the list — switch away first", async () => {
  const a = await dataFolder("a");
  await applyStartupState();
  await pickFolder(a);

  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetDataRepo: a }),
    }),
  ))!;
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("switch to another folder first");
  expect((await getState()).recentDataRepos).toEqual([a]);

  const blank = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forgetDataRepo: "  " }),
    }),
  ))!;
  expect(blank.status).toBe(400);
});

// Switch spec folder (specs/app/spec-folders.feature.md): a path that names
// no folder is refused — a typo must not make a new, empty one — and the
// client asks before it sends createDataRepo to make it.

function putState(body: unknown) {
  return handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

test("a missing folder is refused with a 404, nothing made, the open folder kept", async () => {
  const a = await dataFolder("a");
  await applyStartupState();
  await pickFolder(a);
  const missing = join(root, "typo");

  const res = await putState({ dataRepo: missing });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: `No folder at ${missing}`, missing: true, path: missing });
  expect(await stat(missing).catch(() => null)).toBeNull();
  const state = await getState();
  expect(state.dataRepo).toBe(a);
  expect(state.recentDataRepos).toEqual([a]);
});

test("createDataRepo makes the missing folder and opens it", async () => {
  await applyStartupState();
  const fresh = join(root, "new", "specs-folder");

  const res = await putState({ dataRepo: fresh, createDataRepo: true });
  expect(res.status).toBe(200);
  expect((await stat(fresh)).isDirectory()).toBe(true);
  expect((await res.json()).recentDataRepos).toEqual([fresh]);
});

test("a path to a file is not a folder to open, even with createDataRepo", async () => {
  await applyStartupState();
  const file = join(root, "notes.txt");
  await Bun.write(file, "hello\n");

  const res = await putState({ dataRepo: file, createDataRepo: true });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(`Not a folder: ${file}`);
  expect(await Bun.file(file).text()).toBe("hello\n");
});
