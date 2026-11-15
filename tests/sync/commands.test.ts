// specs: git operations, "a git command that hangs is stopped": a command
// past its time limit is stopped — SIGTERM, then SIGKILL for one that
// ignores it — and answers like any failed command, with exit code 124; an
// interrupted run stops its process too. Without a limit a command behaves
// as run() always did.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { run, TIMED_OUT_EXIT } from "../../src/server/run";
import { runCommand } from "../../src/server/sync/Commands";
import { cachedExecutable } from "../helpers/fakeBin";

// Writes its pid where $FAKE_PID_FILE says, then sleeps in that same process.
const SLEEPER = cachedExecutable('#!/bin/sh\necho $$ > "$FAKE_PID_FILE"\nexec /bin/sleep 30\n');
// The same, but deaf to SIGTERM.
const STUBBORN = cachedExecutable(
  "#!/bin/sh\ntrap '' TERM\necho $$ > \"$FAKE_PID_FILE\"\nwhile :; do /bin/sleep 0.05; done\n",
);

let dir: string;
let pidFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-commands-"));
  pidFile = join(dir, "pid");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(): Promise<number> {
  return Number((await readFile(pidFile, "utf8")).trim());
}

test("a command past its time limit is stopped and answers with exit code 124", async () => {
  const started = Date.now();
  const res = await run(SLEEPER, ["pull"], {
    env: { ...process.env, FAKE_PID_FILE: pidFile },
    timeoutMs: 200,
    label: "git pull",
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(res.exitCode).toBe(TIMED_OUT_EXIT);
  expect(res.stderr).toBe("git pull took longer than 200 ms and was stopped\n");
  expect(alive(await pidOf())).toBe(false);
});

test("a command that ignores SIGTERM is killed after the grace period", async () => {
  const res = await run(STUBBORN, [], {
    env: { ...process.env, FAKE_PID_FILE: pidFile },
    timeoutMs: 200,
    killGraceMs: 200,
  });
  expect(res.exitCode).toBe(TIMED_OUT_EXIT);
  expect(alive(await pidOf())).toBe(false);
});

test("an interrupted run stops its process before the interruption completes", async () => {
  const fiber = Effect.runFork(runCommand(SLEEPER, [], { env: { ...process.env, FAKE_PID_FILE: pidFile } }));
  // The shell makes the file a moment before it writes the pid into it.
  let pid = 0;
  for (let i = 0; i < 100 && !(pid > 0); i++) {
    await Bun.sleep(20);
    pid = (await Bun.file(pidFile).exists()) ? await pidOf() : 0;
  }
  expect(alive(pid)).toBe(true);
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(alive(pid)).toBe(false);
});

test("a command that finishes within its limit answers as it would without one", async () => {
  const res = await run("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 10_000 });
  expect(res).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
});

test("without a limit, input reaches stdin and a missing command answers with exit code 1", async () => {
  expect((await run("/bin/cat", [], { input: "hello" })).stdout).toBe("hello");
  expect((await run(join(dir, "no-such-command"), [])).exitCode).toBe(1);
});
