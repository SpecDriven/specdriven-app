// Open a coding agent session's folder in a Ghostty shell
// (specs/agents/agent-pane.feature.md "A worktree session opens in a Ghostty
// shell"). With the setting on, a click on a worktree session's branch in
// the pane's bar opens a Ghostty window — or a tab, as Ghostty's own
// `macos-dock-drop-behavior` decides — whose shell starts in the folder the
// agent works in.
//
//   macOS:  open -a /Applications/Ghostty.app <folder>
//   Linux:  ghostty --working-directory=<folder>
//
// On macOS the `ghostty` binary cannot open a window from a shell, so the
// app bundle is handed the folder: Ghostty registers itself for folders and
// opens one at that place, in the instance already running when there is
// one. Elsewhere `ghostty` must be on PATH. Ghostty has no Windows build.
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./run";

/** How Ghostty is started on this machine. */
export type GhosttyLauncher =
  /** macOS: the app bundle, handed the folder through `open -a`. */
  | { kind: "app"; path: string }
  /** Linux and the BSDs: the binary on PATH. */
  | { kind: "bin"; path: string };

/** What the app tells someone whose machine has no Ghostty. */
export const GHOSTTY_MISSING =
  "Ghostty not found — install it from https://ghostty.org (on a Mac, in Applications; elsewhere, ghostty on PATH)";

/** Where Ghostty is installed, or null when it is not. */
export function findGhostty(
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
  onPath: (bin: string) => string | null = which,
): GhosttyLauncher | null {
  if (platform === "darwin") {
    for (const app of ["/Applications/Ghostty.app", join(home, "Applications", "Ghostty.app")]) {
      if (exists(app)) return { kind: "app", path: app };
    }
    return null;
  }
  if (platform === "win32") return null;
  const bin = onPath("ghostty");
  return bin ? { kind: "bin", path: bin } : null;
}

/** The command that opens `folder` in Ghostty: never through a shell. */
export function ghosttyCommand(launcher: GhosttyLauncher, folder: string): { cmd: string; args: string[] } {
  return launcher.kind === "app"
    ? { cmd: "open", args: ["-a", launcher.path, folder] }
    : { cmd: launcher.path, args: [`--working-directory=${folder}`] };
}

// Injection seams (the ones in src/server/idea.ts): tests must never find
// or start the developer's own Ghostty; null restores the real ones.
let finder: (() => GhosttyLauncher | null) | null = null;

export function setGhosttyFinder(fn: (() => GhosttyLauncher | null) | null): (() => GhosttyLauncher | null) | null {
  const previous = finder;
  finder = fn;
  return previous;
}

/** Ghostty on this machine, as the seam or the real probe finds it. */
export function ghostty(): GhosttyLauncher | null {
  return finder ? finder() : findGhostty();
}

/** Opens a folder in Ghostty; resolves once it is on its way. */
export type GhosttyOpener = (launcher: GhosttyLauncher, folder: string) => Promise<void>;

/**
 * The real opener. `open` hands the folder over and exits, so it is waited
 * for and its complaint reported; `ghostty` is the terminal itself and lives
 * as long as its window, so it is started detached and never waited for —
 * only a failure to start is reported.
 */
const spawnGhostty: GhosttyOpener = (launcher, folder) =>
  new Promise((resolvePromise, reject) => {
    const { cmd, args } = ghosttyCommand(launcher, folder);
    if (launcher.kind === "bin") {
      const child = spawn(cmd, args, { cwd: folder, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolvePromise();
      });
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim().split("\n")[0] || `open exited with ${code}`));
    });
  });

let opener: GhosttyOpener | null = null;

export function setGhosttyOpener(fn: GhosttyOpener | null): GhosttyOpener | null {
  const previous = opener;
  opener = fn;
  return previous;
}

/** Open `folder` in Ghostty. */
export function openInGhostty(launcher: GhosttyLauncher, folder: string): Promise<void> {
  return (opener ?? spawnGhostty)(launcher, folder);
}
