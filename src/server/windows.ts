// The desktop app's windows as the server sees them
// (specs/app/multiple-windows.feature.md): which local folder each one works
// in, which window shows a given folder, and the hook through which a route
// asks the shell for a new window. The windows themselves are the shell's
// (src/electron/main.ts); the record of each is its workspace
// (src/server/workspace.ts). Outside the desktop app no window is registered
// and no opener is installed, and every answer here says so.

import { resolve } from "node:path";
import { listChatSessions } from "./agentChat";
import { getAppRoot } from "./paths";
import { dataRepoDir } from "./repo";
import { workspaces, type PendingFolder, type Workspace, type WorkspaceFolder } from "./workspace";

/**
 * The local folder a window's work happens in — its code repository, else
 * its specifications folder — or null while it shows none. Where a coding
 * agent session started there belongs (agentChat.ts `project`).
 */
export function projectDir(folder: WorkspaceFolder): string | null {
  if (folder.openCodeRepo) return resolve(folder.openCodeRepo);
  return folder.dataRepo ? dataRepoDir(folder.dataRepo, getAppRoot()) : null;
}

/** The specifications folder a window syncs, or null: none, or a code repository instead. */
export function syncedDir(folder: WorkspaceFolder): string | null {
  return folder.dataRepo && !folder.openCodeRepo ? dataRepoDir(folder.dataRepo, getAppRoot()) : null;
}

/** Every open window's project folder. */
export function openProjects(): string[] {
  return workspaces().flatMap((w) => projectDir(w.folder) ?? []);
}

/** A folder to look for among the windows: as a window holds it, or as it is about to be opened. */
function dirOf(folder: WorkspaceFolder | PendingFolder): string | null {
  if ("path" in folder) return folder.kind === "code" ? resolve(folder.path) : dataRepoDir(folder.path, getAppRoot());
  return projectDir(folder);
}

/**
 * The window that shows a folder — or is about to — so that opening it
 * again brings that window forward instead ("A folder is open in at most
 * one window"). A GitHub url and the folder it is cloned into are the same
 * folder. `except` leaves the asking window out.
 */
export function windowShowing(folder: WorkspaceFolder | PendingFolder, except?: Workspace | null): Workspace | null {
  const dir = dirOf(folder);
  if (!dir) return null;
  return (
    workspaces().find(
      (w) => w !== except && (projectDir(w.folder) === dir || (w.pending ? dirOf(w.pending) === dir : false)),
    ) ?? null
  );
}

/**
 * How many coding agent sessions of a window's folder are at work: closing
 * the window ends them, so it asks first ("Closing and restarting").
 */
export function workingSessions(workspace: Workspace): number {
  const dir = projectDir(workspace.folder);
  if (!dir) return 0;
  return listChatSessions().filter(
    (s) => s.project === dir && (s.status === "running" || s.status === "awaiting_input"),
  ).length;
}

/** What the shell did with a request for a window. */
export type WindowOpened = "opened" | "focused";

/**
 * Open a window on a folder, or bring the one that shows it forward; with no
 * folder, a new window that asks for one.
 */
export type WindowOpener = (folder?: PendingFolder) => WindowOpened;

let opener: WindowOpener | null = null;
let closer: ((except: Workspace | null) => void) | null = null;

/** Installed by the desktop shell; null (the default) wherever there are no windows to open. */
export function setWindowOpener(fn: WindowOpener | null): WindowOpener | null {
  const before = opener;
  opener = fn;
  return before;
}

/** Whether "Open in new window" can be offered at all (surfaced via /api/state). */
export function canOpenWindows(): boolean {
  return opener !== null;
}

export function openWindow(folder?: PendingFolder): WindowOpened | null {
  return opener ? opener(folder) : null;
}

/** Bring the window of a workspace to the front; false where no shell is there to do it. */
export function focusWindow(workspace: Workspace): boolean {
  if (!opener) return false;
  const folder = workspace.pending ?? toPending(workspace.folder);
  return folder ? opener(folder) === "focused" : false;
}

function toPending(folder: WorkspaceFolder): PendingFolder | null {
  if (folder.openCodeRepo) return { path: folder.openCodeRepo, kind: "code" };
  return folder.dataRepo ? { path: folder.dataRepo, kind: "spec" } : null;
}

/** Installed by the desktop shell: close every window but one (signing out). */
export function setWindowCloser(fn: ((except: Workspace | null) => void) | null): void {
  closer = fn;
}

export function closeOtherWindows(except: Workspace | null): void {
  closer?.(except);
}
