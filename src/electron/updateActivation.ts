// Restarting into a newer version (specs/app/app-updates.feature.md "restart
// into the new version"): which executable the next launch is, and — on a
// Mac whose app was dragged into Applications — how the new bundle takes
// the running one's place. Pure decisions over an fs facade, so they run
// under bun test; main.ts does the renaming and the relaunch.
//
// The install (install.sh, run by src/server/appUpdate.ts) has already put
// the new version under ~/.specdriven/app/specdriven-<version> and built it
// there. On Windows and Linux that build is the app: the next launch starts
// it from there, and the tree that runs now stays as the install's rollback
// copy. On macOS the user runs a copy of the .app from Applications (the
// .dmg the installer opens is for dragging it there), so that copy is what
// has to change: the running bundle is renamed aside, the new one copied in
// at the same path — the Dock, Launch Services and the single-instance
// relaunch all keep working — and the old one is removed once the new app
// has shown a window (main.ts), so a build that cannot start leaves it
// beside itself to rename back.
//
// Linux is the one platform that cannot simply relaunch. The app runs from
// an AppImage, which the AppImage runtime mounts over FUSE and unmounts the
// moment the process it started exits — and Electron's `app.relaunch` starts
// the new app from a helper process forked out of the running executable,
// which is a path inside that mount. The helper dies with the mount and
// nothing is left to start anything: the app quits and never comes back
// (#446). So Linux hands over instead: a small `/bin/sh` of the system's
// own, detached from this process, waits for it to go — the
// single-instance lock is held until then — and execs the new AppImage.

import { basename, dirname, join } from "node:path";
import { builtApp } from "../server/appUpdate";

export interface ActivationFs {
  realpath(path: string): Promise<string>;
  /** Whether the directory can have an entry renamed into it. */
  writable(dir: string): Promise<boolean>;
}

export type ActivationPlan =
  /** macOS: put `newBundle` where `bundle` (the running .app) is, then start `execPath`. */
  | { kind: "swap-bundle"; bundle: string; newBundle: string; execPath: string }
  /** Start the new build where the installer left it. */
  | { kind: "relaunch-into"; execPath: string }
  /** Linux: a detached shell starts `execPath` once this process has quit. */
  | { kind: "hand-over"; execPath: string }
  /** The shell cannot do it here; the new app is at `path` for the user. */
  | { kind: "manual"; reason: string; path: string | null };

/** The .app bundle an executable belongs to — `/Applications/SpecDriven.app` — or null. */
export function bundleOf(execPath: string): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}

/** Where the running bundle goes while the new one is copied in. */
export function previousBundle(bundle: string): string {
  return `${bundle}.previous`;
}

export interface PlanInput {
  platform: NodeJS.Platform;
  /** The running executable (process.execPath). */
  execPath: string;
  /** The new version's source tree, built. */
  newSourceDir: string;
  /** The install's app directory, ~/.specdriven/app: a bundle running from under it is not copied anywhere. */
  appDir: string;
  fs: ActivationFs;
}

export async function planActivation(input: PlanInput): Promise<ActivationPlan> {
  const built = await builtApp(input.newSourceDir, input.platform);
  if (!built) {
    return { kind: "manual", reason: `There is no built app under ${join(input.newSourceDir, "release")}`, path: null };
  }
  // Linux: the AppImage outlives nothing it starts itself (see above).
  if (input.platform === "linux") return { kind: "hand-over", execPath: built };
  if (input.platform !== "darwin") return { kind: "relaunch-into", execPath: built };

  const bundle = bundleOf(input.execPath);
  const newExec = join(built, "Contents", "MacOS", basename(input.execPath));
  if (!bundle) {
    // A development run (`bunx electron .`): nothing of ours to replace.
    return { kind: "manual", reason: "This SpecDriven is not running from an app bundle", path: built };
  }
  let real: string;
  try {
    real = await input.fs.realpath(bundle);
  } catch {
    return { kind: "manual", reason: `${bundle} is gone`, path: built };
  }
  // Run straight from the install's release/ directory: the new one is
  // simply the next thing to start.
  const appDir = await input.fs.realpath(input.appDir).catch(() => input.appDir);
  if (real === appDir || real.startsWith(`${appDir}/`)) return { kind: "relaunch-into", execPath: newExec };
  if (!(await input.fs.writable(dirname(real)))) {
    return {
      kind: "manual",
      reason: `${dirname(real)} is not writable, so ${basename(real)} cannot be replaced from here`,
      path: built,
    };
  }
  return { kind: "swap-bundle", bundle: real, newBundle: built, execPath: join(real, "Contents", "MacOS", basename(input.execPath)) };
}

export interface SwapDeps {
  rename(from: string, to: string): Promise<void>;
  /** Remove a directory tree; nothing to remove is fine. */
  remove(path: string): Promise<void>;
  /** Copy a bundle whole — `ditto`, which keeps its signature and attributes. */
  copy(from: string, to: string): Promise<void>;
}

/**
 * The running bundle steps aside as `<bundle>.previous` and the new one is
 * copied to its path. A copy that fails puts the old one back and throws,
 * so nothing is half done; the running app is untouched throughout — a
 * renamed bundle keeps running.
 */
export async function swapBundle(plan: Extract<ActivationPlan, { kind: "swap-bundle" }>, deps: SwapDeps): Promise<void> {
  const previous = previousBundle(plan.bundle);
  await deps.remove(previous);
  await deps.rename(plan.bundle, previous);
  try {
    await deps.copy(plan.newBundle, plan.bundle);
  } catch (e) {
    await deps.remove(plan.bundle).catch(() => {});
    await deps.rename(previous, plan.bundle);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Handing over on Linux

/** How long the waiting shell gives this process to quit before starting the new app anyway. */
export const HANDOVER_WAIT_SECONDS = 60;

/** How often it looks, in seconds — `sleep`'s fractions, which GNU and busybox both take. */
const HANDOVER_POLL_SECONDS = 0.2;

/**
 * The shell that starts the new app once this process has gone. It is the
 * system's `/bin/sh`, not anything inside the AppImage: it has to outlive
 * the mount the running app is unpacked into. `kill -0` is the wait — the
 * single-instance lock (main.ts) is held for as long as the process is, so
 * starting sooner would only focus the old window and quit. After
 * HANDOVER_WAIT_SECONDS it starts the new app regardless, rather than
 * leaving the user with no app at all.
 *
 * The paths go in as arguments, never interpolated into the script, so a
 * directory with a space or a quote in its name is just an argument.
 */
export function handoverCommand(execPath: string, pid: number): { command: string; args: string[] } {
  const polls = Math.ceil(HANDOVER_WAIT_SECONDS / HANDOVER_POLL_SECONDS);
  const script = [
    // `sleep` is a program, not a builtin: the app's own PATH may be
    // anything (a packaged app's is minimal), so the usual places are
    // appended rather than trusted to be there.
    'PATH="${PATH:-}:/usr/bin:/bin"; export PATH',
    'app="$1"; pid="$2"; n=0',
    `while [ "$n" -lt ${polls} ] && kill -0 "$pid" 2>/dev/null; do`,
    `  sleep ${HANDOVER_POLL_SECONDS}`,
    '  n=$((n + 1))',
    "done",
    'exec "$app"',
  ].join("\n");
  return { command: "/bin/sh", args: ["-c", script, "sh", execPath, String(pid)] };
}

/**
 * The environment the new app starts in: this AppImage's own variables
 * removed, so the new one's runtime sets its own. They name the mount this
 * app runs from, which is gone by then — an inherited LD_LIBRARY_PATH would
 * point the new app's loader at an unmounted directory.
 */
export function handoverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.APPDIR && !env.APPIMAGE) return { ...env };
  const { APPDIR: _dir, APPIMAGE: _image, ARGV0: _argv0, OWD: _owd, LD_LIBRARY_PATH: _libs, ...rest } = env;
  return rest;
}
