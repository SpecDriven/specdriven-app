// Native OS folder chooser (specs/ui/app-start.feature.md "picking the data
// directory with the native folder chooser"). Pluggable like the token
// store's backend: the desktop shell swaps in Electron's window-parented
// dialog (src/electron/main.ts); the defaults cover the web server on
// macOS via osascript, on Windows via PowerShell's FolderBrowserDialog and
// on Linux via zenity or kdialog — that server always runs on the user's
// own machine, so the dialog lands on their screen. node:child_process
// rather than Bun.$ because this module is shared with the Electron main
// process, which runs under Node.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolves the picked absolute path, or null when the user cancels. */
export type FolderChooser = (title?: string) => Promise<string | null>;

/**
 * What the folder is being picked for. Each maps to a fixed title — the
 * title is spliced into the osascript and PowerShell below, so it is never
 * free text from a request.
 */
export type FolderPurpose = "data-repo" | "code-repo" | "folder";

export const FOLDER_TITLES: Record<FolderPurpose, string> = {
  "data-repo": "Choose the spec data directory",
  "code-repo": "Choose the code repository",
  // The first-run screen's one field takes either kind.
  folder: "Choose a specification folder or a code repository",
};

const PROMPT = FOLDER_TITLES["data-repo"];

function osascriptChooser(title = PROMPT): Promise<string | null> {
  return new Promise((resolvePath) => {
    execFile(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt "${title}")`],
      (err, stdout) => resolvePath(err ? null : stdout.trim() || null),
    );
  });
}

// WinForms' folder dialog, the same one Electron shows. It needs an STA
// thread, and an owner form so it comes up in front of the browser rather
// than behind it; UTF-8 output keeps non-ASCII paths intact once stdout is
// redirected. Cancel prints nothing, which reads back as null.
const powershellScript = (title: string) => [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${title}'`,
  "$dialog.ShowNewFolderButton = $true",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  "$owner.Dispose()",
].join("; ");

function powershellChooser(title = PROMPT): Promise<string | null> {
  return new Promise((resolvePath) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", powershellScript(title)],
      { windowsHide: true },
      (err, stdout) => resolvePath(err ? null : stdout.trim() || null),
    );
  });
}

// Linux has no dialog that ships with every install, so the desktop's own
// one is used: zenity under GNOME/GTK, kdialog under KDE. Both print the
// picked path and exit non-zero on cancel, which reads back as null — same
// contract as the osascript and PowerShell paths. The start directory is
// $HOME: kdialog requires one, and zenity opens at the process's working
// directory (wherever the server happens to have been launched) without it.
const LINUX_DIALOGS = [
  {
    command: "zenity",
    args: (title: string) => ["--file-selection", "--directory", `--title=${title}`, `--filename=${homedir()}/`],
  },
  {
    command: "kdialog",
    args: (title: string) => ["--getexistingdirectory", homedir(), "--title", title],
  },
];

// Where `command` sits on PATH, or null if it is not there. Read straight
// off the filesystem rather than shelling out to which(1), so installing
// the chooser stays a synchronous decision — canChooseFolder() answers
// /api/state inline. isFile() as well as X_OK because a directory carries
// the execute bit too.
function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not ours to run: try the next PATH entry.
    }
  }
  return null;
}

function linuxChooser(env: NodeJS.ProcessEnv): FolderChooser | null {
  // No display means no dialog to show — a headless server (the Docker
  // image, an SSH session) has to keep the Browse… button hidden rather
  // than offer one that can only fail.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  for (const dialog of LINUX_DIALOGS) {
    // Resolved to the absolute path found here, so the dialog that runs is
    // the one this lookup approved.
    const command = onPath(dialog.command, env);
    if (!command) continue;
    return (title = PROMPT) =>
      new Promise((resolvePath) => {
        execFile(command, dialog.args(title), (err, stdout) =>
          resolvePath(err ? null : stdout.trim() || null),
        );
      });
  }
  return null;
}

/** The chooser a platform gets out of the box; null where none exists. */
export function platformChooser(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): FolderChooser | null {
  if (platform === "darwin") return osascriptChooser;
  if (platform === "win32") return powershellChooser;
  if (platform === "linux") return linuxChooser(env);
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
export function chooseFolder(purpose: FolderPurpose = "data-repo"): Promise<string | null> {
  if (!chooser) return Promise.resolve(null);
  inFlight ??= chooser(FOLDER_TITLES[purpose]).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
