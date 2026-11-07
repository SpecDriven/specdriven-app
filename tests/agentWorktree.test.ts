// A coding agent session in a git worktree of its own (specs/agents/
// agent-pane.feature.md "A session can run in its own git worktree"): the
// engine (src/server/agentChat.ts, src/server/agentWorktree.ts) makes the
// worktree before the agent starts and hands it the path, so any provider —
// here the fake from tests/helpers/fakeAgent.ts — works in it unaware.
// Real git repos in a temp folder: worktrees are git's, not ours to fake.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { endAllChatSessions, getChatSession } from "../src/server/agentChat";
import type { ChatSessionMeta } from "../src/server/agentTypes";
import { setWorktreeGit, worktreeSlug } from "../src/server/agentWorktree";
import { run } from "../src/server/run";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { fakeProvider } from "./helpers/fakeAgent";

let root: string;
let data: string;
let code: string;
const disposers: Disposer[] = [];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

function register(options: Parameters<typeof fakeProvider>[0] = {}) {
  const fake = fakeProvider(options);
  disposers.push(agents.register(fake.provider));
  return fake;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A repo with one commit on `main`. */
async function repo(dir: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "hello\n");
  await writeFile(join(dir, "src", "app.ts"), "export {};\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "first");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  // realpath: macOS hands out /var/… for /private/var/…, and git answers with the latter.
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-agent-worktree-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  data = join(root, "data");
  code = join(root, "code");
  await writeState({ dataRepo: data }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
  await repo(code);
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
  setWorktreeGit();
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
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

const worktreesDir = () => join(root, ".specdriven", "worktrees");

test("a session started with a worktree works in one of its own, on a new branch off the folder's", async () => {
  const fake = register();
  const meta = await start({ cwd: code, worktree: true });
  const wt = meta.worktree!;
  expect(wt).toMatchObject({ folder: code, repo: code, base: "main" });
  expect(wt.branch).toMatch(/^specdriven\/fix-the-login-bug-[0-9a-f]{6}$/);
  expect(wt.path.startsWith(worktreesDir() + "/code-")).toBe(true);
  expect(wt.cwd).toBe(wt.path);
  expect(meta.cwd).toBe(wt.path);
  // The agent is handed the worktree where the code repo stood; the data repo rides along.
  expect(fake.sessions[0]!.opts).toMatchObject({ cwd: wt.path, codeRepo: wt.path, dataRepo: data });
  // A real checkout of the folder's HEAD, on the session's branch.
  expect(await readFile(join(wt.path, "README.md"), "utf8")).toBe("hello\n");
  expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  expect(await git(code, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  // The record keeps it.
  const record = JSON.parse(await readFile(join(root, ".specdriven", "sessions", meta.id, "session.json"), "utf8"));
  expect(record.worktree).toEqual(wt);
  // Without one, the session works in the folder itself.
  const plain = await start({ cwd: code });
  expect(plain.worktree).toBeUndefined();
  expect(plain.cwd).toBe(code);
});

test("a folder inside the repo keeps its place inside the worktree, and two sessions never share one", async () => {
  register();
  const one = await start({ cwd: join(code, "src"), worktree: true });
  const two = await start({ cwd: join(code, "src"), worktree: true });
  expect(one.worktree!.repo).toBe(code);
  expect(one.worktree!.folder).toBe(join(code, "src"));
  expect(one.cwd).toBe(join(one.worktree!.path, "src"));
  expect(await readFile(join(one.cwd, "app.ts"), "utf8")).toBe("export {};\n");
  expect(two.worktree!.path).not.toBe(one.worktree!.path);
  expect(two.worktree!.branch).not.toBe(one.worktree!.branch);
});

test("a worktree of the data repo has no second folder beside it", async () => {
  const fake = register();
  await repo(data);
  const meta = await start({ worktree: true });
  expect(meta.worktree!.folder).toBe(data);
  expect(meta.codeRepo).toBeUndefined();
  expect(fake.sessions[0]!.opts.codeRepo).toBeUndefined();
  expect(fake.sessions[0]!.opts.cwd).toBe(meta.worktree!.path);
});

test("a folder that cannot have a worktree is refused, and nothing is left behind", async () => {
  const fake = register();
  // No repo at all.
  let res = await api("/api/agent/chat", "POST", { agent: "fake", cwd: data, worktree: true });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("Not a git repository");
  // A repo with no commit yet.
  const empty = join(root, "empty");
  await mkdir(empty);
  await git(empty, "init", "-q");
  res = await api("/api/agent/chat", "POST", { agent: "fake", cwd: empty, worktree: true });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("no commit");
  // No git on PATH.
  setWorktreeGit(undefined, () => false);
  res = await api("/api/agent/chat", "POST", { agent: "fake", cwd: code, worktree: true });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("git on PATH");
  // Not a boolean.
  res = await api("/api/agent/chat", "POST", { agent: "fake", cwd: code, worktree: "yes" });
  expect(res.status).toBe(400);
  expect(fake.sessions).toHaveLength(0);
  expect(await exists(worktreesDir())).toBe(false);
});

test("a worktree whose agent cannot start goes again, branch and all", async () => {
  register({ startError: new Error("no CLI") });
  const res = await api("/api/agent/chat", "POST", { name: "Doomed", agent: "fake", cwd: code, worktree: true });
  expect(res.status).toBe(502);
  expect(await git(code, "worktree", "list", "--porcelain")).not.toContain("doomed");
  expect(await git(code, "branch", "--list", "specdriven/*")).toBe("");
});

test("closing a session removes its worktree when nothing is uncommitted, keeps it otherwise, and keeps the branch", async () => {
  register();
  // Committed work: the folder goes, the branch and its commit stay.
  const clean = await start({ cwd: code, worktree: true });
  const wt = clean.worktree!;
  await writeFile(join(wt.path, "fix.ts"), "export const fixed = true;\n");
  await git(wt.path, "add", ".");
  await git(wt.path, "commit", "-q", "-m", "fix");
  let res = await api(`/api/agent/chat/${clean.id}`, "DELETE");
  expect(await res.json()).toEqual({ ok: true, worktree: "removed" });
  expect(await exists(wt.path)).toBe(false);
  expect(await git(code, "log", "--format=%s", wt.branch)).toBe("fix\nfirst");
  expect(getChatSession(clean.id)).toBeNull();

  // Uncommitted work: the worktree stays for the user to look at.
  const dirty = await start({ cwd: code, worktree: true });
  await writeFile(join(dirty.worktree!.path, "wip.ts"), "// half done\n");
  res = await api(`/api/agent/chat/${dirty.id}`, "DELETE");
  expect(await res.json()).toEqual({ ok: true, worktree: "kept" });
  expect(await exists(join(dirty.worktree!.path, "wip.ts"))).toBe(true);

  // Removed by hand already: nothing to do, and git forgets it.
  const gone = await start({ cwd: code, worktree: true });
  await rm(gone.worktree!.path, { recursive: true, force: true });
  res = await api(`/api/agent/chat/${gone.id}`, "DELETE");
  expect(await res.json()).toEqual({ ok: true, worktree: "gone" });
  expect(await git(code, "worktree", "list")).not.toContain(gone.worktree!.path);

  // A session with no worktree says nothing of one.
  const plain = await start({ cwd: code });
  res = await api(`/api/agent/chat/${plain.id}`, "DELETE");
  expect(await res.json()).toEqual({ ok: true });
});

test("the pane asks whether a folder can have a worktree, and on which branch", async () => {
  const ask = async (path: string) => {
    const res = await api(`/api/agent/folder?path=${encodeURIComponent(path)}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  expect(await ask(code)).toEqual({ status: 200, body: { canWorktree: true, repo: code, branch: "main" } });
  expect(await ask(join(code, "src"))).toEqual({ status: 200, body: { canWorktree: true, repo: code, branch: "main" } });
  expect(await ask(data)).toEqual({ status: 200, body: { canWorktree: false, reason: "Not a git repository" } });
  expect((await ask("relative/path")).status).toBe(400);
  expect((await ask(join(root, "nowhere"))).status).toBe(404);
});

test("a session name becomes a branch-safe slug", () => {
  expect(worktreeSlug("Fix the login bug!")).toBe("fix-the-login-bug");
  expect(worktreeSlug("Café — résumé")).toBe("cafe-resume");
  expect(worktreeSlug("   ")).toBe("session");
  expect(worktreeSlug("../../etc/passwd")).toBe("etc-passwd");
  expect(worktreeSlug("a".repeat(100))).toHaveLength(40);
});
