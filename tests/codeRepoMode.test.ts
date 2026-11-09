// Automates specs/app/code-repo-mode.feature.md on the server: a code
// repository opened directly (PUT /api/state openCodeRepo) takes the place
// of the specifications folder. Nothing syncs or is written into it, the
// specification routes answer that no specifications folder is open, the
// folder dialog's list of code repositories is kept, a specifications
// folder takes its place again, and the coding agent pane works in it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, NO_SPECS_FOLDER, reloader } from "../src/server/api";
import { endAllChatSessions } from "../src/server/agentChat";
import type { ChatSessionMeta } from "../src/server/agentTypes";
import { reloadData } from "../src/server/reload";
import { run } from "../src/server/run";
import {
  codeRepoMode,
  forgetCodeRepo,
  forgetDataRepo,
  mergeRecentFolders,
  needsDataRepo,
  needsFolder,
  readState,
  recentCodeRepos,
  rememberCodeRepo,
  rememberDataRepo,
  normalizeOpenedAt,
  openFolder,
  recentDataRepos,
  specsOpen,
  writeState,
  type SpecDrivenState,
} from "../src/server/state";
import { readProfile, writeProfile } from "../src/plugins/profile";
import { profileManifests } from "../src/plugins/builtin/manifests";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { fakeProvider, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let data: string;
let code: string;
let other: string;
let sessions: FakeSession[];
const disposers: Disposer[] = [];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

beforeEach(async () => {
  // realpath: macOS hands out /var/… for /private/var/….
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-coderepo-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  data = join(root, "data");
  code = join(root, "code");
  other = join(root, "other");
  await mkdir(join(data, "specs"), { recursive: true });
  await writeFile(join(data, "README.md"), "# Specs\n");
  // The developer's repository: one commit, one uncommitted change.
  await mkdir(join(code, "src"), { recursive: true });
  await git(code, "init", "-q", "-b", "main");
  await writeFile(join(code, "src", "index.ts"), "export {};\n");
  await git(code, "add", ".");
  await git(code, "commit", "-q", "-m", "first");
  await writeFile(join(code, "src", "index.ts"), "export const x = 1;\n");
  await mkdir(other, { recursive: true });
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  const fake = fakeProvider();
  sessions = fake.sessions;
  disposers.push(agents.register(fake.provider));
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
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

async function openCode(dir = code): Promise<Record<string, unknown>> {
  const res = await api("/api/state", "PUT", { openCodeRepo: dir });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// --- The settings ---------------------------------------------------------------

test("an open code repository takes the place of the specifications folder", () => {
  const specs: SpecDrivenState = { dataRepo: "/s" };
  expect([codeRepoMode(specs), specsOpen(specs), needsDataRepo(specs), needsFolder(specs)]).toEqual([
    false,
    true,
    false,
    false,
  ]);
  const both: SpecDrivenState = { dataRepo: "/s", openCodeRepo: "/c" };
  expect([codeRepoMode(both), specsOpen(both), needsDataRepo(both), needsFolder(both)]).toEqual([
    true,
    false,
    true,
    false,
  ]);
  const none: SpecDrivenState = {};
  expect([codeRepoMode(none), specsOpen(none), needsDataRepo(none), needsFolder(none)]).toEqual([
    false,
    false,
    true,
    true,
  ]);
});

test("the code repositories list keeps the open one first, each once, and forgets on request", () => {
  const state: SpecDrivenState = { openCodeRepo: "/c/b" };
  rememberCodeRepo(state, "/c/a");
  rememberCodeRepo(state, "/c/b/");
  expect(recentCodeRepos(state)).toEqual(["/c/b", "/c/a"]);
  expect(forgetCodeRepo(state, "/c/a")).toBe(true);
  expect(forgetCodeRepo(state, "/c/a")).toBe(false);
  expect(recentCodeRepos(state)).toEqual(["/c/b"]);
});

// One folder list (specs/app/spec-folders.feature.md "Manage specification
// folders"): spec folders and code repositories together, newest first.
test("spec folders and code repositories make one list, the open one first, then newest first", () => {
  const state: SpecDrivenState = {};
  rememberDataRepo(state, "/s/old", 1);
  rememberCodeRepo(state, "/c/a", 2);
  rememberDataRepo(state, "/s/new", 3);
  rememberCodeRepo(state, "/c/b", 4);
  state.openCodeRepo = "/c/a";
  const merged = mergeRecentFolders(recentDataRepos(state), recentCodeRepos(state), state.recentFolderOpenedAt, openFolder(state));
  expect(merged).toEqual([
    { path: "/c/a", kind: "code" },
    { path: "/c/b", kind: "code" },
    { path: "/s/new", kind: "spec" },
    { path: "/s/old", kind: "spec" },
  ]);
  // Reopening moves an entry up; the same path may be on it once per kind.
  rememberDataRepo(state, "/s/old", 5);
  rememberDataRepo(state, "/c/b", 6);
  delete state.openCodeRepo;
  state.dataRepo = "/c/b";
  expect(mergeRecentFolders(recentDataRepos(state), recentCodeRepos(state), state.recentFolderOpenedAt, openFolder(state))).toEqual([
    { path: "/c/b", kind: "spec" },
    { path: "/s/old", kind: "spec" },
    { path: "/c/b", kind: "code" },
    { path: "/s/new", kind: "spec" },
    { path: "/c/a", kind: "code" },
  ]);
});

test("entries saved before open times keep their order, spec folders then code repositories", () => {
  expect(mergeRecentFolders(["/s/a", "/s/b"], ["/c/a"], undefined, null)).toEqual([
    { path: "/s/a", kind: "spec" },
    { path: "/s/b", kind: "spec" },
    { path: "/c/a", kind: "code" },
  ]);
  // A timed entry goes ahead of the untimed ones.
  expect(mergeRecentFolders(["/s/a", "/s/b"], ["/c/a"], { code: { "/c/a": 1 } }, null)).toEqual([
    { path: "/c/a", kind: "code" },
    { path: "/s/a", kind: "spec" },
    { path: "/s/b", kind: "spec" },
  ]);
});

test("forgetting a folder drops its open time, and a stored map keeps only times", () => {
  const state: SpecDrivenState = {};
  rememberDataRepo(state, "/s/a", 1);
  rememberCodeRepo(state, "/c/a", 2);
  forgetDataRepo(state, "/s/a");
  forgetCodeRepo(state, "/c/a");
  expect(state.recentFolderOpenedAt).toEqual({ spec: {}, code: {} });
  expect(normalizeOpenedAt({ spec: { "/s/a/": 1, "/s/b": "x" }, code: null, other: { "/o": 1 } })).toEqual({
    spec: { "/s/a": 1 },
  });
});

test("a code repository keeps a plugin list of its own", () => {
  const state: Record<string, unknown> = { dataRepo: "/s" };
  writeProfile(state, ["roadmap"], profileManifests);
  state.openCodeRepo = "/c";
  writeProfile(state, ["agent-claude"], profileManifests);
  expect(readProfile(state, profileManifests).enabled).toEqual(["agent-claude"]);
  delete state.openCodeRepo;
  expect(readProfile(state, profileManifests).enabled).toEqual(["roadmap"]);
});

// --- Opening one ----------------------------------------------------------------

test("PUT /api/state openCodeRepo opens the folder and GET /api/state reports the mode", async () => {
  const put = await openCode();
  expect(put.codeRepoMode).toBe(true);
  const state = (await (await api("/api/state")).json()) as Record<string, unknown>;
  expect(state.codeRepoMode).toBe(true);
  expect(state.codeRepoDir).toBe(code);
  expect(state.recentCodeRepos).toEqual([code]);
  expect(state.needsFolder).toBe(false);
  expect(state.needsDataRepo).toBe(true);
  expect(state.dataDir).toBeNull();
  expect(state.canOpenCodeRepo).toBe(true);
  // The last specifications folder is kept for the way back.
  expect(state.dataRepo).toBe(data);
  const stored = await readState(root);
  expect(stored.openCodeRepo).toBe(code);
  expect(stored.recentCodeRepos).toEqual([code]);
});

test("a code repository must be an existing folder named by its absolute path", async () => {
  const relative = await api("/api/state", "PUT", { openCodeRepo: "code" });
  expect(relative.status).toBe(400);
  const missing = await api("/api/state", "PUT", { openCodeRepo: join(root, "nope") });
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { missing?: boolean }).missing).toBe(true);
  const both = await api("/api/state", "PUT", { openCodeRepo: code, dataRepo: data });
  expect(both.status).toBe(400);
  expect((await readState(root)).openCodeRepo).toBeUndefined();
});

test("the demo and the hosted app open no code repository", async () => {
  process.env.DEMO_MODE = "1";
  expect((await api("/api/state", "PUT", { openCodeRepo: code })).status).toBe(403);
  expect((await api("/api/state", "PUT", { forgetCodeRepo: code })).status).toBe(403);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await api("/api/state", "PUT", { openCodeRepo: code })).status).toBe(403);
  delete process.env.SPECDRIVEN_HOSTED;
  expect((await readState(root)).openCodeRepo).toBeUndefined();
});

// --- No git, no specs -----------------------------------------------------------

test("the specification routes answer that no specifications folder is open", async () => {
  await openCode();
  for (const path of ["/api/readme", "/api/features", "/api/project-settings"]) {
    const res = await api(path);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_SPECS_FOLDER);
  }
});

test("a sync runs no git in the code repository and writes nothing into it", async () => {
  await openCode();
  const head = await git(code, "rev-parse", "HEAD");
  const status = await git(code, "status", "--porcelain");
  expect(await reloadData(root)).toBe("a code repository is open; skipped sync");
  const res = await api("/api/reload", "POST");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { message: string }).message).toBe("a code repository is open; skipped sync");
  expect(await git(code, "rev-parse", "HEAD")).toBe(head);
  expect(await git(code, "status", "--porcelain")).toBe(status);
  expect((await readdir(code)).sort()).toEqual([".git", "src"]);
});

// --- Switching ------------------------------------------------------------------

test("a specifications folder takes the place of the code repository, which stays on the list", async () => {
  await openCode();
  const res = await api("/api/state", "PUT", { dataRepo: data });
  expect(res.status).toBe(200);
  const state = (await res.json()) as Record<string, unknown>;
  expect(state.codeRepoMode).toBe(false);
  expect(state.codeRepoDir).toBeNull();
  expect(state.needsDataRepo).toBe(false);
  expect(state.recentCodeRepos).toEqual([code]);
  expect((await api("/api/readme")).status).toBe(200);
});

test("GET /api/state lists spec folders and code repositories together, newest first", async () => {
  await openCode();
  await openCode(other);
  expect((await api("/api/state", "PUT", { dataRepo: data })).status).toBe(200);
  let state = (await (await api("/api/state")).json()) as Record<string, unknown>;
  expect(state.recentFolders).toEqual([
    { path: data, kind: "spec" },
    { path: other, kind: "code" },
    { path: code, kind: "code" },
  ]);
  state = await openCode();
  expect(state.recentFolders).toEqual([
    { path: code, kind: "code" },
    { path: data, kind: "spec" },
    { path: other, kind: "code" },
  ]);
  // The times are kept in the settings file, so the order survives a restart.
  const stored = await readState(root);
  expect(Object.keys(stored.recentFolderOpenedAt?.code ?? {}).sort()).toEqual([code, other].sort());
  expect(Object.keys(stored.recentFolderOpenedAt?.spec ?? {})).toEqual([data]);
});

test("another code repository can be opened from the open one, and the old one forgotten", async () => {
  await openCode();
  const state = await openCode(other);
  expect(state.codeRepoDir).toBe(other);
  expect(state.recentCodeRepos).toEqual([other, code]);
  const open = await api("/api/state", "PUT", { forgetCodeRepo: other });
  expect(open.status).toBe(409);
  const forgot = await api("/api/state", "PUT", { forgetCodeRepo: code });
  expect(forgot.status).toBe(200);
  expect(((await forgot.json()) as Record<string, unknown>).recentCodeRepos).toEqual([other]);
});

test("with a code repository open, the last specifications folder can be removed from the list", async () => {
  await api("/api/state", "PUT", { dataRepo: data });
  await openCode();
  const res = await api("/api/state", "PUT", { forgetDataRepo: data });
  expect(res.status).toBe(200);
  const state = (await res.json()) as Record<string, unknown>;
  expect(state.recentDataRepos).toEqual([]);
  expect(state.dataRepo).toBeNull();
  expect(state.codeRepoMode).toBe(true);
});

// --- The coding agent -----------------------------------------------------------

test("a coding agent session runs in the code repository, with no specifications folder behind it", async () => {
  await openCode();
  const res = await api("/api/agent/chat", "POST", { name: "Fix the login bug", agent: "fake" });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  expect(meta.cwd).toBe(code);
  expect(meta.dataRepo).toBe(code);
  expect(meta.codeRepo).toBeUndefined();
  expect(sessions[0]!.opts.cwd).toBe(code);
  expect(sessions[0]!.opts.codeRepo).toBeUndefined();
});

test("a folder the pane picks inside the code repository is where the session runs", async () => {
  await openCode();
  const res = await api("/api/agent/chat", "POST", { agent: "fake", cwd: join(code, "src") });
  expect(res.status).toBe(200);
  expect(((await res.json()) as ChatSessionMeta).cwd).toBe(join(code, "src"));
});

test("a code gen session from the spec dialog needs a specifications folder", async () => {
  await openCode();
  const res = await api("/api/agent/session", "POST", { files: ["specs/a.feature.md"] });
  expect(res.status).toBe(409);
});
