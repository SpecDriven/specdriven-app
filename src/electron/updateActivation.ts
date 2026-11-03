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
