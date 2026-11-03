// Check for Updates (specs/app/app-updates.feature.md): the running app
// finds the newest release the way install.sh does — the releases page's
// `latest` redirect — and, on the desktop, installs it through the very
// installer that shipped with its own source: the same signature and
// checksum checks, the same atomic unpack under ~/.specdriven/app, the same
// `current` move and clean-out of older versions, the same build with Bun.
// The installer is told not to start what it built (SPECDRIVEN_HANDOVER=0);
// the restart is the desktop shell's (src/server/relaunch.ts activate),
// which alone knows which executable runs. Node APIs only: this runs under
// Electron.
//
// Nothing here changes what runs until the user restarts: the new version
// lands in its own tree, and the one running stays as the install's
// rollback copy (specs/app/installation.feature.md "Older versions").

import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { version as appVersion } from "../../package.json";
import { appSourceDir } from "./appSource";
import { isDemoMode } from "./demoMode";
import { directoryExists, fileExists } from "./fsx";
import { isHostedMode } from "./hostedMode";
import { json, type Handler } from "./http";
import { activate, appRuntime, canActivate, type ActivationResult } from "./relaunch";
import { which } from "./run";
import { BUN_MISSING, discoverSource, findBun, NO_SOURCE, type SourceInfo } from "./selfFix";
import { RELEASE_REPO_URL } from "./sourceUrl";
import { getLogger } from "./telemetry";
import { isNewer, parseVersion } from "./version";

const log = getLogger("app-update");

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The newest release

/** The releases page: SPECDRIVEN_RELEASES_URL, as install.sh reads it, else the app's own. */
export function releasesUrl(env: Env = process.env): string {
  return (env.SPECDRIVEN_RELEASES_URL || `${RELEASE_REPO_URL}/releases`).replace(/\/+$/, "");
}

export interface UpdateCheck {
  /** The version running. */
  current: string;
  /** The newest release. */
  latest: string;
  /** Whether `latest` comes after `current`. */
  newer: boolean;
  /** The release's page. */
  url: string;
  checkedAt: string;
}

/** The `v<version>` tag `/releases/latest` redirects to, or null. */
export function latestFromLocation(location: string | null): string | null {
  if (!location) return null;
  const m = /\/tag\/v(\d+\.\d+\.\d+)\/?$/.exec(location);
  return m && parseVersion(m[1]!) ? m[1]! : null;
}

export interface CheckOptions {
  releasesUrl?: string;
  fetch?: typeof fetch;
  current?: string;
  now?: Date;
}

/**
 * Ask the releases page which release is the latest: GitHub answers
 * `/releases/latest` with a redirect to `/releases/tag/v<version>`, which
 * needs no token and is what the installers follow too. A page that does not
 * redirect to a tag — no releases at all, a page that is not GitHub's — is an
 * error in so many words.
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateCheck> {
  const base = (opts.releasesUrl ?? releasesUrl()).replace(/\/+$/, "");
  const current = opts.current ?? appVersion;
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/latest`, { redirect: "manual", headers: { "user-agent": `SpecDriven/${current}` } });
  } catch (e) {
    throw new Error(`could not reach ${base}/latest: ${(e as Error).message}`);
  }
  // A manual redirect is the 3xx itself; a fetch that follows anyway lands on
  // the tag's page, whose url says the same thing.
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : res.url || null;
  const latest = latestFromLocation(location);
  if (!latest) throw new Error(`could not find the latest release at ${base}/latest`);
  return {
    current,
    latest,
    newer: isNewer(latest, current),
    url: `${base}/tag/v${latest}`,
    checkedAt: (opts.now ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// What the installer leaves: the app this machine runs

/**
 * The desktop app `build:desktop --local` leaves under a source tree's
 * release/: the .app on macOS (mac-arm64/ on Apple silicon, mac/ on x64),
 * the AppImage on Linux, SpecDriven.exe unpacked on Windows. Null when the
 * tree has not been built.
 */
export async function builtApp(sourceDir: string, os: NodeJS.Platform = platform()): Promise<string | null> {
  const release = join(sourceDir, "release");
  if (!(await directoryExists(release))) return null;
  const entries = await readdir(release).catch(() => [] as string[]);
  if (os === "darwin") {
    for (const name of entries.filter((n) => /^mac(-[\w]+)?$/.test(n)).sort()) {
      const bundle = join(release, name, "SpecDriven.app");
      if (await fileExists(join(bundle, "Contents", "MacOS", "SpecDriven"))) return bundle;
    }
    return null;
  }
  if (os === "win32") {
    for (const name of entries.filter((n) => /^win(-[\w]+)?-unpacked$/.test(n)).sort()) {
      const exe = join(release, name, "SpecDriven.exe");
      if (await fileExists(exe)) return exe;
    }
    return null;
  }
  const image = entries.filter((n) => n.endsWith(".AppImage")).sort()[0];
  return image ? join(release, image) : null;
}

// ---------------------------------------------------------------------------
// Preconditions

export interface UpdatePreconditions {
  runtime: "desktop" | "web";
  bun: string | null;
  source: SourceInfo | null;
  /** The shell that runs the installer: sh, or powershell on Windows. */
  shell: string | null;
  canActivate: boolean;
  /** Why an update cannot install here, if it cannot. */
  reasons: string[];
}

export const WEB_RUNTIME = "The web server cannot replace itself: run the installer again, then start it";
export const SHELL_MISSING = platform() === "win32" ? "powershell is needed to run the installer" : "sh is needed to run the installer";
export const NO_ACTIVATOR = "This app cannot restart into a new version by itself";

export function sourceMismatch(source: SourceInfo): string {
  return `The installed source is ${source.version} but this app is ${appVersion}; restart the app, or run the installer again`;
}

/** What the module reaches for; tests swap pieces in (setUpdateDeps). */
export interface UpdateDeps {
  runner: StreamRunner;
  check: (opts?: CheckOptions) => Promise<UpdateCheck>;
  runtime: () => "desktop" | "web";
  now: () => Date;
}

let moduleDeps: UpdateDeps = { runner: (...a) => streamRun(...a), check: (o) => checkForUpdate(o), runtime: appRuntime, now: () => new Date() };

export function setUpdateDeps(deps: Partial<UpdateDeps> | null): void {
  moduleDeps = {
    runner: deps?.runner ?? ((...a) => streamRun(...a)),
    check: deps?.check ?? ((o) => checkForUpdate(o)),
    runtime: deps?.runtime ?? appRuntime,
    now: deps?.now ?? (() => new Date()),
  };
}

/** The shell that runs the installer: powershell on Windows, else sh — on PATH, or where every Unix keeps it. */
export async function findShell(os: NodeJS.Platform = platform()): Promise<string | null> {
  if (os === "win32") return which("powershell") ?? which("pwsh");
  return which("sh") ?? ((await fileExists("/bin/sh")) ? "/bin/sh" : null);
}

export async function preconditions(): Promise<UpdatePreconditions> {
  const runtime = moduleDeps.runtime();
  const bun = await findBun();
  const source = await discoverSource();
  const shell = await findShell();
  const reasons: string[] = [];
  if (runtime !== "desktop") reasons.push(WEB_RUNTIME);
  if (!bun) reasons.push(BUN_MISSING);
  if (!source) reasons.push(NO_SOURCE);
  else if (!source.match) reasons.push(sourceMismatch(source));
  if (!shell) reasons.push(SHELL_MISSING);
  if (runtime === "desktop" && !canActivate()) reasons.push(NO_ACTIVATOR);
  return { runtime, bun, source, shell, canActivate: canActivate(), reasons };
}

// ---------------------------------------------------------------------------
// Installing: the installer, run from the installed source

export type InstallPhase = "idle" | "installing" | "ready" | "failed";

export interface InstallState {
  phase: InstallPhase;
  /** The version being, or last, installed. */
  version: string | null;
  /** The installer's output, newest last. */
  log: string[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The new version's source tree, once it is built. */
  sourceDir: string | null;
}

export const EMPTY_INSTALL: InstallState = {
  phase: "idle",
  version: null,
  log: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  sourceDir: null,
};

/** How much of the installer's output is kept: a build prints a lot. */
export const LOG_LINES = 1000;

let install: InstallState = EMPTY_INSTALL;

export function installState(): InstallState {
  return install;
}

/** Forget the last install: for tests, and for the pane's Check again. */
export function resetInstall(): void {
  install = EMPTY_INSTALL;
}

export interface StreamOptions {
  cwd?: string;
  env: Env;
  onLine: (line: string) => void;
}

/** Run a command, handing out each line of its output as it comes. */
export type StreamRunner = (cmd: string, args: string[], opts: StreamOptions) => Promise<{ exitCode: number }>;

/**
 * No shell, verbatim arguments; stdout and stderr both go to `onLine` as
 * they arrive, so a build that takes minutes shows where it is. A spawn
 * failure (ENOENT) counts as exit 1, with the message as the last line.
 */
export const streamRun: StreamRunner = (cmd, args, opts) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const feed = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        rest += chunk;
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const line of lines) opts.onLine(line);
      });
      stream.on("end", () => {
        if (rest) opts.onLine(rest);
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    child.on("error", (e) => {
      opts.onLine(e.message);
      done({ exitCode: 1 });
    });
    child.on("close", (code) => done({ exitCode: code ?? 1 }));
  });

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface InstallDeps {
  runner?: StreamRunner;
  env?: Env;
  home?: string;
  os?: NodeJS.Platform;
  now?: () => Date;
}

/** The installer in the installed source, and how it is run. */
export function installerCommand(sourceDir: string, shell: string, os: NodeJS.Platform): { cmd: string; args: string[] } {
  if (os === "win32") {
    return { cmd: shell, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(sourceDir, "install.ps1")] };
  }
  return { cmd: shell, args: [join(sourceDir, "install.sh")] };
}

/**
 * Install `version` with the installer that shipped in this app's source:
 * it downloads, verifies, unpacks, moves `current` and builds, told not to
 * start anything. The checks run before this returns; the installer then
 * runs on, and `done` resolves with the state the pane shows once it has.
 * One install at a time.
 */
export async function installUpdate(
  version: string,
  deps: InstallDeps = {},
): Promise<{ state: InstallState; done: Promise<InstallState> }> {
  if (install.phase === "installing") throw new UpdateError(`SpecDriven ${install.version} is still installing`, 409);
  if (!parseVersion(version)) throw new UpdateError(`"${version}" is not a release version`, 400);
  const pre = await preconditions();
  if (pre.reasons.length > 0 || !pre.bun || !pre.source || !pre.shell) throw new UpdateError(pre.reasons[0] ?? NO_SOURCE, 409);
  if (!isNewer(version, appVersion)) throw new UpdateError(`${version} does not come after the running ${appVersion}`, 409);
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const os = deps.os ?? platform();
  const now = deps.now ?? moduleDeps.now;
  const runner = deps.runner ?? moduleDeps.runner;
  const { cmd, args } = installerCommand(pre.source.dir, pre.shell, os);
  const { dir: sourceDir } = pre.source;
  const bunDir = join(pre.bun, "..");

  install = { ...EMPTY_INSTALL, phase: "installing", version, startedAt: now().toISOString() };
  const onLine = (line: string) => {
    const log = install.log.length >= LOG_LINES ? install.log.slice(install.log.length - LOG_LINES + 1) : install.log;
    install = { ...install, log: [...log, line] };
  };
  const done = (async (): Promise<InstallState> => {
    const result = await runner(cmd, args, {
      cwd: sourceDir,
      env: {
        ...env,
        SPECDRIVEN_VERSION: version,
        // Bun is here (checked above); the question would hang with no terminal.
        SPECDRIVEN_INSTALL_BUN: "0",
        // The restart is ours: the shell swaps the app and relaunches.
        SPECDRIVEN_HANDOVER: "0",
        PATH: `${bunDir}${delimiter}${env.PATH ?? ""}`,
      },
      onLine,
    });
    const finishedAt = now().toISOString();
    const fail = (error: string): InstallState => {
      install = { ...install, phase: "failed", error, finishedAt };
      return install;
    };
    if (result.exitCode !== 0) return fail(`The installer failed (exit ${result.exitCode})`);
    // What it says it did, checked: the new tree beside this one, `current`
    // on it (unless SPECDRIVEN_APP_SOURCE names the source outright, in
    // which case `current` is not the installer's to move), and the app
    // built in it.
    const newDir = join(dirname(sourceDir), `specdriven-${version}`);
    if (!(await directoryExists(newDir))) return fail(`The installer finished, but left no ${newDir}`);
    if (!env.SPECDRIVEN_APP_SOURCE) {
      let current: string;
      try {
        current = await realpath(appSourceDir(env, home));
      } catch {
        return fail("The installer finished, but the install's `current` link is gone");
      }
      if (current !== (await realpath(newDir))) {
        return fail(`The installer finished, but \`current\` points at ${basename(current)}, not specdriven-${version}`);
      }
    }
    if (!(await builtApp(newDir, os))) return fail(`The installer finished, but there is no built app under ${join(newDir, "release")}`);
    install = { ...install, phase: "ready", sourceDir: newDir, error: null, finishedAt };
    return install;
  })();
  return { state: install, done };
}

/** Restart into the version just installed; the shell says how, or that it cannot here. */
export async function restartIntoUpdate(): Promise<ActivationResult> {
  if (install.phase !== "ready" || !install.sourceDir) throw new UpdateError("Install the update before restarting", 409);
  if (!canActivate()) return { restart: "manual", reason: NO_ACTIVATOR, path: await builtApp(install.sourceDir) };
  return activate(install.sourceDir);
}

// ---------------------------------------------------------------------------
// Handlers (src/server/api.ts puts them on /api/app-update)

export interface UpdateIndex extends UpdatePreconditions {
  current: string;
  platform: NodeJS.Platform;
  canInstall: boolean;
  check: UpdateCheck | null;
  install: InstallState;
}

let lastCheck: UpdateCheck | null = null;

/** For tests: no check, no install, the module's own dependencies. */
export function resetUpdateState(): void {
  lastCheck = null;
  lastDailyCheckAt = null;
  dailyCheck = null;
  resetInstall();
  setUpdateDeps(null);
}

// ---------------------------------------------------------------------------
// The daily check (specs/app/app-updates.feature.md "checks once a day"):
// the desktop app asks of its own accord, so the version chip can say a
// newer release is out before anyone thinks to look.

export const DAILY_CHECK_MS = 24 * 60 * 60 * 1000;

/** When this process last checked by itself — in memory, so a restart asks again. */
let lastDailyCheckAt: number | null = null;
let dailyCheck: Promise<void> | null = null;

/** The newer version the last check found, manual or daily; null while this is the newest, or until a check. */
export function updateAvailable(): string | null {
  return lastCheck?.newer ? lastCheck.latest : null;
}

/**
 * Check for a newer release without being asked: the desktop app alone
 * (the web server cannot update itself, the demo and a hosted copy never
 * change), at most once a day, counted from the last such check in this
 * process whether it found a release or not. The answer lands in the same
 * place the manual check's does, so GET /api/app-update and /api/state's
 * `updateAvailable` show it; the caller is not kept waiting, and a check
 * that fails — no network, a page that is not GitHub's — is a debug line,
 * never a toast. Says whether a check was started.
 */
export function maybeCheckDaily(): boolean {
  if (moduleDeps.runtime() !== "desktop" || isDemoMode() || isHostedMode()) return false;
  const now = moduleDeps.now().getTime();
  if (lastDailyCheckAt !== null && now - lastDailyCheckAt < DAILY_CHECK_MS) return false;
  lastDailyCheckAt = now;
  dailyCheck = moduleDeps
    .check()
    .then(
      (check) => {
        lastCheck = check;
        log.debug(check.newer ? `SpecDriven ${check.latest} is available` : `SpecDriven ${check.current} is up to date`);
      },
      (e: unknown) => {
        log.debug(`daily update check failed: ${(e as Error).message}`);
      },
    )
    .finally(() => {
      dailyCheck = null;
    });
  return true;
}

/** For tests: resolves once the daily check under way, if any, has settled. */
export function dailyCheckSettled(): Promise<void> {
  return dailyCheck ?? Promise.resolve();
}

function fail(e: unknown): Response {
  if (e instanceof UpdateError) return json({ error: e.message }, e.status);
  return json({ error: (e as Error).message }, 500);
}

export async function updateIndex(): Promise<UpdateIndex> {
  const pre = await preconditions();
  return {
    ...pre,
    current: appVersion,
    platform: platform(),
    canInstall: pre.reasons.length === 0,
    check: lastCheck,
    install,
  };
}

export function appUpdateHandlers(): Record<string, Handler> {
  return {
    index: async () => {
      try {
        return json(await updateIndex());
      } catch (e) {
        return fail(e);
      }
    },
    check: async () => {
      try {
        lastCheck = await moduleDeps.check();
        return json({ check: lastCheck });
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    },
    install: async (req) => {
      try {
        const body = (await req.json().catch(() => ({}))) as { version?: unknown };
        const version = typeof body.version === "string" ? body.version : (lastCheck?.latest ?? "");
        if (!version) throw new UpdateError("Check for updates first, or say which version to install", 400);
        // The route answers as soon as the install is under way; the pane
        // polls the index for the log and the outcome.
        const { state, done } = await installUpdate(version);
        void done.catch(() => {});
        return json({ install: state }, 202);
      } catch (e) {
        return fail(e);
      }
    },
    restart: async () => {
      try {
        return json(await restartIntoUpdate());
      } catch (e) {
        return fail(e);
      }
    },
  };
}
