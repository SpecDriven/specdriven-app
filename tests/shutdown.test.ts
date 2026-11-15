// specs/ui/ui.feature.md "Quitting the app ends its work in order": a
// shutdown lets nothing new begin, gives running work a moment to end, stops
// what is still running after it, and never hangs on a step that does not
// answer. The pieces first — the folder locks closing, running commands
// being stopped, the runtime disposed, the stages and their limits — then
// the web server itself, started for real and sent SIGTERM.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { runAlone } from "../src/server/effect/bridge";
import { stopCommands } from "../src/server/effect/command";
import { dispose, reopen, run as runProgram } from "../src/server/effect/runtime";
import { localTurn } from "../src/server/git/turns";
import { run, which } from "../src/server/run";
import { reloader, stopBackgroundWork } from "../src/server/api";
import { appStages, leave, SHUTDOWN_LIMITS, type Step } from "../src/server/shutdown";
import { RepoLocks, ShuttingDown } from "../src/server/sync/RepoLocks";
import { cachedExecutable, linkExecutable } from "./helpers/fakeBin";
import { twoClones } from "./helpers/fixtures";
import { errorOf } from "./helpers/persistence";
import { writeSettings } from "./helpers/settingsFile";

// Writes its pid where $FAKE_PID_FILE says, then sleeps in that same process.
const SLEEPER = cachedExecutable('#!/bin/sh\necho $$ > "$FAKE_PID_FILE"\nexec /bin/sleep 30\n');

// The real git, except that a fetch notes its pid in $FAKE_PID_FILE and never answers.
const HANGING_GIT = `#!/bin/sh
for a in "$@"; do
  case "$a" in fetch) echo $$ > "$FAKE_PID_FILE"; exec /bin/sleep 60;; esac
done
exec "$REAL_GIT" "$@"
`;

let root: string;
let pidFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-shutdown-"));
  pidFile = join(root, "pid");
});

afterEach(async () => {
  // A test that closed the app's locks, or its runtime, leaves one nothing can use.
  await dispose();
  reopen();
  reloader.stop();
  await rm(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid a fake wrote, once it has. */
async function pidOf(): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (pid > 0) return pid;
    await Bun.sleep(25);
  }
  throw new Error("the fake never wrote its pid");
}

const onLocks = <A, E>(program: Effect.Effect<A, E, RepoLocks>) =>
  Effect.runPromise(Effect.provide(program, RepoLocks.layer));

test("closing the locks waits for the git work that runs, then turns new work away", async () => {
  const result = await onLocks(
    Effect.gen(function* () {
      const locks = yield* RepoLocks;
      const dir = join(root, "a");
      const release = yield* Deferred.make<void>();
      const commit = yield* Effect.forkChild(locks.withIndex(dir, Deferred.await(release)));
      yield* Effect.yieldNow;
      const closing = yield* Effect.forkChild(locks.close(5_000));
      yield* Effect.sleep("30 millis");
      const waited = closing.pollUnsafe() === undefined;
      yield* Deferred.succeed(release, undefined);
      const committed = yield* Fiber.await(commit);
      const ended = yield* Fiber.join(closing);
      const after = yield* Effect.exit(locks.withIndex(dir, Effect.succeed("ran")));
      const elsewhere = yield* Effect.exit(locks.withRemote(join(root, "b"), Effect.succeed("ran")));
      const tick = yield* Effect.exit(locks.withTick(dir, Effect.succeed("ran")));
      return { waited, committed, ended, after, elsewhere, tick };
    }),
  );
  expect(result.waited).toBe(true);
  expect(Exit.isSuccess(result.committed)).toBe(true);
  expect(result.ended).toBe(true);
  for (const exit of [result.after, result.elsewhere, result.tick]) {
    expect(errorOf(exit)).toBeInstanceOf(ShuttingDown);
  }
});

test("a sync that runs while the locks close still gets its git work done; the next one is turned away", async () => {
  const result = await onLocks(
    Effect.gen(function* () {
      const locks = yield* RepoLocks;
      const dir = join(root, "a");
      const goOn = yield* Deferred.make<void>();
      // A tick that is in the middle of its work when the shutdown begins,
      // and commits and pushes after that.
      const tick = yield* Effect.forkChild(
        locks.withTick(
          dir,
          Effect.gen(function* () {
            yield* Deferred.await(goOn);
            const committed = yield* locks.withIndex(dir, Effect.succeed("committed"));
            const pushed = yield* locks.withRemote(dir, Effect.succeed("pushed"));
            return [committed, pushed];
          }),
        ),
      );
      yield* Effect.yieldNow;
      const closing = yield* Effect.forkChild(locks.close(5_000));
      yield* Effect.sleep("30 millis");
      const next = yield* Effect.exit(locks.withTick(dir, Effect.succeed("ran")));
      yield* Deferred.succeed(goOn, undefined);
      const did = yield* Fiber.join(tick);
      const ended = yield* Fiber.join(closing);
      return { next, did, ended };
    }),
  );
  expect(errorOf(result.next)).toBeInstanceOf(ShuttingDown);
  expect(result.did).toEqual(["committed", "pushed"]);
  expect(result.ended).toBe(true);
});

test("git work that outlasts the wait is not waited for, and what it would do next does not begin", async () => {
  const result = await onLocks(
    Effect.gen(function* () {
      const locks = yield* RepoLocks;
      const dir = join(root, "a");
      const release = yield* Deferred.make<void>();
      // A tick whose fetch hangs, with a push to do after it; and a save's
      // push waiting for the remote behind that fetch.
      const tick = yield* Effect.forkChild(
        locks.withTick(
          dir,
          Effect.andThen(
            locks.withRemote(dir, Deferred.await(release)),
            locks.withRemote(dir, Effect.succeed("pushed")),
          ),
        ),
      );
      yield* Effect.yieldNow;
      const save = yield* Effect.forkChild(locks.withRemote(dir, Effect.succeed("pushed")));
      yield* Effect.yieldNow;
      const started = Date.now();
      const ended = yield* locks.close(60);
      const took = Date.now() - started;
      // The hung fetch is stopped (stopCommands, in the app): the tick goes on to its push.
      yield* Deferred.succeed(release, undefined);
      return { ended, took, tick: yield* Fiber.await(tick), save: yield* Fiber.await(save) };
    }),
  );
  expect(result.ended).toBe(false);
  expect(result.took).toBeLessThan(1_000);
  expect(errorOf(result.tick)).toBeInstanceOf(ShuttingDown);
  expect(errorOf(result.save)).toBeInstanceOf(ShuttingDown);
});

test("git work asked of the app after its locks closed is refused as shutting down", async () => {
  const dir = join(root, "a");
  expect(await localTurn(dir, async () => "committed")).toBe("committed");
  expect(await runProgram(RepoLocks.use((locks) => locks.close(1_000)))).toBe(true);
  expect(localTurn(dir, async () => "committed")).rejects.toThrow("SpecDriven is shutting down");
});

test("disposing the runtime interrupts what still waits on it, and nothing runs on it afterwards", async () => {
  const dir = join(root, "a");
  const waiting = runProgram(Effect.never).then(
    () => "ended",
    (e: Error) => e.message,
  );
  await Bun.sleep(20);
  await dispose();
  expect(await waiting).toBe("The operation was interrupted");

  // Code the shutdown cut short, going on to its next step, starts nothing.
  let began = false;
  const late = localTurn(dir, async () => {
    began = true;
  });
  expect(late).rejects.toThrow("SpecDriven is shutting down");
  expect(began).toBe(false);
});

test("a command still running at shutdown is stopped, and its run answers as a failed command", async () => {
  const pending = run(SLEEPER, [], { env: { ...process.env, FAKE_PID_FILE: pidFile } });
  const pid = await pidOf();
  expect(alive(pid)).toBe(true);

  expect(await runAlone(stopCommands(500))).toBeGreaterThanOrEqual(1);

  expect(alive(pid)).toBe(false);
  expect((await pending).exitCode).not.toBe(0);
  // Nothing is left to stop.
  expect(await runAlone(stopCommands(500))).toBe(0);
});

test("stages run one after another, the steps of a stage side by side", async () => {
  const events: string[] = [];
  const step = (name: string, ms: number): Step => ({
    name,
    limitMs: 1_000,
    work: async () => {
      events.push(`${name} begins`);
      await Bun.sleep(ms);
      events.push(`${name} ends`);
    },
  });
  const reports = await runAlone(leave([[step("sessions", 60), step("locks", 20)], [step("commands", 10)], [step("runtime", 0)]]));

  expect(events).toEqual([
    "sessions begins",
    "locks begins",
    "locks ends",
    "sessions ends",
    "commands begins",
    "commands ends",
    "runtime begins",
    "runtime ends",
  ]);
  expect(reports.map((r) => [r.name, r.outcome])).toEqual([
    ["sessions", "done"],
    ["locks", "done"],
    ["commands", "done"],
    ["runtime", "done"],
  ]);
});

test("a step that fails or does not answer within its limit is reported, and the shutdown goes on", async () => {
  const ran: string[] = [];
  const started = Date.now();
  const reports = await runAlone(
    leave([
      [
        { name: "throws", limitMs: 1_000, work: () => Promise.reject(new Error("no such session")) },
        { name: "throws at once", limitMs: 1_000, work: () => { throw new Error("not even a promise"); } },
        { name: "hangs", limitMs: 80, work: () => new Promise<void>(() => {}) },
      ],
      [{ name: "last", limitMs: 1_000, work: () => void ran.push("last") }],
    ]),
  );

  expect(Date.now() - started).toBeLessThan(1_000);
  expect(ran).toEqual(["last"]);
  expect(reports.map((r) => [r.name, r.outcome, r.error])).toEqual([
    ["throws", "failed", "no such session"],
    ["throws at once", "failed", "not even a promise"],
    ["hangs", "gave up", undefined],
    ["last", "done", undefined],
  ]);
});

test("the app's own shutdown stops the reload timer and a running command, and leaves nothing to run on", async () => {
  reloader.set(60);
  const pending = run(SLEEPER, [], { env: { ...process.env, FAKE_PID_FILE: pidFile } });
  const pid = await pidOf();
  expect(await localTurn(join(root, "a"), async () => "committed")).toBe("committed");

  const reports = await runAlone(leave(appStages({ graceMs: 400, killMs: 300, disposeMs: 400, flushMs: 400 })));

  expect(reports.map((r) => [r.name, r.outcome])).toEqual([
    ["background work", "done"],
    ["agent sessions", "done"],
    ["git work", "done"],
    ["running commands", "done"],
    ["runtime", "done"],
    ["telemetry", "done"],
  ]);
  expect(reloader.seconds).toBe(0);
  expect(alive(pid)).toBe(false);
  expect((await pending).exitCode).not.toBe(0);
  expect(localTurn(join(root, "a"), async () => "committed")).rejects.toThrow("SpecDriven is shutting down");
});

test("stopping the background work stops the reload timer, and may be asked for twice", async () => {
  reloader.set(60);
  expect(reloader.seconds).toBe(60);
  await stopBackgroundWork();
  expect(reloader.seconds).toBe(0);
  await stopBackgroundWork();
  expect(reloader.seconds).toBe(0);
});

test("the shutdown's limits add up to less than the five seconds a hosted gateway waits before it kills a worker", () => {
  // Stages follow one another, so the worst case is each stage's slowest step.
  const worst = appStages(SHUTDOWN_LIMITS)
    .map((stage) => Math.max(...stage.map((step) => step.limitMs)))
    .reduce((sum, ms) => sum + ms, 0);
  expect(worst).toBeLessThan(5_000);
  expect(SHUTDOWN_LIMITS.graceMs).toBeGreaterThanOrEqual(1_000);
});

// A process that asks twice for the shutdown on signals, as a `bun --hot`
// reload of the entry point does, then idles until it is told to stop.
const TWICE = `
import { shutdownOnSignals } from ${JSON.stringify(join(import.meta.dir, "..", "src", "server", "shutdown.ts"))};
shutdownOnSignals(() => console.log("first entry point"));
shutdownOnSignals(() => console.log("reloaded entry point"));
console.log("up");
setInterval(() => {}, 1_000);
`;

test("signal handlers asked for again by a hot reload are installed once and act for the reloaded code", async () => {
  const script = join(root, "twice.ts");
  await Bun.write(script, TWICE);
  const home = join(root, "home");
  const proc = Bun.spawn([process.execPath, script], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      SPECDRIVEN_ROOT: join(root, "app"),
      SPECDRIVEN_HOME: join(home, ".specdriven"),
      SPECDRIVEN_NO_AUTO_INSTALL: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let said = "";
  const readUntil = async (done: () => boolean) => {
    while (!done()) {
      const chunk = await reader.read();
      if (chunk.done) break;
      said += decoder.decode(chunk.value);
    }
  };
  await readUntil(() => said.includes("up"));

  proc.kill("SIGTERM");
  const code = await proc.exited;
  await readUntil(() => false);

  expect(code).toBe(143);
  expect(proc.signalCode).toBeNull();
  expect(said).toContain("reloaded entry point");
  expect(said).not.toContain("first entry point");
  // One handler ran, not two: the reloaded code's first step is there once.
  expect(said.split("reloaded entry point").length - 1).toBe(1);
}, 30_000);

// ---- the web server, for real ------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the web server on a data folder of its own, with nothing of this
 * machine's in reach: its own home and settings, and a PATH that holds only
 * the system's tools — no gh, no coding agent to install a plugin for.
 */
async function startServer(options: { hangingFetch: boolean }) {
  const { a } = await twoClones(join(root, "repos"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeSettings(join(home, ".specdriven", "settings.yaml"), { dataRepo: a, gitEngine: "cli" });
  const realGit = which("git")!;
  if (options.hangingFetch) linkExecutable(bin, "git", HANGING_GIT);
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "index.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: [bin, realGit.replace(/[\\/][^\\/]+$/, ""), "/usr/bin", "/bin"].join(delimiter),
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      SPECDRIVEN_ROOT: join(root, "app"),
      SPECDRIVEN_HOME: join(home, ".specdriven"),
      SPECDRIVEN_REPOS_DIR: join(root, "clones"),
      PORT: String(port),
      // The start must not reach out to the plugin marketplaces.
      SPECDRIVEN_NO_AUTO_INSTALL: "1",
      REAL_GIT: realGit,
      FAKE_PID_FILE: pidFile,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Up once it says where it listens.
  const reader = proc.stdout.getReader();
  let said = "";
  while (!said.includes("SpecDriven running at")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the server ended before it was up: ${said}\n${await new Response(proc.stderr).text()}`);
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { proc, port };
}

test("SIGTERM ends the web server in order, which stops listening and exits with 143", async () => {
  const { proc, port } = await startServer({ hangingFetch: false });
  expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

  const asked = Date.now();
  proc.kill("SIGTERM");
  const code = await proc.exited;

  expect(code).toBe(143);
  // It left by itself, on its own exit code, not killed by the signal.
  expect(proc.signalCode).toBeNull();
  expect(Date.now() - asked).toBeLessThan(4_500);
  expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
}, 30_000);

test("a git command that hangs does not hold the shutdown up and does not outlive the server", async () => {
  const { proc } = await startServer({ hangingFetch: true });
  // The pull on start is waiting on a remote that never answers.
  const git = await pidOf();
  expect(alive(git)).toBe(true);

  const asked = Date.now();
  proc.kill("SIGINT");
  const code = await proc.exited;

  expect(code).toBe(130);
  expect(proc.signalCode).toBeNull();
  expect(Date.now() - asked).toBeLessThan(4_500);
  expect(alive(git)).toBe(false);
}, 30_000);
