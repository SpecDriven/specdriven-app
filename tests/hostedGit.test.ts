// specs/app/hosted-app.feature.md "A repository's contents cannot make a
// hosted worker run code": a person controls what their data repo holds,
// and their worker shares a container with other people's. So a hosted
// worker's git checks a symlink out as a plain file, runs no hook, and
// fetches over http(s) alone — on the system git (src/server/git/cli.ts
// HOSTED_GIT_CONFIG) and on the bundled engine (src/server/git/nodeFs.ts
// plainFileSystem) alike.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBackend, cliGitAvailable, HOSTED_GIT_CONFIG, subprocessRun } from "../src/server/git/cli";
import { jsBackend } from "../src/server/git/js";
import { git } from "./helpers/fixtures";
import { serveRepos, type GitHttpServer } from "./helpers/gitHttpServer";

let dir: string;
let server: GitHttpServer;
const saved = process.env.SPECDRIVEN_HOSTED;
const hasGit = cliGitAvailable();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-hosted-git-"));
  if (!hasGit) return;
  // A repo as a person could push it: a link to a file, and one to `.git`.
  const seed = join(dir, "seed");
  await mkdir(seed);
  await git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "hello\n");
  await symlink("README.md", join(seed, "link.md"));
  await symlink(".git", join(seed, "inside"));
  await git(seed, "add", "-A");
  await git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
  await git(dir, "clone", "-q", "--bare", seed, join(dir, "origin.git"));
  // The same without the link to `.git`, which the bundled engine refuses
  // to make on any machine.
  await git(seed, "rm", "-q", "inside");
  await git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "one link");
  await git(dir, "clone", "-q", "--bare", seed, join(dir, "one-link.git"));
  server = serveRepos(dir);
});

afterAll(async () => {
  server?.stop();
  if (saved === undefined) delete process.env.SPECDRIVEN_HOSTED;
  else process.env.SPECDRIVEN_HOSTED = saved;
  await rm(dir, { recursive: true, force: true });
});

function hosted(on: boolean): void {
  if (on) process.env.SPECDRIVEN_HOSTED = "1";
  else delete process.env.SPECDRIVEN_HOSTED;
}

const backends = { cli: cliBackend, js: jsBackend };

// The seed repo is made with git, so without one there is nothing to clone.
// (A title on the line that closes the table is what a spec's test link finds.)
test.each([
  ["cli"],
  ["js"],
])("the %s engine of a hosted worker checks a symlink out as a plain file", async (name) => {
  if (!hasGit) return;
  const backend = backends[name as keyof typeof backends];
  hosted(true);
  const clone = join(dir, `hosted-${name}`);
  await backend.clone(`${server.url}/origin.git`, clone);
  for (const [file, target] of [
    ["link.md", "README.md"],
    ["inside", ".git"],
  ] as const) {
    const info = await lstat(join(clone, file));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isFile()).toBe(true);
    expect(await readFile(join(clone, file), "utf8")).toBe(target);
  }
  // To git the plain file is still that link: nothing to commit.
  expect((await git(clone, "-c", "core.symlinks=false", "status", "--porcelain")).stdout.toString()).toBe("");
}, 60_000);

test.each([
  ["cli"],
  ["js"],
])("outside the hosted app the %s engine still checks a symlink out as one", async (name) => {
  if (!hasGit) return;
  const backend = backends[name as keyof typeof backends];
  hosted(false);
  const clone = join(dir, `desktop-${name}`);
  await backend.clone(`${server.url}/one-link.git`, clone);
  expect((await lstat(join(clone, "link.md"))).isSymbolicLink()).toBe(true);
}, 60_000);

test.skipIf(!hasGit)("a hosted worker's git runs no hook a write into .git left there", async () => {
  const run = subprocessRun(async () => ({ config: [], env: {} }));
  const repo = join(dir, "hooked");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  const marker = join(dir, "hook-ran");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  // A shell built-in: the tests' PATH has no `touch`.
  await writeFile(hook, `#!/bin/sh\n: > ${marker}\n`);
  await chmod(hook, 0o755);
  const commit = ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m"];

  hosted(true);
  expect((await run(repo, ...commit, "hosted")).exitCode).toBe(0);
  expect(await lstat(marker).catch(() => null)).toBeNull();

  // The same commit on the desktop, where the repository is the person's own machine's.
  hosted(false);
  expect((await run(repo, ...commit, "desktop")).exitCode).toBe(0);
  expect(await lstat(marker).catch(() => null)).not.toBeNull();
});

test.skipIf(!hasGit)("a hosted worker's git fetches over http(s) only, never from a local path or a command posing as a url", async () => {
  const run = subprocessRun(async () => ({ config: [], env: {} }));
  hosted(true);
  const marker = join(dir, "ext-ran");
  const refused = [join(dir, "origin.git"), `ext::sh -c touch% ${marker}`];
  for (const url of refused) {
    const res = await run(null, "ls-remote", url);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("not allowed");
  }
  expect(await lstat(marker).catch(() => null)).toBeNull();
  expect((await run(null, "ls-remote", `${server.url}/origin.git`)).exitCode).toBe(0);
  expect(HOSTED_GIT_CONFIG).toContain("core.fsmonitor=false");

  hosted(false);
  expect((await run(null, "ls-remote", join(dir, "origin.git"))).exitCode).toBe(0);
});
