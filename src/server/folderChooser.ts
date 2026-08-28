// Native OS folder chooser (specs/app-start.spec.md "picking the data
// directory with the native folder chooser"). Pluggable like the token
// store's backend: the desktop shell swaps in Electron's window-parented
// dialog (src/electron/main.ts); the defaults cover the web server on
// macOS via osascript and on Windows via PowerShell's FolderBrowserDialog —
// that server always runs on the user's own machine, so the dialog lands on
// their screen. node:child_process rather than Bun.$ because this module is
// shared with the Electron main process, which runs under Node.

import { execFile } from "node:child_process";

/** Resolves the picked absolute path, or null when the user cancels. */
export type FolderChooser = () => Promise<string | null>;

const PROMPT = "Choose the spec data directory";

function osascriptChooser(): Promise<string | null> {
  return new Promise((resolvePath) => {
    execFile(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt "${PROMPT}")`],
      (err, stdout) => resolvePath(err ? null : stdout.trim() || null),
    );
  });
}

// WinForms' folder dialog, the same one Electron shows. It needs an STA
// thread, and an owner form so it comes up in front of the browser rather
// than behind it; UTF-8 output keeps non-ASCII paths intact once stdout is
// redirected. Cancel prints nothing, which reads back as null.
const POWERSHELL_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${PROMPT}'`,
  "$dialog.ShowNewFolderButton = $true",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  "$owner.Dispose()",
].join("; ");

function powershellChooser(): Promise<string | null> {
  return new Promise((resolvePath) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", POWERSHELL_SCRIPT],
      { windowsHide: true },
      (err, stdout) => resolvePath(err ? null : stdout.trim() || null),
    );
  });
}

/** The chooser a platform gets out of the box; null where none exists. */
export function platformChooser(platform: string = process.platform): FolderChooser | null {
  if (platform === "darwin") return osascriptChooser;
  if (platform === "win32") return powershellChooser;
  return null;
}

let chooser: FolderChooser | null = platformChooser();
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
