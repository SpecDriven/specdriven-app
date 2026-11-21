// Automates specs/app/multiple-windows.feature.md: several folders open
// side by side, one per window. A window's requests run inside its workspace
// (src/server/workspace.ts) and are answered for that window's folder; the
// settings file is shared, and a run without windows reads it as before.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { localTurn } from "../src/server/git/turns";
import { createReloadScheduler } from "../src/server/reload";
import { readState, writeState } from "../src/server/state";
import {
  closeWorkspace,
  currentWorkspace,
  detached,
  folderKey,
  folderOf,
  noteSettingsFolder,
  onWorkspaceChange,
  openWorkspace,
  resetWorkspaces,
  runInWorkspace,
  sameFolder,
  setWorkspaceFolder,
  settingsFolderWritten,
  withFolder,
  workspaceById,
  workspaces,
  type Workspace,
} from "../src/server/workspace";
import { readSettings } from "./helpers/settingsFile";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-workspace-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-workspace-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  setGitEngine(null);
  resetWorkspaces();
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

/** A plain (non-git) data folder with one feature in it. */
async function dataFolder(name: string): Promise<string> {
  const dir = join(root, name);
  await Bun.write(join(dir, `specs/${name}.feature.md`), `# ${name}\n`);
  return dir;
}

async function api(workspace: Workspace | null, path: string, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, init);
  return (await handleApi(req, workspace ? { workspace } : {}))!;
}

const put = (body: object): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function featureNames(workspace: Workspace | null): Promise<string[]> {
  const res = await api(workspace, "/api/features");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { features: { fileName: string }[] };
  return body.features.map((f) => f.fileName.replace(/^specs\//, "").replace(/\.feature\.md$/, ""));
}

test("each window is answered for its own folder", async () => {
  const a = await dataFolder("alpha");
  const b = await dataFolder("beta");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  const one = openWorkspace("1", { dataRepo: a });
  const two = openWorkspace("2", { dataRepo: b });

  expect(await featureNames(one)).toEqual(["alpha"]);
  expect(await featureNames(two)).toEqual(["beta"]);
  // Interleaved, neither sees the other's.
  const [x, y, z] = await Promise.all([featureNames(two), featureNames(one), featureNames(two)]);
  expect([x, y, z]).toEqual([["beta"], ["alpha"], ["beta"]]);

  const stateOne = await (await api(one, "/api/state")).json();
  const stateTwo = await (await api(two, "/api/state")).json();
  expect(stateOne.dataDir).toBe(a);
  expect(stateTwo.dataDir).toBe(b);
});

test("a run without windows reads the settings file as it is", async () => {
  const a = await dataFolder("alpha");
  const b = await dataFolder("beta");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  openWorkspace("2", { dataRepo: b });
  expect(currentWorkspace()).toBeNull();
  expect(await featureNames(null)).toEqual(["alpha"]);
  expect((await readState(root)).dataRepo).toBe(a);
});

test("a window with no folder open is asked for one, whatever the settings name", async () => {
  const a = await dataFolder("alpha");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  const blank = openWorkspace("new");
  const state = await (await api(blank, "/api/state")).json();
  expect(state.needsDataRepo).toBe(true);
  expect(state.dataRepo).toBeNull();
  expect((await api(blank, "/api/features")).status).toBe(409);
});

test("switching folders in one window leaves the other window's folder alone", async () => {
  const a = await dataFolder("alpha");
  const b = await dataFolder("beta");
  const c = await dataFolder("gamma");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  const one = openWorkspace("1", { dataRepo: a });
  const two = openWorkspace("2", { dataRepo: b });
  const heard: string[] = [];
  onWorkspaceChange((change, ws, before) => heard.push(`${change} ${ws.id} ${before.dataRepo} -> ${ws.folder.dataRepo}`));

  expect((await api(two, "/api/state", put({ dataRepo: c }))).status).toBe(200);

  expect(two.folder).toEqual({ dataRepo: c });
  expect(one.folder).toEqual({ dataRepo: a });
  expect(heard).toEqual([`folder 2 ${b} -> ${c}`]);
  expect(await featureNames(one)).toEqual(["alpha"]);
  expect(await featureNames(two)).toEqual(["gamma"]);
  // The file names the folder of the window that wrote last — what the web
  // version would open — and every folder picked is on the shared list.
  const file = await readSettings(join(home, "settings.yaml")).catch(() => readSettings(join(root, ".specdriven", "settings.yaml")));
  expect(file.dataRepo).toBe(c);
});

test("a window saving a plain setting does not move another window's folder", async () => {
  const a = await dataFolder("alpha");
  const b = await dataFolder("beta");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  const one = openWorkspace("1", { dataRepo: a });
  const two = openWorkspace("2", { dataRepo: b });

  expect((await api(two, "/api/state", put({ scenarioPreviewLines: 7 }))).status).toBe(200);

  expect(one.folder).toEqual({ dataRepo: a });
  expect(two.folder).toEqual({ dataRepo: b });
  // The setting is everyone's; the folder is each window's own.
  const seenByOne = await runInWorkspace(one, () => readState(root));
  expect(seenByOne.scenarioPreviewLines).toBe(7);
  expect(seenByOne.dataRepo).toBe(a);
  expect(await featureNames(one)).toEqual(["alpha"]);
});

test("a code repository open in one window is that window's alone", async () => {
  const a = await dataFolder("alpha");
  const code = join(root, "code");
  await Bun.write(join(code, "README.md"), "# code\n");
  await writeState({ dataRepo: a, reloadFrequencySeconds: 0 }, root);
  const one = openWorkspace("1", { dataRepo: a });
  const two = openWorkspace("2", { dataRepo: a, openCodeRepo: code });

  const stateTwo = await (await api(two, "/api/state")).json();
  expect(stateTwo.codeRepoMode).toBe(true);
  expect((await api(two, "/api/features")).status).toBe(409);
  const stateOne = await (await api(one, "/api/state")).json();
  expect(stateOne.codeRepoMode).toBe(false);
  expect(await featureNames(one)).toEqual(["alpha"]);
});

test("a closed window drops out of the open set; its record keeps its folder", async () => {
  const one = openWorkspace("1", { dataRepo: "/specs/a" });
  openWorkspace("2", { dataRepo: "/specs/b" });
  const heard: string[] = [];
  onWorkspaceChange((change, ws) => heard.push(`${change} ${ws.id}`));
  closeWorkspace("1");
  expect(workspaces().map((w) => w.id)).toEqual(["2"]);
  expect(one.folder).toEqual({ dataRepo: "/specs/a" });
  expect(heard).toEqual(["closed 1"]);
  expect(() => openWorkspace("2")).toThrow("already open");
});

test("work that waited for a folder's turn resumes as its own window's", async () => {
  // Two windows queue on one lock: whoever releases it resumes the other's
  // fiber, from its own async context (src/server/effect/runtime.ts
  // `promised`). Each must still see itself.
  const one = openWorkspace("1", { dataRepo: "/specs/a" });
  const two = openWorkspace("2", { dataRepo: "/specs/b" });
  const dir = join(root, "locked");
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = runInWorkspace(one, () =>
    localTurn(dir, async () => {
      await held;
      seen.push(`first ${currentWorkspace()?.id}`);
    }),
  );
  const second = runInWorkspace(two, () =>
    localTurn(dir, async () => {
      seen.push(`second ${currentWorkspace()?.id} ${(await readState(root)).dataRepo}`);
    }),
  );
  const third = localTurn(dir, async () => {
    seen.push(`third ${currentWorkspace()?.id ?? "none"}`);
  });
  await Bun.sleep(20);
  release();
  await Promise.all([first, second, third]);
  expect(seen).toEqual(["first 1", "second 2 /specs/b", "third none"]);
});

test("a timer loop started by a window's request works for no window", async () => {
  const one = openWorkspace("1", { dataRepo: "/specs/a" });
  const seen: string[] = [];
  let ticked!: () => void;
  const tick = new Promise<void>((resolve) => (ticked = resolve));
  const scheduler = createReloadScheduler(() => {
    seen.push(currentWorkspace()?.id ?? "none");
    ticked();
  });
  runInWorkspace(one, () => scheduler.set(0.02));
  await tick;
  scheduler.stop();
  expect(seen[0]).toBe("none");
});

test("detached work reads the settings file, not the window's folder", async () => {
  await writeState({ dataRepo: "/specs/file", reloadFrequencySeconds: 0 }, root);
  const one = openWorkspace("1", { dataRepo: "/specs/window" });
  const [inside, outside] = await runInWorkspace(one, async () => [
    (await readState(root)).dataRepo,
    (await detached(() => readState(root))).dataRepo,
  ]);
  expect(inside).toBe("/specs/window");
  expect(outside).toBe("/specs/file");
});

test("a window's folder is a specifications folder, or a code repository open in its place", () => {
  // As the settings name it: blanks are no folder, and nothing else rides along.
  expect(folderOf({ dataRepo: " /specs/a ", openCodeRepo: "  ", reloadFrequencySeconds: 5 } as object)).toEqual({ dataRepo: "/specs/a" });
  expect(folderKey({ dataRepo: "/specs/a" })).toBe("spec:/specs/a");
  // A code repository takes the place of the specifications folder it came from.
  expect(folderKey({ dataRepo: "/specs/a", openCodeRepo: "/code/b" })).toBe("code:/code/b");
  expect(folderKey({})).toBe("");
  expect(sameFolder({ dataRepo: "/specs/a" }, { dataRepo: "/specs/a" })).toBe(true);
  expect(sameFolder({ dataRepo: "/specs/a" }, { dataRepo: "/specs/a", openCodeRepo: "/code/b" })).toBe(false);
  // The shared settings as a window reads them: its folder, everything else as it is.
  const shared: { dataRepo?: string; openCodeRepo?: string; scenarioPreviewLines: number } = {
    dataRepo: "/specs/a",
    openCodeRepo: "/code/b",
    scenarioPreviewLines: 7,
  };
  expect(withFolder(shared, { dataRepo: "/specs/z" })).toEqual({ dataRepo: "/specs/z", scenarioPreviewLines: 7 });
  expect(withFolder(shared, {})).toEqual({ scenarioPreviewLines: 7 });
});

test("a window that opens a folder is found by its id, and is done with the folder it was opened for", () => {
  const blank = openWorkspace("7", {}, { path: "/specs/a", kind: "spec" });
  expect(workspaceById("7")).toBe(blank);
  expect(workspaceById("8")).toBeNull();
  const heard: string[] = [];
  const stop = onWorkspaceChange((change, ws) => heard.push(`${change} ${folderKey(ws.folder)}`));
  setWorkspaceFolder(blank, { dataRepo: "/specs/a" });
  // The same folder again changes nothing, and tells nobody.
  setWorkspaceFolder(blank, { dataRepo: "/specs/a" });
  stop();
  expect(heard).toEqual(["folder spec:/specs/a"]);
  expect(blank.pending).toBeUndefined();
});

test("the folder a window last wrote to the settings file is kept for the next start", async () => {
  expect(settingsFolderWritten()).toBeNull();
  const one = openWorkspace("1", { dataRepo: "/specs/a" });
  await runInWorkspace(one, async () => writeState({ ...(await readState(root)), scenarioPreviewLines: 3 }, root));
  expect(settingsFolderWritten()).toEqual({ dataRepo: "/specs/a" });
  noteSettingsFolder({ dataRepo: "/specs/b", openCodeRepo: "/code/c" });
  expect(settingsFolderWritten()).toEqual({ dataRepo: "/specs/b", openCodeRepo: "/code/c" });
});
