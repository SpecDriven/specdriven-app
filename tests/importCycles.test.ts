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

// The storage core's Promise facades run on Effect services built in
// src/server/persistence. The facades import that folder; nothing in it may
// import a facade back, or whichever of them a process loads first would see
// the others half-initialized. Each facade is tried as the first import.
for (const facade of [
  "src/server/fsx.ts",
  "src/server/automerge/store.ts",
  "src/server/state.ts",
  "src/server/tokenStore.ts",
  "src/server/secrets.ts",
]) {
  test(`${facade} loads first without a cycle through the storage core`, () => {
    const run = importInFreshProcess(facade, "src/server/persistence/runtime.ts", "src/server/api.ts");
    expect(run.stderr).not.toContain("before initialization");
    expect(run.code).toBe(0);
  });
}

// The shutdown (src/server/shutdown.ts) names the things it stops — the API's
// background work, the agent sessions, the runtime — and none of them may
// reach back to it, whichever entry point loads it and wherever in its imports.
test("src/server/shutdown.ts loads first without a cycle through what it stops", () => {
  const run = importInFreshProcess("src/server/shutdown.ts", "src/server/api.ts", "src/server/agentChat.ts");
  expect(run.stderr).not.toContain("before initialization");
  expect(run.code).toBe(0);
});

test("the storage core loads on its own, before any facade", () => {
  const run = importInFreshProcess("src/server/persistence/runtime.ts", "src/server/state.ts");
  expect(run.stderr).not.toContain("before initialization");
  expect(run.code).toBe(0);
});

// The per-site token stores (siteTokens.ts and its four forms) are facades
// of the storage core like the ones above. confluenceTokens.ts is the one
// the agent pane and the desktop shell also load.
for (const facade of ["src/server/siteTokens.ts", "src/server/confluenceTokens.ts"]) {
  test(`${facade} loads first without a cycle through the storage core`, () => {
    const run = importInFreshProcess(facade, "src/server/persistence/runtime.ts", "src/server/api.ts");
    expect(run.stderr).not.toContain("before initialization");
    expect(run.code).toBe(0);
  });
}
