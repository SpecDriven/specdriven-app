// Module-load order hazards. src/plugins/builtin/host.ts builds its plugin
// list at load time from src/server/pages.ts's folder constants, so any path
// from pages.ts back to the plugin host is a cycle that breaks whichever
// process happens to load pages.ts first ("Cannot access 'ROADMAP' before
// initialization"). One such path ran through the git engine's import of
// src/server/demo.ts, which reaches the plugin loader; the engine now reads
// demo mode from the leaf src/server/demoMode.ts.
//
// Load order is decided once per process, and the test runner shares one
// process across files, so each check runs in a fresh `bun`.

import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Import `modules` in order in a fresh process; its exit code and stderr. */
function importInFreshProcess(...modules: string[]) {
  const script = modules.map((m) => `await import(${JSON.stringify(join(ROOT, m))});`).join("\n");
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: ROOT, stderr: "pipe" });
  return { code: run.exitCode, stderr: run.stderr.toString() };
}

test("src/server/pages.ts loads first without reaching back into the plugin host", () => {
  const run = importInFreshProcess("src/server/pages.ts", "src/plugins/builtin/host.ts");
  expect(run.stderr).not.toContain("before initialization");
  expect(run.code).toBe(0);
});
