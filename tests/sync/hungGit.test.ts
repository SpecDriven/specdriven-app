// specs: git operations, "a git command that hangs is stopped": a pull the
// remote never answers is stopped at its time limit and shown as the
// folder's pull problem, and a save waiting behind it still reaches the
// remote. And "sync ticks never overlap": ticks asked for at once on one
// folder take turns.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { $ } from "bun";
import { commitAndPush, setGitEngine } from "../../src/server/git";
import { setGitTimeouts } from "../../src/server/git/cli";
import { which } from "../../src/server/run";
import { pullProblem, syncDataDir } from "../../src/server/reload";
import { linkExecutable } from "../helpers/fakeBin";
import { twoClones } from "../helpers/fixtures";

// A git that never answers a pull and is the real git for everything else.
const HANGING_PULL = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = pull ]; then exec /bin/sleep 30; fi
done
exec "$REAL_GIT" "$@"
`;

let root: string;
const saved = { PATH: process.env.PATH, REAL_GIT: process.env.REAL_GIT };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-hunggit-"));
  setGitEngine("cli");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setGitTimeouts(null);
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

/** Put the hanging git first on PATH; the fixtures' own git calls must come before this. */
function hangPulls(): void {
  const bin = join(root, "bin");
  Bun.spawnSync(["/bin/mkdir", "-p", bin]);
  process.env.REAL_GIT = which("git")!;
  linkExecutable(bin, "git", HANGING_PULL);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

test("a pull that hangs is stopped at its limit and a save behind it still reaches the remote", async () => {
  const { a, originDir } = await twoClones(root);
  hangPulls();
  setGitTimeouts({ remoteMs: 400, cloneMs: 400 });
  await Bun.write(join(a, "specs/late.feature.md"), "# Late\n");

  const started = Date.now();
  const tick = syncDataDir(a);
  await Bun.sleep(100); // the tick's pull is under way
  const save = await commitAndPush(a, "specs/late.feature.md", "Add Late");
  const message = await tick;

  expect(Date.now() - started).toBeLessThan(10_000);
  expect(message).toContain("git pull took longer than 400 ms and was stopped");
  expect(pullProblem(a)).toContain("git pull took longer than 400 ms and was stopped");
  expect(save.pushed).toBe(true);
  const subjects = (await $`git -C ${originDir} log --format=%s`.quiet()).stdout.toString();
  expect(subjects).toContain("Add Late");
});

test("ticks asked for at once on one folder take turns and both go through", async () => {
  const { a, originDir } = await twoClones(root);
  await Bun.write(join(a, "specs/first.feature.md"), "# First\n");
  const [one, two] = await Promise.all([syncDataDir(a), syncDataDir(a)]);
  for (const message of [one, two]) expect(message).not.toMatch(/index\.lock|failed/i);
  const status = await $`git -C ${a} status --porcelain`.quiet();
  expect(status.stdout.toString().trim()).toBe("");
  const files = (await $`git -C ${originDir} ls-tree -r --name-only HEAD`.quiet()).stdout.toString();
  expect(files).toContain("specs/first.feature.md");
});
