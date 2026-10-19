// Where the running app's own source lives (specs/app/self-healing.feature.md):
// the tree install.sh unpacked and built, which a self-fix session edits and
// a rebuild turns into the patched bundle the desktop shell boots from.
// Pure path arithmetic shared by the server (src/server/selfFix.ts) and the
// Electron boot shim (src/electron/boot.ts), so it reads nothing itself.

import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** `$SPECDRIVEN_HOME`, or ~/.specdriven — the same anchor install.sh uses. */
export function specdrivenHome(env: Env, home: string): string {
  return env.SPECDRIVEN_HOME || join(home, ".specdriven");
}

/**
 * The installed source: `SPECDRIVEN_APP_SOURCE` when set, else the
 * `app/current` link under the SpecDriven home. Callers realpath it — the
 * link points at `specdriven-<version>`, and a patch is found by the same
 * path whether the app runs from /Applications, an AppImage, or
 * `bunx electron .`.
 */
export function appSourceDir(env: Env, home: string): string {
  return env.SPECDRIVEN_APP_SOURCE || join(specdrivenHome(env, home), "app", "current");
}

/** Where self-fix records, screenshots and the boot shim's state live. */
export function selfFixHome(env: Env, home: string): string {
  return join(specdrivenHome(env, home), "self-fix");
}

/** The patched bundle's manifest, written by `build:desktop --bundle-only --fix`. */
export const PATCH_MANIFEST = join("dist", "patch.json");

/** The boot shim's attempt counter for the patched bundle. */
export const PATCH_STATE_FILE = "patch-state.json";
