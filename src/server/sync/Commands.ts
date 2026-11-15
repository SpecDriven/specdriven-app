// Running a command as an Effect. A run always succeeds with the command's
// exit code and output — a non-zero exit or a spawn failure is an answer,
// not an error (the contract the git layer is written against) — and a run
// that is interrupted stops its process: SIGTERM, then SIGKILL after a grace
// period, and the interruption completes only once the process has exited.
// That is what gives a command a time limit: past `timeoutMs` the run is
// interrupted, and it answers like any failed command, with exit code 124
// (as coreutils `timeout` does) and a line in stderr saying so.
//
// Node APIs only: the server runs under both Bun and Electron's Node runtime
// (specs/app/desktop-app.feature.md), so nothing here may touch Bun.spawn.
// src/server/run.ts is the Promise form of this service.

import { execFile, type ChildProcess } from "node:child_process";
import { Context, Duration, Effect, Layer, Option } from "effect";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the command's stdin, which is then closed. */
  input?: string;
  /** Stop the command after this many milliseconds; it then answers with exit code 124. */
  timeoutMs?: number;
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

/** One run of the command, stopped if the run is interrupted. */
function spawn(cmd: string, args: readonly string[], options: RunOptions): Effect.Effect<RunResult> {
  return Effect.callback<RunResult>((resume) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Non-zero exits carry a numeric code; spawn failures (ENOENT etc.)
        // carry a string code and count as exit 1.
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resume(Effect.succeed({ exitCode, stdout: String(stdout), stderr: String(stderr) }));
      },
    );
    if (options.input !== undefined) {
      // A command that exits before reading it all closes the pipe: that is
      // its answer, not a reason to fail.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
    return Effect.promise(() => stop(child, options.killGraceMs ?? KILL_GRACE_MS));
  });
}

/** A time limit as a person reads it: "2 minutes", "90 seconds", "300 ms". */
function limitText(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} seconds`;
  return `${ms} ms`;
}

function timedOut(cmd: string, ms: number, label: string | undefined): RunResult {
  const name = label ?? cmd.split(/[\\/]/).pop() ?? cmd;
  return { exitCode: TIMED_OUT_EXIT, stdout: "", stderr: `${name} took longer than ${limitText(ms)} and was stopped\n` };
}

/** Run a command with verbatim arguments — no shell — and answer with how it ended. */
export function runCommand(cmd: string, args: readonly string[], options: RunOptions = {}): Effect.Effect<RunResult> {
  const run = spawn(cmd, args, options);
  const ms = options.timeoutMs;
  if (ms === undefined || !(ms > 0)) return run;
  return run.pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.getOrElse(() => timedOut(cmd, ms, options.label))),
  );
}

export interface CommandsShape {
  readonly run: (cmd: string, args: readonly string[], options?: RunOptions) => Effect.Effect<RunResult>;
}

/** Runs the app's commands — git, gh and the rest. */
export class Commands extends Context.Service<Commands, CommandsShape>()("specdriven/sync/Commands") {
  /** Real processes, on Node's child_process. */
  static readonly layer = Layer.succeed(this, { run: runCommand });
}
