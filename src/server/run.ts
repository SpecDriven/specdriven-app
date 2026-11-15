// Subprocess + PATH helpers on Node APIs only. The server modules run under
// both Bun (web server, bun test) and Electron's Node runtime
// (specs/app/desktop-app.feature.md), so nothing here may touch Bun.$ or
// Bun.which.
//
// `run` is the Promise form of runCommand (src/server/effect/command.ts),
// which is where a command's limits and stopping live.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runAlone } from "./effect/bridge";
import { runCommand, type RunOptions, type RunResult } from "./effect/command";

export { TIMED_OUT_EXIT } from "./effect/command";
export type { RunOptions, RunResult };

/**
 * Run a command with verbatim arguments — no shell, so nothing is ever
 * shell-interpreted. Output is captured and a non-zero exit or spawn failure
 * resolves with an exit code instead of throwing (the Bun.$
 * `.quiet().nothrow()` contract the git layer is written against). With
 * `timeoutMs` or `quietMs`, a command still running at the limit — or silent
 * for that long — is stopped and resolves with exit code 124.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runAlone(runCommand(cmd, args, options));
}

/** Absolute path of an executable found on PATH, or null — like Bun.which. */
export function which(bin: string): string | null {
  const dirs = (process.env.PATH || "").split(delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      try {
        if (!statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}
