// Shared git fixtures: a bare origin served over smart-HTTP (see
// gitHttpServer.ts) plus clones made from the http url, so the exact same
// fixture exercises both git engines — the built-in engine cannot talk to
// local-path remotes. Setup and verification shell out to CLI git, which
// test machines have; only the shipped app must not require it.

import { $ } from "bun";
import { join } from "node:path";
import { serveRepos } from "./gitHttpServer";
import type { GitHttpServer } from "./gitHttpServer";

export async function git(dir: string, ...args: string[]) {
  const res = await $`git -C ${dir} ${args}`.quiet().nothrow();
  if (res.exitCode !== 0 && args[0] !== "pull") {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res;
}

export interface TwoClones {
  a: string;
  b: string;
  originDir: string;
  originUrl: string;
  server: GitHttpServer;
}

/**
 * A bare origin (served over http) plus two clones a and b, so pulls and
 * pushes hit real transport machinery on either engine. Callers must stop
 * the returned server (an afterEach calling stopServers is simplest).
 */
export async function twoClones(
  root: string,
  seedFiles: Record<string, string> = { "seed.feature.md": "# Seed\n" },
): Promise<TwoClones> {
  const originDir = join(root, "origin.git");
  await $`git init --bare -b main ${originDir}`.quiet();
  const server = track(serveRepos(root));
  const originUrl = `${server.url}/origin.git`;
  const a = join(root, "a");
  const b = join(root, "b");
  await $`git clone ${originUrl} ${a}`.quiet().nothrow();
  await $`git clone ${originUrl} ${b}`.quiet().nothrow();
  for (const dir of [a, b]) {
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "user.name", "Test");
    // Pin the local branch name so `git push` maps onto origin/main
    // regardless of the machine's init.defaultBranch.
    await git(dir, "checkout", "-B", "main");
  }
  for (const [file, content] of Object.entries(seedFiles)) {
    await Bun.write(join(a, file), content); // creates parent folders
  }
  await git(a, "add", ".");
  await git(a, "commit", "-m", "seed");
  await git(a, "push", "origin", "HEAD:main");
  await git(a, "branch", "--set-upstream-to=origin/main");
  await git(b, "pull", "origin", "main");
  await git(b, "branch", "--set-upstream-to=origin/main");
  return { a, b, originDir, originUrl, server };
}

const running: GitHttpServer[] = [];

function track(server: GitHttpServer): GitHttpServer {
  running.push(server);
  return server;
}

/** Stop every server the fixtures started; call from afterEach. */
export function stopServers(): void {
  for (const server of running.splice(0)) server.stop();
}
