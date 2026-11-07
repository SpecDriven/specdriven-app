// Automates specs/agents/agent-pane.feature.md "A worktree session opens in a
// Ghostty shell": with "Open worktrees in Ghostty" on in Settings → Workflow,
// POST /api/agent/chat/:id/ghostty opens Ghostty in the folder the session's
// agent works in — for a worktree session, its place inside the worktree. The
// setting defaults to OFF and lives in the settings file like the others.
// Ghostty is never found or started for real here: the seams in
// src/server/ghostty.ts stand in for the probe and the launcher.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import { endAllChatSessions } from "../src/server/agentChat";
import type { ChatSessionMeta } from "../src/server/agentTypes";
import { setWorktreeGit } from "../src/server/agentWorktree";
import {
  findGhostty,
  GHOSTTY_MISSING,
  ghosttyCommand,
  setGhosttyFinder,
  setGhosttyOpener,
  type GhosttyLauncher,
} from "../src/server/ghostty";
import { run } from "../src/server/run";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { normalizeGhostty, readState, writeState } from "../src/server/state";
import { fakeProvider } from "./helpers/fakeAgent";

const APP: GhosttyLauncher = { kind: "app", path: "/Applications/Ghostty.app" };

let root: string;
let data: string;
let code: string;
let opened: { launcher: GhosttyLauncher; folder: string }[];
const disposers: Disposer[] = [];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};

async function git(dir: string, ...args: string[]): Promise<void> {
  const res = await run("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

beforeEach(async () => {
  // realpath: macOS hands out /var/… for /private/var/…, and git answers with the latter.
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-ghostty-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  data = join(root, "data");
  code = join(root, "code");
  await writeState({ dataRepo: data, ghostty: true }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
  // A repo with one commit on main, a folder inside it.
  await mkdir(join(code, "app"), { recursive: true });
  await git(code, "init", "-q", "-b", "main");
  await writeFile(join(code, "app", "index.ts"), "export {};\n");
  await git(code, "add", ".");
  await git(code, "commit", "-q", "-m", "first");
  disposers.push(agents.register(fakeProvider().provider));
  opened = [];
  setGhosttyFinder(() => APP);
  setGhosttyOpener(async (launcher, folder) => {
    opened.push({ launcher, folder });
  });
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
  setWorktreeGit();
  setGhosttyFinder(null);
  setGhosttyOpener(null);
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

async function start(body: Record<string, unknown>): Promise<ChatSessionMeta> {
  const res = await api("/api/agent/chat", "POST", { name: "Fix the login bug", agent: "fake", ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatSessionMeta;
}

// --- Finding Ghostty ------------------------------------------------------------

test("Ghostty is the app bundle on a Mac, the binary on PATH elsewhere, and nothing on Windows", () => {
  const none = () => null;
  const only = (path: string) => (p: string) => p === path;
  expect(findGhostty("darwin", only("/Applications/Ghostty.app"), "/Users/u", none)).toEqual({
    kind: "app",
    path: "/Applications/Ghostty.app",
  });
  expect(findGhostty("darwin", only("/Users/u/Applications/Ghostty.app"), "/Users/u", none)).toEqual({
    kind: "app",
    path: "/Users/u/Applications/Ghostty.app",
  });
  // The macOS binary on PATH cannot open a window: no bundle, no Ghostty.
  expect(findGhostty("darwin", () => false, "/Users/u", () => "/opt/homebrew/bin/ghostty")).toBeNull();
  expect(findGhostty("linux", () => false, "/home/u", (bin) => (bin === "ghostty" ? "/usr/bin/ghostty" : null))).toEqual(
    { kind: "bin", path: "/usr/bin/ghostty" },
  );
  expect(findGhostty("linux", () => true, "/home/u", none)).toBeNull();
  expect(findGhostty("win32", () => true, "C:\\Users\\u", () => "C:\\ghostty.exe")).toBeNull();
});

test("the folder is handed over as one argument, never through a shell", () => {
  const folder = "/w/my code; rm -rf ~";
  expect(ghosttyCommand(APP, folder)).toEqual({ cmd: "open", args: ["-a", "/Applications/Ghostty.app", folder] });
  expect(ghosttyCommand({ kind: "bin", path: "/usr/bin/ghostty" }, folder)).toEqual({
    cmd: "/usr/bin/ghostty",
    args: [`--working-directory=${folder}`],
  });
});

// --- The setting ----------------------------------------------------------------

test("the Ghostty setting defaults to OFF and only an explicit true turns it on", () => {
  expect(normalizeGhostty(undefined)).toBe(false);
  expect(normalizeGhostty("yes")).toBe(false);
  expect(normalizeGhostty(false)).toBe(false);
  expect(normalizeGhostty(true)).toBe(true);
});

test("the state reports the Ghostty setting and whether Ghostty is installed", async () => {
  const on = (await (await api("/api/state")).json()) as Record<string, unknown>;
  expect(on.ghostty).toBe(true);
  expect(on.canOpenGhostty).toBe(true);
  setGhosttyFinder(() => null);
  const off = (await (await api("/api/state")).json()) as Record<string, unknown>;
  expect(off.canOpenGhostty).toBe(false);
});

test("the Ghostty setting round-trips through the settings file, OFF stored as an absent key", async () => {
  const off = await api("/api/state", "PUT", { ghostty: false });
  expect(off.status).toBe(200);
  expect(((await off.json()) as { ghostty: boolean }).ghostty).toBe(false);
  expect((await readState(root)).ghostty).toBeUndefined();
  const on = await api("/api/state", "PUT", { ghostty: true });
  expect(((await on.json()) as { ghostty: boolean }).ghostty).toBe(true);
  expect((await readState(root)).ghostty).toBe(true);
  const bad = await api("/api/state", "PUT", { ghostty: "on" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("ghostty must be a boolean");
});

test("the demo and the hosted app cannot turn Ghostty on, nor open it", async () => {
  const meta = await start({ cwd: code, worktree: true });
  await writeState({ dataRepo: data }, root);
  process.env.DEMO_MODE = "1";
  expect((await api("/api/state", "PUT", { ghostty: true })).status).toBe(403);
  expect((await api(`/api/agent/chat/${meta.id}/ghostty`, "POST")).status).toBe(403);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await api("/api/state", "PUT", { ghostty: true })).status).toBe(403);
  expect((await api(`/api/agent/chat/${meta.id}/ghostty`, "POST")).status).toBe(403);
  delete process.env.SPECDRIVEN_HOSTED;
  expect((await readState(root)).ghostty).toBeUndefined();
  expect(opened).toHaveLength(0);
});

// --- The route ------------------------------------------------------------------

test("the open-in-Ghostty route is a POST on a session", () => {
  expect(matchApi("POST", "/api/agent/chat/abc/ghostty")).not.toBeNull();
  expect(matchApi("GET", "/api/agent/chat/abc/ghostty")).toBeNull();
});

test("a worktree session opens Ghostty in the folder its agent works in, inside the worktree", async () => {
  const meta = await start({ cwd: join(code, "app"), worktree: true });
  const res = await api(`/api/agent/chat/${meta.id}/ghostty`, "POST");
  expect(res.status).toBe(200);
  expect(meta.worktree!.cwd).toBe(join(meta.worktree!.path, "app"));
  expect(await res.json()).toEqual({ folder: meta.worktree!.cwd });
  expect(opened).toEqual([{ launcher: APP, folder: meta.worktree!.cwd }]);
});

test("with the setting off, Ghostty missing or the folder gone, nothing opens and the reason is said", async () => {
  const meta = await start({ cwd: code, worktree: true });
  const path = `/api/agent/chat/${meta.id}/ghostty`;

  setGhosttyFinder(() => null);
  const missing = await api(path, "POST");
  expect(missing.status).toBe(502);
  expect((await missing.json()).error).toBe(GHOSTTY_MISSING);
  setGhosttyFinder(() => APP);

  await rm(meta.cwd, { recursive: true, force: true });
  const gone = await api(path, "POST");
  expect(gone.status).toBe(404);
  expect((await gone.json()).error).toBe(`Folder not found: ${meta.cwd}`);

  await writeState({ dataRepo: data }, root);
  const off = await api(path, "POST");
  expect(off.status).toBe(409);
  expect((await off.json()).error).toContain("off in Settings");

  const unknown = await api("/api/agent/chat/no-such-session/ghostty", "POST");
  expect(unknown.status).toBe(404);
  expect(opened).toHaveLength(0);
});

test("a launcher that fails is reported, not swallowed", async () => {
  const meta = await start({ cwd: code, worktree: true });
  setGhosttyOpener(async () => {
    throw new Error("Unable to find application named 'Ghostty'");
  });
  const res = await api(`/api/agent/chat/${meta.id}/ghostty`, "POST");
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("Could not open Ghostty: Unable to find application named 'Ghostty'");
});
