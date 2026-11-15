// Subprocess + PATH helpers on Node APIs only. The server modules run under
// both Bun (web server, bun test) and Electron's Node runtime
// (specs/app/desktop-app.feature.md), so nothing here may touch Bun.$ or
// Bun.which.
//
// `run` is the Promise form of the Commands service (src/server/sync/
// Commands.ts), which is where a command's time limit and stopping live.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { run as runProgram } from "./effect/runtime";
import { Commands, type RunOptions, type RunResult } from "./sync/Commands";

export { TIMED_OUT_EXIT } from "./sync/Commands";
export type { RunOptions, RunResult };

/**
 * Run a command with verbatim arguments — no shell, so nothing is ever
 * shell-interpreted. Output is captured and a non-zero exit or spawn failure
 * resolves with an exit code instead of throwing (the Bun.$
 * `.quiet().nothrow()` contract the git layer is written against). With
 * `timeoutMs`, a command still running at the limit is stopped and resolves
 * with exit code 124.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProgram(Commands.use((commands) => commands.run(cmd, args, options)));
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
