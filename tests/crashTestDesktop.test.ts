// Automates the crash test's pure parts (scripts/crash-test-desktop.ts):
// how a run is judged, what the app's output is read for, where the built
// app lives and how the options parse — nothing here launches Electron.
import { test, expect } from "bun:test";
import {
  DEFAULTS,
  describeExit,
  devToolsPort,
  inspectorUrl,
  judge,
  linkLaunch,
  linkPath,
  LINK_PATH,
  packagedBinary,
  parseArgs,
  scanLog,
  seedTwoWindows,
  summarizeError,
  windowsExpected,
  type RunResult,
} from "../scripts/crash-test-desktop";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWindowSession, planRestore } from "../src/electron/windowSession";
import { SETTINGS_VERSION } from "../src/server/settingsModel";

const cleanRun = (overrides: Partial<RunResult> = {}): RunResult => ({
  run: 1,
  readyMs: 1100,
  quitMs: 120,
  exitCode: 0,
  signal: null,
  exitedEarly: false,
  rendererCrashed: false,
  mainWatched: true,
  mainExceptions: [],
  screen: "SpecDriven No folder is open yet. Where is your work?",
  link: null,
  entry: "app://specdriven/",
  expectedWindows: 1,
  windows: 1,
  findings: [],
  crashDumps: 0,
  log: "dist/crash-test/run-1.log",
  screenshot: null,
  ...overrides,
});

const timeouts = { readyTimeout: 60, quitTimeout: 20, uptime: 5 };

test("a launch that rendered, held and quit with 0 passes", () => {
  expect(judge(cleanRun(), timeouts)).toEqual([]);
});

test("dying before being asked to quit fails, naming how it died", () => {
  const crashed = cleanRun({ readyMs: null, quitMs: null, exitCode: null, signal: "SIGSEGV", exitedEarly: true });
  const problems = judge(crashed, timeouts);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/ended on its own \(signal SIGSEGV\)/);

  const bailed = cleanRun({ readyMs: 900, quitMs: null, exitCode: 1, exitedEarly: true });
  expect(judge(bailed, timeouts)[0]).toMatch(/exit code 1/);
});

// specs/ui/navigation.feature.md "links from outside the app": the last of
// several launches arrives by a specdriven:// link to a nested page.
test("the last of two or more launches is by link to a nested page; a lone launch is plain", () => {
  expect(linkLaunch(1, 3)).toBeNull();
  expect(linkLaunch(2, 3)).toBeNull();
  expect(linkLaunch(3, 3)).toBe("specdriven://features/app/desktop-app");
  expect(linkLaunch(1, 1)).toBeNull();
  expect(linkPath(linkLaunch(3, 3)!)).toBe(LINK_PATH);
  expect(LINK_PATH.split("/").filter(Boolean).length).toBeGreaterThan(1);
});

test("a launch by link must have loaded the window at the linked path", () => {
  const link = "specdriven://features/app/desktop-app";
  const atLink = cleanRun({ link, entry: "app://specdriven/features/app/desktop-app?link" });
  expect(judge(atLink, timeouts)).toEqual([]);
  // The app drops the ?link flag and may rewrite the path once mounted; the
  // document's own url is what is judged, so a later replaceState is fine.
  const atRoot = cleanRun({ link, entry: "app://specdriven/" });
  expect(judge(atRoot, timeouts)).toEqual([
    "launched by link to /features/app/desktop-app but the window loaded app://specdriven/",
  ]);
  // A window that never rendered is already a failure; no second complaint.
  expect(judge(cleanRun({ link, entry: null, readyMs: null }), timeouts)).toEqual([
    "window did not render within 60s",
  ]);
});

test("a window that never renders fails even when the quit is clean", () => {
  const blank = cleanRun({ readyMs: null });
  expect(judge(blank, timeouts)).toEqual(["window did not render within 60s"]);
});

test("a quit that hangs, exits non-zero, or leaves a dead window fails", () => {
  expect(judge(cleanRun({ quitMs: null, exitCode: null, signal: "SIGKILL" }), timeouts)).toEqual([
    "did not exit within 20s of SIGTERM — killed",
  ]);
  expect(judge(cleanRun({ exitCode: 3 }), timeouts)).toEqual(["quit with exit code 3 instead of 0"]);
  expect(judge(cleanRun({ rendererCrashed: true }), timeouts)[0]).toMatch(/stopped answering during the 5s hold/);
  expect(judge(cleanRun({ crashDumps: 2 }), timeouts)).toEqual(["2 crash dump(s) written to profile/Crashpad"]);
});

test("an exception the main process's listener recorded fails the run", () => {
  const run = cleanRun({ mainExceptions: ["uncaught exception: Error: injected at Timeout._onTimeout (file:///main.js:10:3)"] });
  expect(judge(run, timeouts)).toEqual([
    "main process uncaught exception: Error: injected at Timeout._onTimeout (file:///main.js:10:3)",
  ]);
  const rejected = cleanRun({ mainExceptions: ["unhandled rejection: Error: sync failed at pull (file:///main.js:20:5)"] });
  expect(judge(rejected, timeouts)).toEqual([
    "main process unhandled rejection: Error: sync failed at pull (file:///main.js:20:5)",
  ]);
  // Not being able to install the listener is reported, not a failure.
  expect(judge(cleanRun({ mainWatched: false }), timeouts)).toEqual([]);
});

test("a recorded error is summarized to its message and where it happened", () => {
  const stack = "uncaught exception: Error: boom\n    at tick (file:///main.js:5:9)\n    at listOnTimeout (node:internal/timers:685:17)";
  expect(summarizeError(stack)).toBe("uncaught exception: Error: boom at tick (file:///main.js:5:9)");
  expect(summarizeError("unhandled rejection: nope")).toBe("unhandled rejection: nope");
});

test("fatal signatures fail the run grouped by kind; notes do not", () => {
  const run = cleanRun({
    findings: [
      { label: "app:// request failed", line: "[app://] /api/state: boom", fatal: false },
      { label: "Chromium fatal error", line: "[FATAL:foo.cc(1)] Check failed: x", fatal: true },
      { label: "Chromium fatal error", line: "[FATAL:foo.cc(2)] Check failed: y", fatal: true },
    ],
  });
  expect(judge(run, timeouts)).toEqual(["Chromium fatal error: [FATAL:foo.cc(1)] Check failed: x (+1 more)"]);
  expect(judge(cleanRun({ findings: [run.findings[0]!] }), timeouts)).toEqual([]);
});

test("the output scan finds crashes and ignores a headless box's usual noise", () => {
  const output = [
    "[2245:0911/204052.711700:ERROR:dbus/bus.cc:406] Failed to connect to the bus: No such file or directory",
    "[2449:0911/204420.858668:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices",
    "DevTools listening on ws://127.0.0.1:41011/devtools/browser/d771728f",
    "[reload] data repo not configured; skipped reload",
    "\x1b[1m\x1b[47m\x1b[31mA JavaScript error occurred in the main process\x1b[0m",
    "Uncaught Exception:",
    "Error: injected",
    "[0911/203953.288424:FATAL:electron/shell/app/electron_main_delegate.cc:225] Running as root without --no-sandbox is not supported.",
    "Received signal 11 SEGV_MAPERR 000000000000",
    '[2245:0911/204054.285831:INFO:CONSOLE:2] "Uncaught TypeError: x is not a function", source: app://specdriven/index.js (2)',
    "[app://] /api/state: ENOENT: no such file",
    "",
  ].join("\n");
  const findings = scanLog(output);
  expect(findings.map((f) => f.label)).toEqual([
    "main process uncaught exception",
    "main process uncaught exception",
    "Chromium fatal error",
    "native crash",
    "renderer uncaught error",
    "app:// request failed",
  ]);
  expect(findings.filter((f) => !f.fatal).map((f) => f.line)).toEqual(["[app://] /api/state: ENOENT: no such file"]);
  expect(findings[0]!.line).toBe("A JavaScript error occurred in the main process");
});

test("the DevTools port and the inspector url are read from what the app prints", () => {
  expect(devToolsPort("noise\nDevTools listening on ws://127.0.0.1:41011/devtools/browser/abc\n")).toBe(41011);
  expect(devToolsPort("[reload] data repo not configured")).toBeNull();
  const banner = "Debugger listening on ws://127.0.0.1:9229/7c2d1f0e-1b2c-4d5e-8f90-abcdef123456\nFor help, see: https://nodejs.org/en/docs/inspector\n";
  expect(inspectorUrl(banner)).toBe("ws://127.0.0.1:9229/7c2d1f0e-1b2c-4d5e-8f90-abcdef123456");
  expect(inspectorUrl("DevTools listening on ws://127.0.0.1:41011/devtools/browser/abc")).toBeNull();
});

test("the packaged app is where electron-builder --dir puts it", () => {
  const pkg = { build: { productName: "SpecDriven", linux: { executableName: "specdriven" } } };
  expect(packagedBinary("linux", "x64", pkg)).toBe("release/linux-unpacked/specdriven");
  expect(packagedBinary("linux", "arm64", pkg)).toBe("release/linux-arm64-unpacked/specdriven");
  expect(packagedBinary("mac", "arm64", pkg)).toBe("release/mac-arm64/SpecDriven.app/Contents/MacOS/SpecDriven");
  expect(packagedBinary("mac", "x64", pkg)).toBe("release/mac/SpecDriven.app/Contents/MacOS/SpecDriven");
});

test("exits are described by signal when there is one, else by code", () => {
  expect(describeExit({ exitCode: null, signal: "SIGTERM" })).toBe("signal SIGTERM");
  expect(describeExit({ exitCode: 0, signal: null })).toBe("exit code 0");
});

test("options: three packaged launches by default, every flag has a say", () => {
  expect(parseArgs([])).toEqual(DEFAULTS);
  expect(parseArgs(["--runs", "5", "--unpackaged", "--no-build", "--uptime=10"])).toMatchObject({
    runs: 5,
    mode: "unpackaged",
    build: false,
    uptime: 10,
  });
  expect(parseArgs(["--ready-timeout", "90", "--quit-timeout=5", "--out", "tmp/ct"])).toMatchObject({
    readyTimeout: 90,
    quitTimeout: 5,
    outDir: "tmp/ct",
  });
});

test("options: everything after -- goes to the app untouched", () => {
  const opts = parseArgs(["--runs", "2", "--", "--disable-gpu", "--runs", "9"]);
  expect(opts.runs).toBe(2);
  expect(opts.appArgs).toEqual(["--disable-gpu", "--runs", "9"]);
});

test("options: a mistyped flag or a bad count stops before anything is built", () => {
  expect(() => parseArgs(["--run", "3"])).toThrow(/unknown option --run/);
  expect(() => parseArgs(["--runs", "0"])).toThrow(/--runs needs a number ≥ 1/);
  expect(() => parseArgs(["--runs"])).toThrow(/--runs needs a value/);
  expect(() => parseArgs(["--uptime", "soon"])).toThrow(/--uptime needs a number/);
});

// specs/app/multiple-windows.feature.md "Closing and restarting": every
// restart of the test has two windows to bring back.
test("the first run is a first run; every restart must render two windows", () => {
  expect([1, 2, 3].map(windowsExpected)).toEqual([1, 2, 2]);
  const one = cleanRun({ readyMs: null, expectedWindows: 2, windows: 1 });
  expect(judge(one, timeouts)).toEqual(["only 1 of the 2 windows the run before left open rendered within 60s"]);
  expect(judge(cleanRun({ expectedWindows: 2, windows: 2 }), timeouts)).toEqual([]);
});

test("the profile is left as an app with two folders open would leave it, the first run's geometry kept", () => {
  const profile = mkdtempSync(join(tmpdir(), "specdriven-crash-seed-"));
  try {
    const home = join(profile, "specdriven-home");
    const at = { x: 12, y: 34, width: 1300, height: 800, maximized: false };
    writeFileSync(join(profile, "window-state.json"), JSON.stringify({ version: 2, windows: [], bounds: { "": at } }));
    const folders = seedTwoWindows(profile, home, SETTINGS_VERSION);
    expect(folders.every((dir) => existsSync(join(dir, "specs", "sample.feature.md")))).toBe(true);
    // The app reads the file back as two windows, the second in front.
    const session = loadWindowSession(join(profile, "window-state.json"))!;
    expect(planRestore(session, { dataRepo: folders[0]! })).toEqual([
      { folder: { dataRepo: folders[0]! } },
      { folder: { dataRepo: folders[1]! }, focused: true },
    ]);
    expect(session.bounds[""]).toEqual(at);
    const settings = readFileSync(join(home, "settings.yaml"), "utf8");
    expect(settings).toContain(`settingsVersion: ${SETTINGS_VERSION}`);
    expect(settings).toContain(`dataRepo: ${JSON.stringify(folders[0])}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
