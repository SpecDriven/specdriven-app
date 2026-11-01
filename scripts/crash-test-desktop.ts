#!/usr/bin/env bun
/**
 * Restart crash test for the desktop app — the runnable half of the
 * electron-crash-test skill (.claude/skills/electron-crash-test/SKILL.md):
 *
 *   bun run test:desktop                 build, package (unpacked dir), launch 3×
 *   bun run test:desktop --runs 5        restart more often
 *   bun run test:desktop --unpackaged    skip electron-builder: node_modules' electron on dist/
 *   bun run test:desktop --no-build      reuse the last build in release/ (or dist/)
 *   bun run test:desktop --uptime 10     hold each launch longer before quitting
 *   bun run test:desktop -- --disable-gpu   anything after -- goes to the app
 *
 * One run is a cold launch of the built app on a throwaway profile, a wait
 * until the window has rendered (asked over Chromium's remote-debugging
 * protocol: document complete and something mounted under #root), a hold,
 * then SIGTERM — which Electron turns into app.quit(), so a clean shutdown
 * exits 0. Every run after the first is a restart on the same profile, so
 * remembered state (window geometry, settings) is loaded back. The last of
 * two or more runs is launched by a `specdriven://` link to a nested page
 * (LINK_PATH), the way the OS starts the app for a link clicked while it
 * is closed: its window must render at that path, not just at `/`. A run fails
 * when the process dies before it is asked to, the window never renders or
 * stops answering, the quit hangs or exits non-zero, the main process
 * throws an uncaught exception or leaves a promise rejection unhandled (a
 * listener the test installs through the main process's Node inspector
 * records those — after startup Electron would only show them in a dialog
 * and print nothing), or the output carries a crash signature (a Chromium
 * FATAL, a native signal — see SIGNATURES).
 *
 * Output lands in dist/crash-test/: run-N.log (the app's stdout+stderr),
 * run-N.png (a screenshot of the window), summary.json, and profile/ (the
 * user-data directory, kept for inspection — Crashpad dumps end up there).
 *
 * Headless Linux (no DISPLAY): an Xvfb server is started for the duration.
 * Root: Chromium refuses to sandbox as root, so --no-sandbox is added.
 */
import { $ } from "bun";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleDesktop, hostPlatform, type Platform } from "./build-desktop";

// ---------------------------------------------------------------------------
// Options

export type Mode = "packaged" | "unpackaged";

export interface Options {
  runs: number;
  mode: Mode;
  build: boolean;
  /** Seconds each launch stays up after the window rendered. */
  uptime: number;
  /** Seconds to wait for the window to render. */
  readyTimeout: number;
  /** Seconds to wait for the process to exit after SIGTERM. */
  quitTimeout: number;
  outDir: string;
  /** Extra command-line arguments for the app (everything after `--`). */
  appArgs: string[];
}

export const DEFAULTS: Options = {
  runs: 3,
  mode: "packaged",
  build: true,
  uptime: 5,
  readyTimeout: 60,
  quitTimeout: 20,
  outDir: "dist/crash-test",
  appArgs: [],
};

export const USAGE = `usage: bun run test:desktop [--runs N] [--unpackaged] [--no-build] [--uptime S]
                            [--ready-timeout S] [--quit-timeout S] [--out DIR] [-- app args]`;

export function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULTS, appArgs: [] };
  const args = [...argv];
  const dash = args.indexOf("--");
  if (dash >= 0) {
    opts.appArgs = args.splice(dash + 1);
    args.pop();
  }
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      const v = inline ?? args[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    const number = (min: number): number => {
      const raw = value();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min) throw new Error(`${arg} needs a number ≥ ${min}, got ${raw}`);
      return n;
    };
    switch (arg) {
      case "--runs":
        opts.runs = Math.floor(number(1));
        break;
      case "--uptime":
        opts.uptime = number(0);
        break;
      case "--ready-timeout":
        opts.readyTimeout = number(1);
        break;
      case "--quit-timeout":
        opts.quitTimeout = number(1);
        break;
      case "--out":
        opts.outDir = value();
        break;
      case "--packaged":
        opts.mode = "packaged";
        break;
      case "--unpackaged":
        opts.mode = "unpackaged";
        break;
      case "--no-build":
        opts.build = false;
        break;
      default:
        throw new Error(`unknown option ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// The launch by link

/**
 * The page the link launch opens: nested, so the shell's asset urls get
 * resolved against a path that is not `/` (src/electron/static.ts
 * shellHtml). The app renders it with or without a data repo — without
 * one the repo prompt shows first (specs/ui/navigation.feature.md "deep
 * link before a data repo is configured"), which still mounts under #root.
 */
export const LINK_PATH = "/features/app/desktop-app";

/**
 * The `specdriven://` url the given run is launched with, or null for a
 * plain launch: the last of two or more runs arrives by link, so the first
 * launch and at least one restart stay plain. A lone run is plain too.
 */
export function linkLaunch(run: number, runs: number): string | null {
  if (runs < 2 || run !== runs) return null;
  return `specdriven:/${LINK_PATH}`;
}

/** The path a `specdriven://` launch url asks for (the url's host + path). */
export function linkPath(url: string): string {
  const u = new URL(url);
  return `/${u.host}${u.pathname}`.replace(/\/{2,}/g, "/");
}

// ---------------------------------------------------------------------------
// Crash signatures in the app's output

export interface Signature {
  label: string;
  pattern: RegExp;
  /** Whether a match fails the run (false: reported, not fatal). */
  fatal: boolean;
}

/**
 * Lines that mean a process died or an exception went unhandled. Chromium's
 * own logging (--enable-logging=stderr) is chatty — D-Bus and GPU warnings
 * are normal on a headless box — so these are deliberately specific.
 */
export const SIGNATURES: Signature[] = [
  {
    label: "main process uncaught exception",
    pattern: /A JavaScript error occurred in the main process|Uncaught Exception:/,
    fatal: true,
  },
  {
    label: "main process failed to load",
    pattern: /App threw an error during load|Cannot find module|Cannot find package/,
    fatal: true,
  },
  // Chromium's log prefix is [pid:timestamp:LEVEL:file(line)].
  { label: "Chromium fatal error", pattern: /[[:]FATAL:|Check failed:/, fatal: true },
  {
    label: "native crash",
    pattern:
      /Received signal \d+|Segmentation fault|Trace\/breakpoint trap|Bus error|Illegal instruction|core dumped/,
    fatal: true,
  },
  {
    label: "child process crashed",
    pattern: /exited unexpectedly|process crashed|process has crashed|isn't usable\. Goodbye/i,
    fatal: true,
  },
  { label: "renderer uncaught error", pattern: /CONSOLE.*"Uncaught /, fatal: true },
  // The app's own protocol handler logging a failed request: served as a
  // 500, so not a crash, but worth a look.
  { label: "app:// request failed", pattern: /^\[app:\/\/\] /, fatal: false },
];

export interface Finding {
  label: string;
  line: string;
  fatal: boolean;
}

/** Every output line matching a signature, in order (first signature wins). */
export function scanLog(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of text.split("\n")) {
    // Electron colours its pre-startup error box with ANSI escapes.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    const sig = SIGNATURES.find((s) => s.pattern.test(line));
    if (sig) findings.push({ label: sig.label, line: line.slice(0, 300), fatal: sig.fatal });
  }
  return findings;
}

/** The "DevTools listening on ws://127.0.0.1:PORT/…" port, once printed. */
export function devToolsPort(output: string): number | null {
  const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
  return m ? Number(m[1]) : null;
}

/** The main process's Node inspector ("Debugger listening on ws://…"), once printed. */
export function inspectorUrl(output: string): string | null {
  const m = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+)/.exec(output);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// One run's outcome and its verdict

export interface RunResult {
  run: number;
  /** Milliseconds from launch until the window had rendered; null if never. */
  readyMs: number | null;
  /** Milliseconds from SIGTERM until exit; null if it had to be killed. */
  quitMs: number | null;
  exitCode: number | null;
  signal: string | null;
  /** The process ended before it was asked to quit. */
  exitedEarly: boolean;
  /** The window stopped answering, or reported a crash, during the hold. */
  rendererCrashed: boolean;
  /** Whether the test's listener made it into the main process. */
  mainWatched: boolean;
  /** Uncaught exceptions and unhandled rejections that listener recorded. */
  mainExceptions: string[];
  /** The first words on screen once rendered — which screen came up. */
  screen: string;
  /** The `specdriven://` url this run was launched with, if any. */
  link: string | null;
  /** The url the document was loaded at (before the app rewrote it), once rendered. */
  entry: string | null;
  findings: Finding[];
  /** Crash dumps that appeared in the profile's Crashpad directory. */
  crashDumps: number;
  log: string;
  screenshot: string | null;
}

export function describeExit(r: Pick<RunResult, "exitCode" | "signal">): string {
  return r.signal ? `signal ${r.signal}` : `exit code ${r.exitCode}`;
}

/** What went wrong in a run; an empty list is a pass. */
export function judge(
  r: RunResult,
  o: Pick<Options, "readyTimeout" | "quitTimeout" | "uptime">,
): string[] {
  const problems: string[] = [];
  if (r.exitedEarly) {
    problems.push(`ended on its own (${describeExit(r)}) before it was asked to quit`);
  } else if (r.readyMs === null) {
    problems.push(`window did not render within ${o.readyTimeout}s`);
  }
  // Each entry starts with its kind: "uncaught exception: …" or "unhandled rejection: …".
  for (const e of r.mainExceptions) problems.push(`main process ${e}`);
  if (r.rendererCrashed) {
    problems.push(`window stopped answering during the ${o.uptime}s hold (renderer crash, or a main process stuck in a dialog?)`);
  }
  // A launch by link must have rendered at the linked path — the document
  // url as loaded, since the app itself drops the link flag and may move on.
  if (r.link && r.readyMs !== null) {
    const wanted = linkPath(r.link);
    let loaded: string | null = null;
    try {
      loaded = r.entry ? new URL(r.entry).pathname : null;
    } catch {
      loaded = r.entry;
    }
    if (loaded !== wanted) {
      problems.push(`launched by link to ${wanted} but the window loaded ${r.entry ?? "nothing"}`);
    }
  }
  if (!r.exitedEarly) {
    if (r.quitMs === null) {
      problems.push(`did not exit within ${o.quitTimeout}s of SIGTERM — killed`);
    } else if (r.exitCode !== 0) {
      problems.push(`quit with ${describeExit(r)} instead of 0`);
    }
  }
  const byLabel = new Map<string, string[]>();
  for (const f of r.findings) {
    if (!f.fatal) continue;
    const lines = byLabel.get(f.label) ?? [];
    lines.push(f.line);
    byLabel.set(f.label, lines);
  }
  for (const [label, lines] of byLabel) {
    const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : "";
    problems.push(`${label}: ${lines[0]}${more}`);
  }
  if (r.crashDumps > 0) problems.push(`${r.crashDumps} crash dump(s) written to profile/Crashpad`);
  return problems;
}

// ---------------------------------------------------------------------------
// Where the built app is

interface PackageJson {
  build: { productName: string; linux: { executableName: string } };
}

/**
 * The executable electron-builder --dir leaves under release/ for the host:
 * linux-unpacked (linux-arm64-unpacked on arm64) or the .app bundle under
 * mac (mac-arm64 on Apple silicon).
 */
export function packagedBinary(platform: Platform, arch: string, pkg: PackageJson): string {
  if (platform === "linux") {
    const dir = arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked";
    return join("release", dir, pkg.build.linux.executableName);
  }
  const dir = arch === "arm64" ? "mac-arm64" : "mac";
  const name = pkg.build.productName;
  return join("release", dir, `${name}.app`, "Contents", "MacOS", name);
}

/** The development electron binary (node_modules), downloaded if missing. */
function developmentElectron(): string {
  // The package's main export is the path of the binary; requiring it also
  // runs the download when `bun install` skipped it.
  return require("electron") as string;
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol, just enough to ask a target how it is doing.
// The window (a page target) and the main process (its Node inspector)
// speak the same protocol.

type EventHandler = (params: Record<string, unknown>) => void;

/**
 * How long any single protocol request may take. A main process stuck in a
 * modal error dialog answers nothing, and the test must go on to say so.
 */
const CDP_TIMEOUT_MS = 5000;

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, EventHandler>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => this.receive(String(e.data));
    ws.onclose = () => this.dropAll(new Error("DevTools connection closed"));
    ws.onerror = () => this.dropAll(new Error("DevTools connection failed"));
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, CDP_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${url}`));
      };
    });
  }

  on(method: string, handler: EventHandler): void {
    this.handlers.set(method, handler);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: no answer within ${CDP_TIMEOUT_MS / 1000}s`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the target and returns its (JSON) value. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  close(): void {
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.dropAll(new Error("closed"));
    this.ws.close();
  }

  private receive(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.handlers.get(msg.method)?.(msg.params ?? {});
    }
  }

  private dropAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** What the page says about itself; "rendered" is complete + mounted. */
interface PageState {
  ready: string;
  title: string;
  children: number;
  text: string;
  /** The document's url as navigated to — what a replaceState can't change. */
  entry: string;
}

const PAGE_STATE = `(() => {
  const root = document.getElementById("root");
  const text = root ? (root.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 120) : "";
  const nav = performance.getEntriesByType("navigation")[0];
  return { ready: document.readyState, title: document.title, children: root ? root.childElementCount : -1, text, entry: (nav && nav.name) || location.href };
})()`;

async function findPage(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find(
      (t) => t.type === "page" && !t.url.startsWith("devtools://") && t.url !== "about:blank",
    );
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** An error's stack → one line: the message and where it happened. */
export function summarizeError(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const where = lines[1]?.startsWith("at ") ? ` ${lines[1]}` : "";
  return `${lines[0] ?? ""}${where}`.slice(0, 300);
}

/**
 * Installed in the main process through its inspector: Electron's own
 * uncaughtException handler steps aside when another listener exists, so
 * from here on an exception is recorded instead of shown in a dialog — and
 * an unhandled rejection, which Node would otherwise turn into one, too.
 */
const MAIN_HOOK = `(() => {
  const g = globalThis;
  if (g.__crashTest) return "installed";
  const list = (g.__crashTest = []);
  const record = (kind) => (e) => list.push(kind + ": " + (e && e.stack ? e.stack : String(e)));
  process.on("uncaughtException", record("uncaught exception"));
  process.on("unhandledRejection", record("unhandled rejection"));
  return "installed";
})()`;
const MAIN_READBACK = `JSON.stringify(globalThis.__crashTest || [])`;

/**
 * One expression in the main process, then detach: while a debugger is
 * attached, process.exit() waits for it, which would hide an early exit.
 */
async function evaluateInMain<T>(url: string, expression: string): Promise<T | null> {
  const cdp = await Cdp.connect(url).catch(() => null);
  if (!cdp) return null;
  try {
    return await cdp.evaluate<T>(expression);
  } catch {
    return null;
  } finally {
    cdp.close();
  }
}

// ---------------------------------------------------------------------------
// A display to draw on

interface Display {
  label: string;
  stop: () => Promise<void>;
}

/** Linux without a DISPLAY gets an Xvfb of its own; anything else is used as is. */
async function ensureDisplay(): Promise<Display> {
  if (process.platform !== "linux") return { label: "native", stop: async () => {} };
  const existing = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (existing) return { label: existing, stop: async () => {} };
  const xvfb = Bun.which("Xvfb");
  if (!xvfb) {
    throw new Error("no DISPLAY and no Xvfb — install xvfb (apt install xvfb) or run from a desktop session");
  }
  let n = 90;
  while (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) n++;
  const proc = Bun.spawn([xvfb, `:${n}`, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const socket = `/tmp/.X11-unix/X${n}`;
  const deadline = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (proc.exitCode !== null) throw new Error(`Xvfb :${n} exited with code ${proc.exitCode}`);
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`Xvfb :${n} did not come up within 10s`);
    }
    await Bun.sleep(100);
  }
  process.env.DISPLAY = `:${n}`;
  return {
    label: `Xvfb :${n} (headless)`,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

// ---------------------------------------------------------------------------
// One launch

interface Launch {
  binary: string;
  /** The app's arguments; a link launch appends its url (linkLaunch). */
  args: (link: string | null) => string[];
  env: Record<string, string | undefined>;
  profile: string;
  outDir: string;
  opts: Options;
}

let current: Subprocess | null = null;
let display: Display | null = null;

function countDumps(profile: string): number {
  if (!existsSync(join(profile, "Crashpad"))) return 0;
  return Array.from(new Bun.Glob("Crashpad/**/*.dmp").scanSync({ cwd: profile })).length;
}

async function launchOnce(run: number, launch: Launch): Promise<RunResult> {
  const { opts } = launch;
  const result: RunResult = {
    run,
    readyMs: null,
    quitMs: null,
    exitCode: null,
    signal: null,
    exitedEarly: false,
    rendererCrashed: false,
    mainWatched: false,
    mainExceptions: [],
    screen: "",
    link: linkLaunch(run, opts.runs),
    entry: null,
    findings: [],
    crashDumps: 0,
    log: join(launch.outDir, `run-${run}.log`),
    screenshot: null,
  };
  const dumpsBefore = countDumps(launch.profile);

  const chunks: string[] = [];
  const started = performance.now();
  const proc = Bun.spawn([launch.binary, ...launch.args(result.link)], {
    env: launch.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  current = proc;
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  let exited = false;
  const exit = proc.exited.then(() => {
    exited = true;
  });

  let page: Cdp | null = null;
  let inspector: string | null = null;
  let pageCrashed = false;
  try {
    // Wait for the window: first the DevTools port, then a page, then a
    // document that has finished loading with the app mounted in it. The
    // listener goes into the main process as soon as its inspector is
    // announced, which is before the app's own code has run far.
    const readyDeadline = started + opts.readyTimeout * 1000;
    while (!exited && performance.now() < readyDeadline) {
      const output = chunks.join("");
      if (!result.mainWatched) {
        inspector ??= inspectorUrl(output);
        if (inspector) {
          result.mainWatched = (await evaluateInMain<string>(inspector, MAIN_HOOK)) === "installed";
        }
      }
      if (!page) {
        const port = devToolsPort(output);
        const wsUrl = port === null ? null : await findPage(port);
        if (wsUrl) {
          page = await Cdp.connect(wsUrl).catch(() => null);
          if (page) {
            page.on("Inspector.targetCrashed", () => {
              pageCrashed = true;
            });
            await page.send("Inspector.enable").catch(() => {});
          }
        }
      }
      if (page) {
        const state = await page.evaluate<PageState>(PAGE_STATE).catch(() => null);
        if (state && state.ready === "complete" && state.children > 0) {
          result.readyMs = Math.round(performance.now() - started);
          result.screen = state.text;
          result.entry = state.entry;
          break;
        }
      }
      await Bun.sleep(250);
    }

    // Hold: a crash that needs the app's first API calls, a sync attempt or
    // a timer to fire shows up here rather than at the first paint.
    if (result.readyMs !== null && page) {
      const holdUntil = performance.now() + opts.uptime * 1000;
      while (!exited && !pageCrashed && performance.now() < holdUntil) await Bun.sleep(250);
      if (!exited) {
        const state = await page.evaluate<PageState>(PAGE_STATE).catch(() => null);
        result.rendererCrashed = pageCrashed || !state || state.children <= 0;
        if (state?.text) result.screen = state.text;
        try {
          const shot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
          const file = join(launch.outDir, `run-${run}.png`);
          writeFileSync(file, Buffer.from(shot.data, "base64"));
          result.screenshot = file;
        } catch {
          // A screenshot is a courtesy; its absence is not a finding.
        }
      }
    }
  } finally {
    page?.close();
  }

  if (exited) {
    result.exitedEarly = true;
  } else {
    if (result.mainWatched && inspector) {
      const raw = await evaluateInMain<string>(inspector, MAIN_READBACK);
      const recorded = raw ? (JSON.parse(raw) as string[]) : [];
      result.mainExceptions = recorded.map(summarizeError);
    }
    // SIGTERM is app.quit() to Electron: before-quit, window close, will-quit.
    const quitStarted = performance.now();
    proc.kill("SIGTERM");
    const quitDeadline = quitStarted + opts.quitTimeout * 1000;
    while (!exited && performance.now() < quitDeadline) await Bun.sleep(100);
    if (exited) result.quitMs = Math.round(performance.now() - quitStarted);
    else proc.kill("SIGKILL");
  }
  await exit;
  // The pipes stay open while any child (zygote, GPU, renderer) that
  // inherited them lives; a straggler must not hold the test up.
  await Promise.race([drained, Bun.sleep(CDP_TIMEOUT_MS)]);
  current = null;

  result.exitCode = proc.exitCode;
  // Bun reports a numeric code for signals it cannot name.
  result.signal = proc.signalCode === null ? null : String(proc.signalCode);
  const text = chunks.join("");
  writeFileSync(result.log, text);
  result.findings = scanLog(text);
  result.crashDumps = countDumps(launch.profile) - dumpsBefore;
  return result;
}

// ---------------------------------------------------------------------------
// The whole test

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function tail(file: string, lines: number): string[] {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const platform = hostPlatform(process.platform);
  if (!platform) throw new Error(`no desktop build for ${process.platform} — this runs on macOS and Linux`);
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  const archFlag = process.arch === "arm64" ? "--arm64" : "--x64";

  const startedAll = performance.now();
  if (opts.build) {
    await bundleDesktop();
    if (opts.mode === "packaged") {
      console.log(`Packaging (electron-builder --${platform} --dir ${archFlag})…`);
      const flags = [`--${platform}`, "--dir", archFlag];
      await $`bunx electron-builder ${flags}`;
    }
    console.log(`  ✓ built in ${seconds(performance.now() - startedAll)}`);
  }

  const outDir = resolve(opts.outDir);
  const profile = join(outDir, "profile");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  let binary: string;
  const args: string[] = [];
  if (opts.mode === "packaged") {
    binary = packagedBinary(platform, process.arch, pkg);
    if (!existsSync(binary)) {
      throw new Error(`${binary} is missing — run without --no-build, or bun run build:desktop first`);
    }
  } else {
    if (
      !existsSync("dist/electron/main.js") ||
      !existsSync("dist/electron/boot.js") ||
      !existsSync("dist/renderer/index.html")
    ) {
      throw new Error("dist/electron and dist/renderer are missing — run without --no-build");
    }
    binary = developmentElectron();
  }
  // Chromium's sandbox will not start as root (a container, CI): the one
  // flag the app would never get from a user, added only where it must be.
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  args.push(
    // Port 0: a free one each, announced on stderr.
    "--inspect=0",
    "--remote-debugging-port=0",
    "--enable-logging=stderr",
    `--user-data-dir=${profile}`,
  );
  // No keyring prompts (or hangs waiting for one) on Linux; the profile is
  // throwaway, so plain-text safeStorage is fine.
  if (process.platform === "linux") args.push("--password-store=basic");
  args.push(...opts.appArgs);
  // Unpackaged: `electron <app dir> [args]`; the app's own arguments — a
  // link among them — follow the directory.
  if (opts.mode === "unpackaged") args.push(resolve("."));
  const launchArgs = (link: string | null): string[] => (link ? [...args, link] : args);

  display = await ensureDisplay();
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Settings, token and logs (src/server/state.ts, telemetry.ts) go with
    // the profile, never into the developer's real ~/.specdriven.
    SPECDRIVEN_HOME: join(profile, "specdriven-home"),
  };
  // A packaged Electron refuses NODE_OPTIONS (and a user's launch has none);
  // ELECTRON_RUN_AS_NODE would turn the app into a bare node.
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`Crash test: ${opts.runs} launches of ${binary} (${opts.mode}), display ${display.label}`);
  const results: RunResult[] = [];
  let failed = 0;
  try {
    for (let run = 1; run <= opts.runs; run++) {
      const r = await launchOnce(run, { binary, args: launchArgs, env, profile, outDir, opts });
      results.push(r);
      const problems = judge(r, opts);
      const timing = [
        r.link ? `by link to ${linkPath(r.link)}` : null,
        r.readyMs === null ? "no window" : `rendered in ${seconds(r.readyMs)}`,
        r.readyMs === null ? null : `held ${opts.uptime}s`,
        r.exitedEarly ? describeExit(r) : r.quitMs === null ? "killed" : `quit in ${seconds(r.quitMs)} (${describeExit(r)})`,
      ]
        .filter(Boolean)
        .join(" · ");
      const screen = r.screen ? ` · screen: "${r.screen.slice(0, 60)}${r.screen.length > 60 ? "…" : ""}"` : "";
      console.log(`  run ${run}/${opts.runs}  ${timing}${screen}  ${problems.length ? "✗ FAIL" : "✓"}`);
      for (const f of r.findings) if (!f.fatal) console.log(`           note: ${f.line}`);
      if (!r.mainWatched && !r.exitedEarly) {
        console.log("           note: could not attach to the main process; an uncaught exception after startup would go unnoticed");
      }
      if (problems.length) {
        failed++;
        for (const p of problems) console.log(`           ${p}`);
        console.log(`           log: ${r.log}${r.screenshot ? `, screenshot: ${r.screenshot}` : ""}`);
        for (const line of tail(r.log, 20)) console.log(`             │ ${line}`);
      }
    }
  } finally {
    current?.kill("SIGKILL");
    await display.stop();
  }

  const passed = failed === 0;
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      { passed, mode: opts.mode, binary, display: display.label, options: opts, runs: results },
      null,
      2,
    ),
  );
  console.log(
    passed
      ? `PASS: ${opts.runs}/${opts.runs} launches rendered the window and quit cleanly (${seconds(performance.now() - startedAll)}; logs and screenshots in ${opts.outDir}/)`
      : `FAIL: ${failed} of ${opts.runs} launches failed — see ${join(opts.outDir, "summary.json")} and the run logs`,
  );
  return passed ? 0 : 1;
}

if (import.meta.main) {
  const stop = () => {
    current?.kill("SIGKILL");
    void display?.stop();
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`crash-test-desktop: ${(e as Error).message}`);
    process.exit(2);
  }
}
