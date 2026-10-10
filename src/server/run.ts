// Subprocess + PATH helpers on Node APIs only. The server modules run under
// both Bun (web server, bun test) and Electron's Node runtime
// (specs/app/desktop-app.feature.md), so nothing here may touch Bun.$ or
// Bun.which.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Run a command with verbatim arguments — no shell, so nothing is ever
 * shell-interpreted. Output is captured and a non-zero exit or spawn failure
 * resolves with an exit code instead of throwing (the Bun.$
 * `.quiet().nothrow()` contract the git layer is written against).
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Non-zero exits carry a numeric code; spawn failures (ENOENT etc.)
        // carry a string code and count as exit 1.
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
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
