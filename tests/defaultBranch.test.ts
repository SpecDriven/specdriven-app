// A repository's default branch (src/server/defaultBranch.ts), which is not
// always `main` (specs/agents/agent-pane.feature.md "A coding session is
// told the repository's default branch"). Real git repos in a temp folder.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBranch, forgetUnansweredRemotes, parseSymrefHead } from "../src/server/defaultBranch";
import type { BranchGit } from "../src/server/defaultBranch";
import { run } from "../src/server/run";

let root: string;
const calls: string[][] = [];

const runGit: BranchGit = (cwd, args, opts) => {
  calls.push(args);
  return run("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A repo with one commit on `branch`. */
async function repo(name: string, branch: string): Promise<string> {
  const dir = join(root, name);
  await git(root, "init", "-q", "-b", branch, dir);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** A bare remote whose HEAD is `branch`, with `branch` (and `extra`) pushed. */
async function remote(name: string, branch: string, extra: string[] = []): Promise<string> {
  const src = await repo(`${name}-src`, branch);
  for (const b of extra) await git(src, "branch", b);
  const bare = join(root, `${name}.git`);
  await git(root, "clone", "-q", "--bare", src, bare);
  return bare;
}

/** A repo with `url` added by hand as `name` and fetched: no `<name>/HEAD`, as a clone would have. */
async function handAdded(url: string, name = "origin"): Promise<string> {
  const dir = await repo(`hand-${name}-${Math.random().toString(36).slice(2, 8)}`, "work");
  await git(dir, "remote", "add", name, url);
  await git(dir, "fetch", "-q", name);
  // git ≥ 2.48 records the remote's HEAD on fetch; take it away to stand for an older git.
  await run("git", ["-C", dir, "symbolic-ref", "--delete", `refs/remotes/${name}/HEAD`]);
  return dir;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-default-branch-")));
  calls.length = 0;
  forgetUnansweredRemotes();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a clone knows its remote's default branch by whatever name it has, without asking the remote", async () => {
  const bare = await remote("trunk", "trunk", ["main"]);
  const clone = join(root, "clone");
  await git(root, "clone", "-q", bare, clone);
  await git(clone, "checkout", "-q", "-b", "feature");
  expect(await defaultBranch(runGit, clone)).toEqual({ branch: "trunk", remote: "origin", source: "remote-head" });
  expect(calls.some((a) => a[0] === "ls-remote")).toBe(false);
});

test("a remote added by hand is asked, and its answer recorded as a clone would have", async () => {
  const bare = await remote("develop", "develop", ["main"]);
  const dir = await handAdded(bare);
  expect(await git(dir, "branch", "-r")).not.toContain("origin/HEAD");
  // Not `main`, though origin has one: origin's HEAD says develop.
  expect(await defaultBranch(runGit, dir)).toEqual({ branch: "develop", remote: "origin", source: "remote" });
  expect(await git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/develop");
  // From then on it is known locally.
  calls.length = 0;
  expect(await defaultBranch(runGit, dir)).toEqual({ branch: "develop", remote: "origin", source: "remote-head" });
  expect(calls.some((a) => a[0] === "ls-remote")).toBe(false);
});

test("with the remote out of reach its main, else its master, stands in — and it is not asked again at once", async () => {
  const withMain = await handAdded(await remote("both", "develop", ["main", "master"]));
  await git(withMain, "remote", "set-url", "origin", join(root, "gone.git"));
  expect(await defaultBranch(runGit, withMain)).toEqual({ branch: "main", remote: "origin", source: "remote-guess" });
  calls.length = 0;
  await defaultBranch(runGit, withMain);
  expect(calls.some((a) => a[0] === "ls-remote")).toBe(false);

  const withMaster = await handAdded(await remote("old", "master"));
  await git(withMaster, "remote", "set-url", "origin", join(root, "gone.git"));
  expect(await defaultBranch(runGit, withMaster)).toEqual({ branch: "master", remote: "origin", source: "remote-guess" });

  const neither = await handAdded(await remote("odd", "develop"));
  await git(neither, "remote", "set-url", "origin", join(root, "gone.git"));
  expect(await defaultBranch(runGit, neither)).toBeNull();
  // Not asking at all goes straight to the guess.
  expect(await defaultBranch(runGit, withMain, { ask: false })).toMatchObject({ source: "remote-guess" });
});

test("a repo whose only remote is not called origin is read through that one", async () => {
  const dir = await handAdded(await remote("up", "develop"), "upstream");
  expect(await defaultBranch(runGit, dir)).toEqual({ branch: "develop", remote: "upstream", source: "remote" });
  // Held to origin, it has none.
  expect(await defaultBranch(runGit, dir, { remote: "origin" })).toBeNull();
});

test("a repo with no remote takes the branch init.defaultBranch names, else main, else master", async () => {
  const trunk = await repo("local-trunk", "trunk");
  expect(await defaultBranch(runGit, trunk)).toBeNull();
  await git(trunk, "config", "init.defaultBranch", "trunk");
  expect(await defaultBranch(runGit, trunk)).toEqual({ branch: "trunk", source: "local" });

  const master = await repo("local-master", "master");
  await git(master, "checkout", "-q", "-b", "feature");
  expect(await defaultBranch(runGit, master)).toEqual({ branch: "master", source: "local" });
  await git(master, "branch", "main");
  expect(await defaultBranch(runGit, master)).toEqual({ branch: "main", source: "local" });
});

test("ls-remote --symref output is read for the branch HEAD points at", () => {
  expect(parseSymrefHead("ref: refs/heads/develop\tHEAD\n0123abcd\tHEAD\n")).toBe("develop");
  expect(parseSymrefHead("ref: refs/heads/release/2.x\tHEAD\n")).toBe("release/2.x");
  expect(parseSymrefHead("0123abcd\tHEAD\n")).toBeNull();
  expect(parseSymrefHead("")).toBeNull();
});
