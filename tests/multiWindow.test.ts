// Automates specs/app/multiple-windows.feature.md "Background work" and
// "Closing and restarting": with several windows open, what the app does by
// itself — the sync tick, the live-sync bridge, the coding agent sessions it
// keeps, the folder picker — is done per open folder.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyNetSyncEverywhere,
  applyStartupState,
  handleApi,
  matchApi,
  netSyncFolders,
  reloader,
  stopBackgroundWork,
  syncedOnStart,
} from "../src/server/api";
import { endAllChatSessions, listChatSessions } from "../src/server/agentChat";
import type { ChatSessionMeta } from "../src/server/agentTypes";
import { chooseFolder, setFolderChooser } from "../src/server/folderChooser";
import { setGitEngine } from "../src/server/git";
import { syncDataDir } from "../src/server/reload";
import { agents } from "../src/plugins/host/agents";
import { pluginGate, pluginGateFor, syncPlugins } from "../src/plugins/host/loader";
import type { Disposer } from "../src/plugins/kernel";
import { readState, writeState } from "../src/server/state";
import {
  closeOtherWindows,
  focusWindow,
  openProjects,
  projectDir,
  setWindowCloser,
  setWindowOpener,
  shownElsewhere,
  syncedDir,
  windowShowing,
  workingSessions,
  type WindowOpener,
} from "../src/server/windows";
import { asPlugin, createRouteRegistry, createSyncHooks } from "../src/plugins/host/services";
import { profileRepo } from "../src/plugins/profile";
import {
  closeWorkspace,
  openWorkspace,
  resetWorkspaces,
  runInWorkspace,
  type Workspace,
} from "../src/server/workspace";
import { fakeProvider, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let alpha: string;
let beta: string;
let gamma: string;
let code: string;
let sessions: FakeSession[];
const disposers: Disposer[] = [];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-windows-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map((name) => join(root, name)) as [string, string, string];
  code = join(root, "code");
  for (const dir of [alpha, beta, gamma]) {
    await mkdir(join(dir, "specs"), { recursive: true });
    await writeFile(join(dir, "specs", "one.feature.md"), "# One\n");
  }
  await mkdir(join(code, "src"), { recursive: true });
  await writeState({ dataRepo: alpha, reloadFrequencySeconds: 0 }, root);
  const fake = fakeProvider();
  sessions = fake.sessions;
  disposers.push(agents.register(fake.provider));
});

afterEach(async () => {
  await syncedOnStart();
  await endAllChatSessions();
  await stopBackgroundWork();
  reloader.stop();
  setGitEngine(null);
  resetWorkspaces();
  // No plugin stays mounted for the next test file.
  await syncPlugins({});
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(workspace: Workspace | null, path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    workspace ? { workspace } : {},
  ) as Promise<Response>;
}

async function start(workspace: Workspace): Promise<ChatSessionMeta> {
  const res = await api(workspace, "/api/agent/chat", "POST", { agent: "fake" });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatSessionMeta;
}

async function listed(workspace: Workspace | null): Promise<string[]> {
  const body = (await (await api(workspace, "/api/agent/chat")).json()) as { sessions: ChatSessionMeta[] };
  return body.sessions.map((s) => s.id).sort();
}

/** What a sync tick leaves in every specifications folder it visits. */
const synced = (dir: string) => existsSync(join(dir, "project-settings.json"));

/** Let the work a window's change started in the background come to rest. */
async function settled(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10);
  expect(done()).toBe(true);
}

test("the app's start syncs the folder of every window, and no code repository", async () => {
  openWorkspace("1", { dataRepo: alpha });
  openWorkspace("2", { dataRepo: beta });
  openWorkspace("3", { dataRepo: gamma, openCodeRepo: code });
  await applyStartupState();
  await syncedOnStart();
  expect([synced(alpha), synced(beta)]).toEqual([true, true]);
  // The third window shows a code repository: nothing is synced for it —
  // not the repository, and not the specifications folder it came from.
  expect([synced(gamma), synced(code)]).toEqual([false, false]);
});

test("with no window registered the start syncs the folder the settings file names", async () => {
  await applyStartupState();
  await syncedOnStart();
  expect([synced(alpha), synced(beta)]).toEqual([true, false]);
});

test("a window opened later has its folder synced as it opens", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  await applyStartupState();
  await syncedOnStart();
  expect(synced(beta)).toBe(false);
  const two = openWorkspace("2", { dataRepo: beta });
  // Its first read waits for that pull, as the app's first read does.
  expect((await api(two, "/api/features")).status).toBe(200);
  expect(synced(beta)).toBe(true);
  expect((await api(one, "/api/features")).status).toBe(200);
});

test("the reload tick syncs every open folder", async () => {
  openWorkspace("1", { dataRepo: alpha });
  openWorkspace("2", { dataRepo: beta });
  expect([synced(alpha), synced(beta)]).toEqual([false, false]);
  reloader.set(0.02);
  await settled(() => synced(alpha) && synced(beta));
  reloader.stop();
  expect(synced(gamma)).toBe(false);
  // A tick the stop found running ends by itself: wait it out, so it does
  // not run on into the folders' removal.
  await Bun.sleep(50);
  await Promise.all([syncDataDir(alpha), syncDataDir(beta)]);
});

test("a folder a window leaves is synced once more", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  await writeFile(join(alpha, "specs", "two.feature.md"), "# Two\n");
  expect((await api(one, "/api/state", "PUT", { dataRepo: gamma })).status).toBe(200);
  // The tick absorbs the new file into the folder's documents.
  await settled(() => existsSync(join(alpha, ".specdriven")) && synced(gamma));
});

test("a window lists its own folder's sessions, not another window's", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  const a = await start(one);
  const b = await start(two);
  expect(a.project).toBe(alpha);
  expect(b.project).toBe(beta);
  expect(await listed(one)).toEqual([a.id]);
  expect(await listed(two)).toEqual([b.id]);
  // A page with no window behind it — the web version — lists them all.
  expect(await listed(null)).toEqual([a.id, b.id].sort());
});

test("switching folders in one window ends its old folder's sessions and no other window's", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  const a = await start(one);
  await start(two);
  const res = await api(two, "/api/state", "PUT", { dataRepo: gamma });
  expect(((await res.json()) as { closedSessions?: number }).closedSessions).toBe(1);
  expect(listChatSessions().map((s) => s.id)).toEqual([a.id]);
  expect(sessions.filter((s) => s.closed).length).toBe(1);
});

test("closing a window while another stays ends its folder's sessions", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  const a = await start(one);
  await start(two);
  closeWorkspace(two.id);
  await settled(() => listChatSessions().length === 1);
  expect(listChatSessions().map((s) => s.id)).toEqual([a.id]);
});

test("a window whose folder has a session at work is one to ask about before it closes", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  const blank = openWorkspace("3");
  // A session waiting for its first message is not at work; one given a prompt is.
  await start(one);
  const res = await api(two, "/api/agent/chat", "POST", { agent: "fake", prompt: "Fix the login bug" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as ChatSessionMeta).status).toBe("running");
  expect([workingSessions(one), workingSessions(two), workingSessions(blank)]).toEqual([0, 1, 0]);
});

test("closing the last window leaves its sessions running", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  await applyStartupState();
  const a = await start(one);
  closeWorkspace(one.id);
  await Bun.sleep(30);
  expect(listChatSessions().map((s) => s.id)).toEqual([a.id]);
});

test("each window has its own folder picker, and its own answer", async () => {
  const one = openWorkspace("1");
  const two = openWorkspace("2");
  const answers: ((path: string | null) => void)[] = [];
  const before = setFolderChooser(() => new Promise((resolve) => answers.push(resolve)));
  try {
    const first = runInWorkspace(one, () => chooseFolder());
    const again = runInWorkspace(one, () => chooseFolder());
    const second = runInWorkspace(two, () => chooseFolder());
    // Two dialogs: one per window, however often a window asks.
    expect(answers.length).toBe(2);
    answers[0]!("/picked/in-one");
    answers[1]!("/picked/in-two");
    expect(await Promise.all([first, again, second])).toEqual(["/picked/in-one", "/picked/in-one", "/picked/in-two"]);
  } finally {
    setFolderChooser(before);
  }
});

test("a sync server named in Settings is connected once per open specifications folder", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  openWorkspace("3", { dataRepo: gamma, openCodeRepo: code });
  // Nothing listens there: a bridge is kept, and keeps trying, either way.
  await writeState({ dataRepo: alpha, reloadFrequencySeconds: 0, syncServerUrl: "ws://127.0.0.1:9" }, root);
  await applyNetSyncEverywhere();
  expect(netSyncFolders().sort()).toEqual([alpha, beta]);

  // A window that moves to another folder takes its bridge along.
  expect((await api(two, "/api/state", "PUT", { dataRepo: gamma })).status).toBe(200);
  await settled(() => netSyncFolders().sort().join() === [alpha, gamma].join());

  // Switched off in one window, it is off in all.
  expect((await api(one, "/api/state", "PUT", { syncServerUrl: null })).status).toBe(200);
  expect(netSyncFolders()).toEqual([]);
});

type PluginRow = { id: string; enabled: boolean; active: boolean };

async function plugin(workspace: Workspace, id: string): Promise<PluginRow> {
  const body = (await (await api(workspace, "/api/state")).json()) as { plugins: PluginRow[] };
  return body.plugins.find((p) => p.id === id)!;
}

/** The status a window gets for a path; 404 when no route of its folder's answers. */
async function status(workspace: Workspace, path: string): Promise<number> {
  return ((await api(workspace, path)) as Response | null)?.status ?? 404;
}

test("a plugin switched on for one open folder shows in that folder's window alone", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  expect((await api(one, "/api/state", "PUT", { plugins: { enabled: ["roadmap"] } })).status).toBe(200);

  expect(await plugin(one, "roadmap")).toMatchObject({ enabled: true, active: true });
  expect(await plugin(two, "roadmap")).toMatchObject({ enabled: false, active: false });
  expect(await status(one, "/api/roadmap")).toBe(200);
  expect(await status(two, "/api/roadmap")).toBe(404);
  // The other window's routine reads take nothing away from this one.
  expect(await plugin(two, "roadmap")).toMatchObject({ enabled: false });
  expect(await status(one, "/api/roadmap")).toBe(200);
});

test("a plugin's files are created in the folder that has it on, and in no other", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  expect((await api(one, "/api/state", "PUT", { plugins: { enabled: ["roadmap"] } })).status).toBe(200);
  // A sync of each folder, as the reload tick does it.
  expect((await api(one, "/api/reload", "POST")).status).toBe(200);
  expect((await api(two, "/api/reload", "POST")).status).toBe(200);
  expect(existsSync(join(alpha, "roadmap"))).toBe(true);
  expect(existsSync(join(beta, "roadmap"))).toBe(false);
});

test("a plugin stays loaded while any open folder uses it", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  for (const window of [one, two]) {
    expect((await api(window, "/api/state", "PUT", { plugins: { enabled: ["roadmap"] } })).status).toBe(200);
  }
  expect((await api(one, "/api/state", "PUT", { plugins: { enabled: [] } })).status).toBe(200);
  expect(await status(one, "/api/roadmap")).toBe(404);
  expect(await status(two, "/api/roadmap")).toBe(200);
  // Off in the last folder that had it: gone for good.
  expect((await api(two, "/api/state", "PUT", { plugins: { enabled: [] } })).status).toBe(200);
  expect(matchApi("GET", "/api/roadmap")).toBeNull();
});

test("a window that closes takes the plugins only its folder used with it", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  expect((await api(two, "/api/state", "PUT", { plugins: { enabled: ["roadmap"] } })).status).toBe(200);
  expect(matchApi("GET", "/api/roadmap")).not.toBeNull();
  closeWorkspace(two.id);
  await settled(() => matchApi("GET", "/api/roadmap") === null);
  expect(await plugin(one, "roadmap")).toMatchObject({ enabled: false, active: false });
});

// ---- "Opening a window": the routes the shell answers ------------------------

/** A stand-in for the desktop shell: it records what it was asked to open. */
function fakeShell() {
  const asked: (Parameters<WindowOpener>[0] | "new")[] = [];
  const closedAllBut: (string | null)[] = [];
  const before = setWindowOpener((folder) => {
    asked.push(folder ?? "new");
    return "opened";
  });
  setWindowCloser((except) => closedAllBut.push(except?.id ?? null));
  return {
    asked,
    closedAllBut,
    restore: () => {
      setWindowOpener(before);
      setWindowCloser(null);
    },
  };
}

test("Open in new window asks the shell for a window on the folder, or for one that asks for a folder", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const shell = fakeShell();
  try {
    expect(((await (await api(one, "/api/state")).json()) as { canOpenWindows: boolean }).canOpenWindows).toBe(true);
    let res = await api(one, "/api/windows", "POST", { path: `${beta}/`, kind: "spec" });
    expect([res.status, await res.json()]).toEqual([200, { window: "opened" }]);
    res = await api(one, "/api/windows", "POST", {});
    expect(res.status).toBe(200);
    expect(shell.asked).toEqual([{ path: beta, kind: "spec" }, "new"]);
    expect((await api(one, "/api/windows", "POST", { path: 7 })).status).toBe(400);
    expect((await api(one, "/api/windows", "POST", { path: beta, kind: "other" })).status).toBe(400);
    // Asking opened nothing by itself: this window is where it was.
    expect(one.folder).toEqual({ dataRepo: alpha });
  } finally {
    shell.restore();
  }
});

test("where there is no shell to open a window, the action is not offered and the route is not there", async () => {
  const body = (await (await api(null, "/api/state")).json()) as { canOpenWindows: boolean };
  expect(body.canOpenWindows).toBe(false);
  expect((await api(null, "/api/windows", "POST", { path: beta })).status).toBe(404);
});

test("a window opened for a folder tells its page once, as it boots, and opens it like a folder picked by hand", async () => {
  openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", {}, { path: beta, kind: "spec" });
  type Body = { needsDataRepo: boolean; pendingFolder?: { path: string; kind?: string } };
  // A routine read is not the page's boot: the folder waits for that.
  expect(((await (await api(two, "/api/state")).json()) as Body).pendingFolder).toBeUndefined();
  const boot = (await (await api(two, "/api/state?boot=1")).json()) as Body;
  expect(boot.needsDataRepo).toBe(true);
  expect(boot.pendingFolder).toEqual({ path: beta, kind: "spec" });
  // A reload of the page does not open it a second time.
  expect(((await (await api(two, "/api/state?boot=1")).json()) as Body).pendingFolder).toBeUndefined();
  // The page opens it; the window has its folder, and it is on the recent list.
  expect((await api(two, "/api/state", "PUT", { dataRepo: beta })).status).toBe(200);
  expect(two.folder).toEqual({ dataRepo: beta });
  expect(two.pending).toBeUndefined();
  expect((await readState(root)).recentFolders?.map((f) => f.path)).toContain(beta);
});

test("picking a folder another window shows brings that window forward and switches nothing", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  const three = openWorkspace("3", { dataRepo: gamma, openCodeRepo: code });
  const shell = fakeShell();
  try {
    let res = await api(two, "/api/state", "PUT", { dataRepo: alpha });
    expect([res.status, ((await res.json()) as { openElsewhere?: boolean }).openElsewhere]).toEqual([409, true]);
    expect(shell.asked).toEqual([{ path: alpha, kind: "spec" }]);
    expect([one.folder, two.folder]).toEqual([{ dataRepo: alpha }, { dataRepo: beta }]);
    // A code repository the same.
    res = await api(two, "/api/state", "PUT", { openCodeRepo: code });
    expect(res.status).toBe(409);
    expect(shell.asked.at(-1)).toEqual({ path: code, kind: "code" });
    // The specifications folder a code-repository window came from is not
    // shown by it: another window may open it.
    expect((await api(two, "/api/state", "PUT", { dataRepo: gamma })).status).toBe(200);
    expect(three.folder).toEqual({ dataRepo: gamma, openCodeRepo: code });
    // A window picking its own folder again is not "elsewhere".
    expect((await api(one, "/api/state", "PUT", { dataRepo: alpha })).status).toBe(200);
  } finally {
    shell.restore();
  }
});

test("each window is told which folders on the list the other windows show", async () => {
  const recentFolders = [
    ...[alpha, beta, gamma].map((path) => ({ path, kind: "spec" as const })),
    { path: code, kind: "code" as const },
  ];
  await writeState({ dataRepo: alpha, reloadFrequencySeconds: 0, recentFolders }, root);
  const elsewhere = async (workspace: Workspace | null) => {
    const state = (await (await api(workspace, "/api/state")).json()) as { otherWindowFolders: { path: string; kind: string }[] };
    return state.otherWindowFolders.map((f) => `${f.kind} ${f.path}`).sort();
  };
  // With no window — the web version — and with one, no folder is elsewhere.
  expect(await elsewhere(null)).toEqual([]);
  const one = openWorkspace("1", { dataRepo: alpha });
  expect(await elsewhere(one)).toEqual([]);
  const two = openWorkspace("2", { dataRepo: beta });
  openWorkspace("3", { dataRepo: gamma, openCodeRepo: code });
  // The specifications folder a code-repository window came from is not shown by it.
  expect(await elsewhere(one)).toEqual([`code ${code}`, `spec ${beta}`]);
  expect(await elsewhere(two)).toEqual([`code ${code}`, `spec ${alpha}`]);
  // A window opened for a folder holds it from the start, before its page has opened it.
  openWorkspace("4", {}, { path: gamma, kind: "spec" });
  expect(await elsewhere(one)).toEqual([`code ${code}`, `spec ${beta}`, `spec ${gamma}`]);
  // A window that closes gives its folder back.
  closeWorkspace("2");
  expect(await elsewhere(one)).toEqual([`code ${code}`, `spec ${gamma}`]);
  // The list is kept in the order given, and asked as nobody it names every window's folder.
  expect(shownElsewhere(recentFolders, one).map((f) => f.path)).toEqual([gamma, code]);
  expect(shownElsewhere(recentFolders, null).map((f) => f.path)).toEqual([alpha, gamma, code]);
});

test("a folder open in a window cannot be taken off the recent list", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  openWorkspace("2", { dataRepo: beta });
  await writeState({ dataRepo: alpha, reloadFrequencySeconds: 0, recentFolders: [alpha, beta, gamma].map((path) => ({ path, kind: "spec" as const })) }, root);
  const res = await api(one, "/api/state", "PUT", { forgetDataRepo: beta });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, expect.stringContaining("open in another window")]);
  expect((await api(one, "/api/state", "PUT", { forgetDataRepo: gamma })).status).toBe(200);
  expect((await readState(root)).recentFolders?.map((f) => f.path)).toEqual([alpha, beta]);
});

test("signing out in one window closes the others", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  openWorkspace("2", { dataRepo: beta });
  const shell = fakeShell();
  try {
    const res = await api(one, "/api/logout", "POST");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { needsDataRepo: boolean }).needsDataRepo).toBe(true);
    expect(shell.closedAllBut).toEqual(["1"]);
    // What was saved in every open folder was synced first, while signed in.
    expect([synced(alpha), synced(beta)]).toEqual([true, true]);
    expect(one.folder).toEqual({});
  } finally {
    shell.restore();
  }
});

test("a GitHub url and the folder it is cloned into are the same folder to the windows", () => {
  const repos = join(root, "clones");
  const before = process.env.SPECDRIVEN_REPOS_DIR;
  process.env.SPECDRIVEN_REPOS_DIR = repos;
  try {
    const url = "https://github.com/acme/specs-insurance";
    const one = openWorkspace("1", { dataRepo: url });
    const two = openWorkspace("2", { dataRepo: gamma, openCodeRepo: code });
    const three = openWorkspace("3", {}, { path: beta, kind: "spec" });
    expect(projectDir(one.folder)).toBe(join(repos, "specs-insurance"));
    expect(windowShowing({ path: join(repos, "specs-insurance"), kind: "spec" })).toBe(one);
    expect(windowShowing({ dataRepo: url })).toBe(one);
    // A window about to open a folder already counts as showing it.
    expect(windowShowing({ path: beta, kind: "spec" })).toBe(three);
    // The asking window is never "another window".
    expect(windowShowing({ path: url, kind: "spec" }, one)).toBeNull();
    // A code repository is the window's folder; the specifications folder it came from is not shown.
    expect(windowShowing({ path: code, kind: "code" })).toBe(two);
    expect(windowShowing({ path: gamma, kind: "spec" })).toBeNull();
    expect([syncedDir(one.folder), syncedDir(two.folder), syncedDir(three.folder)]).toEqual([join(repos, "specs-insurance"), null, null]);
    expect(openProjects()).toEqual([join(repos, "specs-insurance"), code]);
  } finally {
    if (before === undefined) delete process.env.SPECDRIVEN_REPOS_DIR;
    else process.env.SPECDRIVEN_REPOS_DIR = before;
  }
});

test("bringing a window forward and closing the others are the shell's to do, and nothing without one", () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", {}, { path: beta, kind: "spec" });
  // No shell: nothing comes forward, and nothing closes.
  expect(focusWindow(one)).toBe(false);
  closeOtherWindows(one);
  const asked: unknown[] = [];
  const closedAllBut: (string | null)[] = [];
  const before = setWindowOpener((folder) => {
    asked.push(folder);
    return "focused";
  });
  setWindowCloser((except) => closedAllBut.push(except?.id ?? null));
  try {
    expect(focusWindow(one)).toBe(true);
    // A window still opening its folder is found by the folder it was opened for.
    expect(focusWindow(two)).toBe(true);
    expect(asked).toEqual([{ path: alpha, kind: "spec" }, { path: beta, kind: "spec" }]);
    closeOtherWindows(one);
    expect(closedAllBut).toEqual(["1"]);
  } finally {
    setWindowOpener(before);
    setWindowCloser(null);
  }
});

test("a plugin's routes and sync hooks are its own, and answer only where it is let through", async () => {
  const routes = createRouteRegistry();
  const hooks = createSyncHooks();
  const ran: string[] = [];
  routes.add("GET", "/api/core", () => new Response("core"));
  hooks.drift(async () => void ran.push("core"));
  asPlugin("roadmap", () => {
    routes.add("GET", "/api/roadmap", () => new Response("roadmap"));
    hooks.drift(async () => void ran.push("roadmap"));
    hooks.moved(async () => void ran.push("roadmap moved"));
  });
  const off = (plugin: string) => plugin !== "roadmap";
  // With no gate everything answers, as it did before there were windows.
  expect(routes.match("GET", "/api/roadmap")).not.toBeNull();
  expect(routes.match("GET", "/api/roadmap", off)).toBeNull();
  // What the app registered itself is never held back.
  expect(routes.match("GET", "/api/core", () => false)).not.toBeNull();
  await hooks.run(alpha, off);
  await hooks.runMoved(alpha, new Map(), off);
  expect(ran).toEqual(["core"]);
  await hooks.run(alpha);
  expect(ran).toEqual(["core", "core", "roadmap"]);
});

test("each window is let through to its own folder's plugins, and a tick to its folder's", async () => {
  const one = openWorkspace("1", { dataRepo: alpha });
  const two = openWorkspace("2", { dataRepo: beta });
  await applyStartupState();
  await syncedOnStart();
  expect((await api(one, "/api/state", "PUT", { plugins: { enabled: ["roadmap"] } })).status).toBe(200);
  // The list is kept under the folder as the settings name it.
  expect(profileRepo({ dataRepo: alpha })).toBe(alpha);
  expect(profileRepo({ dataRepo: alpha, openCodeRepo: code })).toBe(code);
  expect(runInWorkspace(one, () => pluginGate())!("roadmap")).toBe(true);
  expect(runInWorkspace(two, () => pluginGate())!("roadmap")).toBe(false);
  // A caller with no window behind it is held back from nothing.
  expect(pluginGate()).toBeUndefined();
  expect(pluginGateFor(alpha)!("roadmap")).toBe(true);
  expect(pluginGateFor(beta)!("roadmap")).toBe(false);
  // A folder no window shows gets no plugin's files written into it.
  expect(pluginGateFor(gamma)!("roadmap")).toBe(false);
  resetWorkspaces();
  expect(pluginGateFor(alpha)).toBeUndefined();
});
