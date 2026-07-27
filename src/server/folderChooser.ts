// Native OS folder chooser (specs/app-start.spec.md "picking the data
// directory with the native folder chooser"). Pluggable like the token
// store's backend: the desktop shell swaps in Electron's window-parented
// dialog (src/electron/main.ts); the default covers the web server on
// macOS via osascript — that server always runs on the user's own machine,
// so the Finder dialog lands on their screen. node:child_process rather
// than Bun.$ because this module is shared with the Electron main process,
// which runs under Node.

import { execFile } from "node:child_process";

/** Resolves the picked absolute path, or null when the user cancels. */
export type FolderChooser = () => Promise<string | null>;

function osascriptChooser(): Promise<string | null> {
  return new Promise((resolvePath) => {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose the spec data directory")'],
      (err, stdout) => resolvePath(err ? null : stdout.trim() || null),
    );
  });
}

let chooser: FolderChooser | null = process.platform === "darwin" ? osascriptChooser : null;
let inFlight: Promise<string | null> | null = null;

/**
 * Swap the chooser (desktop shell, tests); null means "no native chooser
 * on this runtime". Returns the previous one so tests can restore it.
 */
export function setFolderChooser(fn: FolderChooser | null): FolderChooser | null {
  const prev = chooser;
  chooser = fn;
  return prev;
}

/** Whether Browse… should be offered at all (surfaced via /api/state). */
export function canChooseFolder(): boolean {
  return chooser !== null;
}

/** Open the chooser. Concurrent calls share the one open dialog. */
export function chooseFolder(): Promise<string | null> {
  if (!chooser) return Promise.resolve(null);
  inFlight ??= chooser().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
