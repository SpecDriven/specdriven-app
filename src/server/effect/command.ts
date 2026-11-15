// Running a command as an Effect. A run always succeeds with the command's
// exit code and output — a non-zero exit or a spawn failure is an answer,
// not an error (the contract the git layer is written against) — and a run
// that is interrupted stops its process: SIGTERM, then SIGKILL after a grace
// period, and the interruption completes only once the process has exited.
// That is what gives a command a time limit: past `timeoutMs` the run is
// interrupted, and it answers like any failed command, with exit code 124
// (as coreutils `timeout` does) and a line in stderr saying so.
//
// A command may also be held to `quietMs`: stopped once it has written
// nothing for that long. That limit tells a command that hangs from one
// that is slow — a transfer that keeps reporting progress runs on, however
// long it takes, and one that has gone silent is stopped the same way.
//
// The commands that are running are remembered, so the app can stop them
// when it shuts down (stopCommands, src/server/shutdown.ts): none outlives
// the app that started it.
//
// Node APIs only: the server runs under both Bun and Electron's Node runtime
// (specs/app/desktop-app.feature.md), so nothing here may touch Bun.spawn.
// src/server/run.ts is the Promise form of runCommand. It needs none of the
// app's services, so it is no service itself: a program that wants a command
// run yields runCommand, and a test hands the command a stand-in executable.

import { execFile, type ChildProcess } from "node:child_process";
import { Duration, Effect, Option } from "effect";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the command was stopped at one of its limits instead of ending by itself. */
  timedOut?: true;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the command's stdin, which is then closed. */
  input?: string;
  /** Stop the command after this many milliseconds; it then answers with exit code 124. */
  timeoutMs?: number;
  /**
   * Stop the command once it has written nothing — to stdout or stderr — for
   * this many milliseconds; it then answers with exit code 124. For a command
   * that reports its progress as it works.
   */
  quietMs?: number;
  /** What a timed-out answer calls the command ("git pull"); the program's file name when left out. */
  label?: string;
  /** How long a stopped command has to exit after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

/** The exit code of a command stopped at its time limit. */
export const TIMED_OUT_EXIT = 124;

/** How long a stopped command has to exit on SIGTERM before it is killed. */
export const KILL_GRACE_MS = 5_000;

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the process has exited. */
function stop(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.pid === undefined || exited(child)) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(kill);
      done();
    });
    child.kill("SIGTERM");
  });
}

/** The commands running now. */
const running = new Set<ChildProcess>();

/**
 * Stop every command still running: SIGTERM, then SIGKILL after `graceMs`.
 * Completes once they have all exited, with how many there were. Each run
 * answers the way its command ended — a failed command — so whoever waits
 * for one goes on.
 */
export function stopCommands(graceMs: number = KILL_GRACE_MS): Effect.Effect<number> {
  return Effect.promise(async () => {
    const children = [...running];
    await Promise.all(children.map((child) => stop(child, graceMs)));
    return children.length;
  });
}

/** One run of the command, stopped if the run is interrupted or goes quiet past `quietMs`. */
function spawn(cmd: string, args: readonly string[], options: RunOptions): Effect.Effect<RunResult> {
  return Effect.callback<RunResult>((resume) => {
    const grace = options.killGraceMs ?? KILL_GRACE_MS;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    // Set once the command is being stopped for its silence: its answer is
    // then the one below, given when the process has exited.
    let silenced = false;
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        clearTimeout(quiet);
        if (silenced) return;
        // Non-zero exits carry a numeric code; spawn failures (ENOENT etc.)
        // carry a string code and count as exit 1.
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resume(Effect.succeed({ exitCode, stdout: String(stdout), stderr: String(stderr) }));
      },
    );
    if (child.pid !== undefined) {
      running.add(child);
      child.once("exit", () => running.delete(child));
    }
    if (options.input !== undefined) {
      // A command that exits before reading it all closes the pipe: that is
      // its answer, not a reason to fail.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
    const quietMs = options.quietMs;
    if (quietMs !== undefined && quietMs > 0 && child.pid !== undefined) {
      const heard = () => {
        if (silenced) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          silenced = true;
          void stop(child, grace).then(() => resume(Effect.succeed(stopped(cmd, options.label, "quiet", quietMs))));
        }, quietMs);
      };
      child.stdout?.on("data", heard);
      child.stderr?.on("data", heard);
      heard();
    }
    return Effect.promise(() => {
      clearTimeout(quiet);
      return stop(child, grace);
    });
  });
}

/** A time limit as a person reads it: "2 minutes", "1 second", "1.5 seconds", "300 ms". */
function limitText(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** The answer of a command stopped at a limit: which limit, in stderr, as a failed command says why. */
function stopped(cmd: string, label: string | undefined, limit: "total" | "quiet", ms: number): RunResult {
  const name = label ?? cmd.split(/[\\/]/).pop() ?? cmd;
  const why =
    limit === "quiet" ? `made no progress for ${limitText(ms)}` : `took longer than ${limitText(ms)}`;
  return { exitCode: TIMED_OUT_EXIT, stdout: "", stderr: `${name} ${why} and was stopped\n`, timedOut: true };
}

/** Run a command with verbatim arguments — no shell — and answer with how it ended. */
export function runCommand(cmd: string, args: readonly string[], options: RunOptions = {}): Effect.Effect<RunResult> {
  const run = spawn(cmd, args, options);
  const ms = options.timeoutMs;
  if (ms === undefined || !(ms > 0)) return run;
  return run.pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.getOrElse(() => stopped(cmd, options.label, "total", ms))),
  );
}
