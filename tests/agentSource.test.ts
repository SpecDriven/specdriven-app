// Checking a code repo's source is up to date before a coding session
// (specs/agents/agent-plugins.feature.md "A coding session should check that
// source is up to date"): the pane reads the branch's state against its remote
// of record and, on request, refreshes it — a merge or a rebase — before the
// agent runs. Real git repos in a temp folder (a local "origin" cloned into a
// working copy): the comparison is git's, not ours to fake. The offline and
// no-git paths go through setSourceGit, which swaps the runner.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { refreshSource, setSourceGit, sourceStatus } from "../src/server/agentSource";
import { run } from "../src/server/run";
import type { RunResult } from "../src/server/run";

let dir: string;
let origin: string;
let work: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * A bare `origin` with one commit on `main`, cloned into a working copy `work`
 * (the repo under test) and a second clone `upstream` used only to advance origin.
 */
async function cloned(): Promise<void> {
  const seed = join(dir, "seed");
  await git(dir, "init", "-q", "-b", "main", "seed");
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-q", "-m", "first");
  await git(dir, "clone", "-q", "--bare", seed, "origin");
  await git(dir, "clone", "-q", "origin", "work");
  await git(dir, "clone", "-q", "origin", "upstream");
  // refreshSource runs its own `git pull` with no `-c user.*`, so a merge or
  // rebase commit needs a repo-local identity. CI git has no global one.
  await git(work, "config", "user.name", "T");
  await git(work, "config", "user.email", "t@example.com");
}

/** Add a commit to origin (via the `upstream` clone) so `work` falls behind. */
async function advanceOrigin(file: string, body: string): Promise<void> {
  const upstream = join(dir, "upstream");
  await writeFile(join(upstream, file), body);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-q", "-m", `change ${file}`);
  await git(upstream, "push", "-q", "origin", "main");
}

beforeEach(async () => {
  // realpath: macOS hands out /var/… for /private/var/…, and git answers with the latter.
  dir = await realpath(await mkdtemp(join(tmpdir(), "specdriven-agent-source-")));
  origin = join(dir, "origin");
  work = join(dir, "work");
});

afterEach(async () => {
  setSourceGit();
  await rm(dir, { recursive: true, force: true });
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

test("a clean branch level with its upstream is online, up to date, not dirty", async () => {
  await cloned();
  const s = await sourceStatus(work);
  expect(s).toMatchObject({
    repo: work,
    branch: "main",
    upstream: "origin/main",
    online: true,
    hasRemote: true,
    detached: false,
    behind: 0,
    ahead: 0,
    dirty: false,
  });
  expect(s.reason).toBeUndefined();
});

test("a branch whose origin advanced is reported behind, after a live fetch", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  await advanceOrigin("b.txt", "b\n");
  const s = await sourceStatus(work);
  expect(s.online).toBe(true);
  expect(s.behind).toBe(2);
  expect(s.ahead).toBe(0);
});

test("a local commit the upstream lacks is reported ahead", async () => {
  await cloned();
  await writeFile(join(work, "local.txt"), "local\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "local work");
  const s = await sourceStatus(work);
  expect(s.ahead).toBe(1);
  expect(s.behind).toBe(0);
});

test("an uncommitted change marks the tree dirty", async () => {
  await cloned();
  await writeFile(join(work, "README.md"), "changed\n");
  const s = await sourceStatus(work);
  expect(s.dirty).toBe(true);
});

test("a branch with no upstream is local only, not an error", async () => {
  await cloned();
  await git(work, "checkout", "-q", "-b", "feature");
  const s = await sourceStatus(work);
  expect(s.hasRemote).toBe(false);
  expect(s.branch).toBe("feature");
  expect(s.reason).toContain("local only");
});

test("a detached HEAD is reported as such, with no branch to refresh", async () => {
  await cloned();
  const head = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "-q", head);
  const s = await sourceStatus(work);
  expect(s.detached).toBe(true);
  expect(s.branch).toBeUndefined();
  expect(s.reason).toContain("detached");
});

test("a folder that is not a git repository is reported, not thrown", async () => {
  const plain = join(dir, "plain");
  await Bun.write(join(plain, ".keep"), "");
  const s = await sourceStatus(plain);
  expect(s.repo).toBeUndefined();
  expect(s.online).toBe(false);
  expect(s.reason).toContain("Not a git repository");
});

test("no git on PATH degrades to a reason, not a crash", async () => {
  setSourceGit(
    async () => ({ exitCode: 1, stdout: "", stderr: "" }) as RunResult,
    () => false,
  );
  const s = await sourceStatus(work);
  expect(s.online).toBe(false);
  expect(s.reason).toContain("git is not on PATH");
});

test("an unreachable remote reports offline but still returns the last-known state", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  // One real fetch so the tracking ref knows about the new commit…
  await git(work, "fetch", "-q", "origin");
  // …then break fetch only, leaving every other git call real.
  const real = (cwd: string, args: string[]) =>
    run("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  setSourceGit(async (cwd, args) => {
    if (args[0] === "fetch") return { exitCode: 128, stdout: "", stderr: "could not read from remote" } as RunResult;
    return real(cwd, args);
  });
  const s = await sourceStatus(work);
  expect(s.online).toBe(false);
  expect(s.hasRemote).toBe(true);
  expect(s.behind).toBe(1);
  expect(s.reason).toContain("last known");
});

test("refreshSource with merge advances a behind branch to its upstream", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  const before = await sourceStatus(work);
  expect(before.behind).toBe(1);

  const res = await refreshSource(work, "merge");
  expect(res.ok).toBe(true);
  expect(res.conflicted).toBe(false);

  const after = await sourceStatus(work);
  expect(after.behind).toBe(0);
  expect(await Bun.file(join(work, "a.txt")).text()).toBe("a\n");
});

test("refreshSource with rebase replays local work on top of the upstream", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  await writeFile(join(work, "local.txt"), "local\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "local work");

  const res = await refreshSource(work, "rebase");
  expect(res.ok).toBe(true);
  expect(res.conflicted).toBe(false);

  const after = await sourceStatus(work);
  expect(after.behind).toBe(0);
  expect(after.ahead).toBe(1);
  // Rebase, not merge: the local commit is the only tip above the upstream and
  // there is no merge commit.
  const log = await git(work, "log", "--oneline", "--merges", "origin/main..HEAD");
  expect(log).toBe("");
});

test("refreshSource refuses a dirty working tree rather than half-applying", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  await writeFile(join(work, "README.md"), "uncommitted\n");

  const res = await refreshSource(work, "merge");
  expect(res.ok).toBe(false);
  expect(res.conflicted).toBe(false);
  expect(res.message).toContain("uncommitted");
  // The behind commit is still not merged.
  expect((await sourceStatus(work)).behind).toBe(1);
});

test("refreshSource reports a conflict instead of leaving a silent half-merge", async () => {
  await cloned();
  // Both sides change the same line of the same file.
  await advanceOrigin("README.md", "from origin\n");
  await writeFile(join(work, "README.md"), "from local\n");
  await git(work, "add", ".");
  await git(work, "commit", "-q", "-m", "local edit");

  const res = await refreshSource(work, "merge");
  expect(res.ok).toBe(false);
  expect(res.conflicted).toBe(true);
  expect(res.message).toContain("conflict");
});

test("GET /api/agent/source returns the branch's status for an absolute path", async () => {
  await cloned();
  const res = await api(`/api/agent/source?path=${encodeURIComponent(work)}`);
  expect(res.status).toBe(200);
  const s = (await res.json()) as Record<string, unknown>;
  expect(s).toMatchObject({ branch: "main", upstream: "origin/main", online: true, behind: 0 });
});

test("GET /api/agent/source rejects a relative path and a missing folder", async () => {
  expect((await api("/api/agent/source?path=not/absolute")).status).toBe(400);
  expect((await api(`/api/agent/source?path=${encodeURIComponent(join(dir, "nope"))}`)).status).toBe(404);
});

test("POST /api/agent/source/refresh runs the merge and reports success", async () => {
  await cloned();
  await advanceOrigin("a.txt", "a\n");
  const res = await api("/api/agent/source/refresh", "POST", { path: work, mode: "merge" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  expect((await sourceStatus(work)).behind).toBe(0);
});

test("POST /api/agent/source/refresh validates the path", async () => {
  expect((await api("/api/agent/source/refresh", "POST", { path: "rel", mode: "merge" })).status).toBe(400);
  expect((await api("/api/agent/source/refresh", "POST", { mode: "merge" })).status).toBe(400);
});
