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
import { runCommand } from "../../src/server/effect/command";
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

// Says a line on stderr every 100 ms, twelve times, then ends well.
const TALKER = cachedExecutable(
  '#!/bin/sh\ni=0\nwhile [ $i -lt 12 ]; do echo "step $i" >&2; /bin/sleep 0.1; i=$((i+1)); done\necho done\n',
);
// Says one line, then nothing more.
const FALLS_SILENT = cachedExecutable('#!/bin/sh\necho $$ > "$FAKE_PID_FILE"\necho started >&2\nexec /bin/sleep 30\n');

test("a command that keeps writing runs past its quiet limit", async () => {
  const started = Date.now();
  const res = await run(TALKER, [], { quietMs: 400 });
  expect(Date.now() - started).toBeGreaterThan(1000);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("done\n");
  expect(res.stderr).toContain("step 11");
  expect(res.timedOut).toBeUndefined();
});

test("a command that has gone quiet for its limit is stopped and says so", async () => {
  const started = Date.now();
  const res = await run(FALLS_SILENT, ["pull"], {
    env: { ...process.env, FAKE_PID_FILE: pidFile },
    quietMs: 300,
    label: "git pull",
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(res).toEqual({
    exitCode: TIMED_OUT_EXIT,
    stdout: "",
    stderr: "git pull made no progress for 300 ms and was stopped\n",
    timedOut: true,
  });
  expect(alive(await pidOf())).toBe(false);
});

test("a limit is worded in the unit a person would use", async () => {
  const said = async (ms: number) => (await run(SLEEPER, [], { env: { ...process.env, FAKE_PID_FILE: pidFile }, quietMs: ms })).stderr;
  expect(await said(1000)).toContain("for 1 second and");
  expect(await said(1500)).toContain("for 1.5 seconds and");
});
