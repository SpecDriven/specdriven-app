// Automates specs/app/self-healing.feature.md on the desktop shell's boot
// shim: which bundle it picks, and how a fix that cannot start is stepped
// around. Pure decisions (src/electron/bootPolicy.ts) — no Electron.
import { describe, expect, test } from "bun:test";
import {
  MAX_ATTEMPTS,
  bootEnv,
  decideBoot,
  parsePatchManifest,
  parsePatchState,
  stateAfterWindow,
  type PatchManifest,
  type PatchState,
} from "../src/electron/bootPolicy";
import { parseBootInfo } from "../src/server/relaunch";

const patch: PatchManifest = { appVersion: "0.1.157", builtAt: "2026-10-19T10:00:00Z", fixId: "fix-1" };

describe("which bundle boots", () => {
  test("without a manifest the shipped bundle boots and nothing is remembered", () => {
    expect(decideBoot({ appVersion: "0.1.157", patch: null, state: null })).toEqual({
      use: "asar",
      reason: "none",
      nextState: null,
    });
  });

  test("a rebuilt fix boots, counted as an attempt until its window shows", () => {
    const first = decideBoot({ appVersion: "0.1.157", patch, state: null });
    expect(first.use).toBe("patch");
    expect(first.reason).toBe("ok");
    expect(first.nextState).toEqual({ fixId: "fix-1", builtAt: patch.builtAt, attempts: 1, lastOk: null });
    // The window loaded: the count goes back to zero, the time is kept.
    const ok = stateAfterWindow(first.nextState!, "2026-10-19T10:01:00Z");
    expect(ok).toEqual({ fixId: "fix-1", builtAt: patch.builtAt, attempts: 0, lastOk: "2026-10-19T10:01:00Z" });
    // The next launch is attempt 1 again.
    expect(decideBoot({ appVersion: "0.1.157", patch, state: ok }).nextState!.attempts).toBe(1);
  });

  test("the patched bundle is ignored after an upgrade, since its version is not the one running", () => {
    const decision = decideBoot({ appVersion: "0.1.158", patch, state: null });
    expect(decision).toEqual({ use: "asar", reason: "version-mismatch", nextState: null });
  });

  test("a crash after a rebuild falls back to the shipped build after two launches without a window", () => {
    let state: PatchState | null = null;
    for (let launch = 1; launch <= MAX_ATTEMPTS; launch++) {
      const d = decideBoot({ appVersion: "0.1.157", patch, state });
      expect(d.use).toBe("patch");
      state = d.nextState; // the window never loads, so the count stays
    }
    const third = decideBoot({ appVersion: "0.1.157", patch, state });
    expect(third.use).toBe("asar");
    expect(third.reason).toBe("crash-loop");
    expect(third.nextState).toEqual(state);
  });

  test("a rebuild starts the count over, and drops the last load error", () => {
    const crashed: PatchState = { fixId: "fix-1", builtAt: patch.builtAt, attempts: 2, lastOk: null, loadError: "boom" };
    const rebuilt = { ...patch, builtAt: "2026-10-19T11:00:00Z" };
    const d = decideBoot({ appVersion: "0.1.157", patch: rebuilt, state: crashed });
    expect(d.use).toBe("patch");
    expect(d.nextState).toEqual({ fixId: "fix-1", builtAt: rebuilt.builtAt, attempts: 1, lastOk: null });
    // So does a different fix's bundle.
    const other = decideBoot({ appVersion: "0.1.157", patch: { ...patch, fixId: "fix-2" }, state: crashed });
    expect(other.use).toBe("patch");
    expect(other.nextState!.fixId).toBe("fix-2");
  });
});

describe("the files on disk", () => {
  test("a manifest needs all three fields; anything else is no manifest", () => {
    expect(parsePatchManifest(JSON.stringify(patch))).toEqual(patch);
    expect(parsePatchManifest(null)).toBeNull();
    expect(parsePatchManifest("not json")).toBeNull();
    expect(parsePatchManifest("[]")).toBeNull();
    expect(parsePatchManifest(JSON.stringify({ appVersion: "0.1.157", fixId: "x" }))).toBeNull();
    expect(parsePatchManifest(JSON.stringify({ ...patch, fixId: "" }))).toBeNull();
  });

  test("a corrupt state file counts as none", () => {
    const state: PatchState = { fixId: "fix-1", builtAt: patch.builtAt, attempts: 1, lastOk: null };
    expect(parsePatchState(JSON.stringify(state))).toEqual(state);
    expect(parsePatchState(JSON.stringify({ ...state, loadError: "boom" }))).toEqual({ ...state, loadError: "boom" });
    expect(parsePatchState(null)).toBeNull();
    expect(parsePatchState("{")).toBeNull();
    expect(parsePatchState(JSON.stringify({ ...state, attempts: "two" }))).toBeNull();
    expect(parsePatchState(JSON.stringify({ ...state, attempts: -1 }))).toBeNull();
    expect(parsePatchState(JSON.stringify({ ...state, lastOk: 5 }))).toBeNull();
    // A fractional count is floored.
    expect(parsePatchState(JSON.stringify({ ...state, attempts: 1.7 }))!.attempts).toBe(1);
  });

  test("the shim tells the server which bundle runs, and the server reads it back", () => {
    expect(parseBootInfo(bootEnv("patch", "ok", "fix-1"))).toEqual({ source: "patch", reason: "ok", fixId: "fix-1" });
    expect(parseBootInfo(bootEnv("asar", "crash-loop", "fix-1"))).toEqual({ source: "asar", reason: "crash-loop", fixId: "fix-1" });
    expect(parseBootInfo(bootEnv("asar", "none", null))).toEqual({ source: "asar", reason: "none", fixId: null });
    // No shim at all — the web server, or a desktop build from before.
    expect(parseBootInfo(undefined)).toEqual({ source: "none", reason: "none", fixId: null });
    expect(parseBootInfo("garbage")).toEqual({ source: "none", reason: "none", fixId: null });
  });
});
