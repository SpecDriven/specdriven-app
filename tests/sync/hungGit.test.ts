// specs: git operations, "a git command that hangs is stopped": a pull the
// remote never answers is stopped once it has gone quiet for its limit and
// shown as the folder's pull problem; an edit saved meanwhile is committed
// without waiting for it, and pushed by the first sync the remote answers;
// a remote that answers nothing is waited for once, not once per command;
// and a pull that keeps reporting progress is left to finish. And "sync
// ticks never overlap": ticks asked for at once on one folder take turns,
// and the ones asked for while one waits are that one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { $ } from "bun";
import { commitAndPush, pull, setGitEngine } from "../../src/server/git";
import { setGitTimeouts } from "../../src/server/git/cli";
import { which } from "../../src/server/run";
import { pullProblem, syncDataDir } from "../../src/server/reload";
import { linkExecutable } from "../helpers/fakeBin";
import { twoClones } from "../helpers/fixtures";

// The real git, except for the verbs two variables name: one in $HANG is
// noted in $HANG_LOG and never answers; one in $SLOW reports progress for
// 1.2 seconds before the real git runs it.
const FAKE_GIT = `#!/bin/sh
for a in "$@"; do
  case " $HANG " in *" $a "*) echo "$a" >> "$HANG_LOG"; exec /bin/sleep 30;; esac
  case " $SLOW " in *" $a "*)
    i=0
    while [ $i -lt 12 ]; do echo "Receiving objects:  $i% ($i/99)" >&2; /bin/sleep 0.1; i=$((i+1)); done
    exec "$REAL_GIT" "$@";;
  esac
done
exec "$REAL_GIT" "$@"
`;

let root: string;
let hangLog: string;
const VARIABLES = ["PATH", "REAL_GIT", "HANG", "SLOW", "HANG_LOG"] as const;
const saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-hunggit-"));
  hangLog = join(root, "hung.log");
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

/** Put the fake git first on PATH; the fixtures' own git calls must come before this. */
function fakeGit(verbs: { hang?: string; slow?: string }): void {
  const bin = join(root, "bin");
  Bun.spawnSync(["/bin/mkdir", "-p", bin]);
  process.env.REAL_GIT = which("git")!;
  process.env.HANG = verbs.hang ?? "";
  process.env.SLOW = verbs.slow ?? "";
  process.env.HANG_LOG = hangLog;
  linkExecutable(bin, "git", FAKE_GIT);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

/** The remote commands that were left to hang, in order. */
async function hung(): Promise<string[]> {
  const log = Bun.file(hangLog);
  return (await log.exists()) ? (await log.text()).split("\n").filter(Boolean) : [];
}

async function subjects(dir: string): Promise<string> {
  return (await $`${process.env.REAL_GIT!} -C ${dir} log --format=%s`.quiet()).stdout.toString();
}

test("a pull that hangs is stopped, and an edit saved meanwhile is committed at once and pushed when the remote answers", async () => {
  const { a, originDir } = await twoClones(root);
  fakeGit({ hang: "fetch" });
  setGitTimeouts({ quietMs: 1500 });
  await Bun.write(join(a, "specs/late.feature.md"), "# Late\n");

  let tickEnded = false;
  const tick = syncDataDir(a).finally(() => (tickEnded = true));
  await Bun.sleep(150); // the tick's fetch is waiting on the remote
  const save = commitAndPush(a, "specs/late.feature.md", "Add Late");
  // The commit does not wait for the fetch: it is there while the fetch hangs.
  for (let i = 0; i < 100 && !(await subjects(a)).includes("Add Late"); i++) await Bun.sleep(10);
  expect(await subjects(a)).toContain("Add Late");
  expect(tickEnded).toBe(false);

  const message = await tick;
  expect(message).toContain("git fetch made no progress for 1.5 seconds and was stopped");
  expect(pullProblem(a)).toContain("git fetch made no progress for 1.5 seconds and was stopped");
  // The push behind the stopped fetch is not left to wait out the limit too.
  const result = await save;
  expect(result.pushed).toBe(false);
  expect(result.message).toContain("push not tried");
  expect(await hung()).toEqual(["fetch"]);
  expect(await subjects(originDir)).not.toContain("Add Late");

  // The remote answers again: the next sync pulls, and pushes what waited.
  process.env.HANG = "";
  await syncDataDir(a);
  expect(pullProblem(a)).toBeNull();
  expect(await subjects(originDir)).toContain("Add Late");
});

test("a remote that answers nothing is waited for once, by the sync that found it and by the one asked for meanwhile", async () => {
  const { a } = await twoClones(root);
  fakeGit({ hang: "fetch push" });
  setGitTimeouts({ quietMs: 1000 });
  // Something to push, so each sync has a pull and a push to wait for.
  await Bun.write(join(a, "specs/late.feature.md"), "# Late\n");

  const timer = syncDataDir(a);
  await Bun.sleep(150); // the timer's tick is waiting on its fetch
  const button = syncDataDir(a);
  const [first, second] = await Promise.all([timer, button]);

  for (const message of [first, second]) {
    expect(message).toContain("git fetch made no progress for 1 second and was stopped");
    expect(message).toContain("push not tried");
  }
  // One command waited out the limit — not the fetch and the push of each sync.
  expect(await hung()).toEqual(["fetch"]);
});

test("syncs asked for while one waits are served by one tick", async () => {
  const { a } = await twoClones(root);
  fakeGit({ hang: "fetch" });
  setGitTimeouts({ quietMs: 400 });

  const running = syncDataDir(a);
  await Bun.sleep(150); // begun, and held up by its fetch
  const waiting = syncDataDir(a);
  const later = syncDataDir(a);
  expect(waiting).not.toBe(running);
  expect(later).toBe(waiting);
  expect(await later).toBe(await waiting);
  await running;
  // Asked for after the wait is over, a sync is a tick of its own again.
  expect(syncDataDir(a)).not.toBe(waiting);
});

test("a pull that keeps reporting progress is left to finish, however long it has run", async () => {
  const { a, b } = await twoClones(root);
  await Bun.write(join(b, "specs/theirs.feature.md"), "# Theirs\n");
  await $`git -C ${b} add -A`.quiet();
  await $`git -C ${b} commit -q -m Theirs`.quiet();
  await $`git -C ${b} push -q`.quiet();
  fakeGit({ slow: "fetch" });
  setGitTimeouts({ quietMs: 400 });

  const started = Date.now();
  const pulled = await pull(a);

  expect(Date.now() - started).toBeGreaterThan(1000); // three times the quiet limit
  expect(pulled.ok).toBe(true);
  expect(await Bun.file(join(a, "specs/theirs.feature.md")).exists()).toBe(true);
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
