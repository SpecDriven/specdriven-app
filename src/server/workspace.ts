// Workspaces: the folders open side by side, one per desktop window
// (specs/app/multiple-windows.feature.md). The settings file names one
// open folder — `dataRepo`, or `openCodeRepo` in its place — and every route
// reads it from there; a window's requests run inside its workspace instead,
// where state.ts readState answers with that window's folder and writeState
// takes a folder change into the window's record. The settings file then
// holds the folder of whichever window wrote last, which is what a run
// without windows — the web version, the plugin CLI — opens.
//
// Nothing is registered outside the desktop app: with no workspace active
// every reader sees the settings file as it is, exactly as before.
//
// A leaf: this file imports no other module of the app, so the runtime
// (src/server/effect/runtime.ts) and the settings facade (state.ts) can both
// use it (tests/importCycles.test.ts).

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The folder a window shows, as the settings name it: a specifications
 * folder, or a code repository opened in its place — `dataRepo` is then the
 * last specifications folder, kept for the way back
 * (specs/app/code-repo-mode.feature.md).
 */
export interface WorkspaceFolder {
  dataRepo?: string;
  openCodeRepo?: string;
}

/**
 * A folder a window was opened for and has not opened yet (File → Open
 * Folder…, "Open in new window", a link to a folder no window shows): the
 * window's page opens it the way a folder picked by hand is opened — asked
 * about when it is missing, pulled, put on the recent list.
 */
export interface PendingFolder {
  path: string;
  /** What it was listed as, when it came off the recent list. */
  kind?: "spec" | "code";
  /** The window's page was told: a reload of it does not open the folder a second time. */
  told?: boolean;
}

export interface Workspace {
  /** The window's id, unique while the app runs. */
  readonly id: string;
  /** The folder open in it; replaced, never edited in place. */
  folder: WorkspaceFolder;
  /** The folder the window is about to open; gone once it has opened one. */
  pending?: PendingFolder;
}

/** What changed in the set of open workspaces. */
export type WorkspaceChange = "opened" | "closed" | "folder";

type Listener = (change: WorkspaceChange, workspace: Workspace, before: WorkspaceFolder) => void;

const open = new Map<string, Workspace>();
const listeners = new Set<Listener>();
/** The workspace a call chain runs in; null inside `detached`. */
const active = new AsyncLocalStorage<Workspace | null>();

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The folder pair a settings object names. */
export function folderOf(state: { dataRepo?: unknown; openCodeRepo?: unknown }): WorkspaceFolder {
  const dataRepo = clean(state.dataRepo);
  const openCodeRepo = clean(state.openCodeRepo);
  return { ...(dataRepo ? { dataRepo } : {}), ...(openCodeRepo ? { openCodeRepo } : {}) };
}

/** A settings object as a window reads it: the shared settings, that window's folder. */
export function withFolder<S extends { dataRepo?: string; openCodeRepo?: string }>(state: S, folder: WorkspaceFolder): S {
  const out = { ...state };
  delete out.dataRepo;
  delete out.openCodeRepo;
  return { ...out, ...folderOf(folder) };
}

/**
 * A folder pair as one word: the code repository when one is open, else the
 * specifications folder, "" for neither. What a window's saved place on
 * screen is kept under (src/electron/windowSession.ts).
 */
export function folderKey(folder: WorkspaceFolder): string {
  const { dataRepo, openCodeRepo } = folderOf(folder);
  return openCodeRepo ? `code:${openCodeRepo}` : dataRepo ? `spec:${dataRepo}` : "";
}

export function sameFolder(a: WorkspaceFolder, b: WorkspaceFolder): boolean {
  return a.dataRepo === b.dataRepo && a.openCodeRepo === b.openCodeRepo;
}

function tell(change: WorkspaceChange, workspace: Workspace, before: WorkspaceFolder): void {
  for (const listener of [...listeners]) {
    try {
      listener(change, workspace, before);
    } catch {
      // One listener's failure is not the others' — nor the request's that caused the change.
    }
  }
}

/** A window opened: its workspace, registered under the window's id. */
export function openWorkspace(id: string, folder: WorkspaceFolder = {}, pending?: PendingFolder): Workspace {
  if (open.has(id)) throw new Error(`workspace ${id} is already open`);
  const workspace: Workspace = { id, folder: folderOf(folder), ...(pending ? { pending } : {}) };
  open.set(id, workspace);
  tell("opened", workspace, {});
  return workspace;
}

/** A window closed. A request of its still running keeps the record it started with. */
export function closeWorkspace(id: string): void {
  const workspace = open.get(id);
  if (!workspace) return;
  open.delete(id);
  tell("closed", workspace, workspace.folder);
}

/** A window's folder changed — it opened another one, or closed its own. */
export function setWorkspaceFolder(workspace: Workspace, folder: WorkspaceFolder): void {
  const next = folderOf(folder);
  if (sameFolder(workspace.folder, next)) return;
  const before = workspace.folder;
  workspace.folder = next;
  // It has opened a folder: whatever it was opened for is settled.
  if (folderKey(next)) delete workspace.pending;
  if (open.get(workspace.id) === workspace) tell("folder", workspace, before);
}

/**
 * The folder the settings file names, as a window of this run last wrote
 * it (state.ts writeState); null while none has. The desktop app keeps it
 * beside its window list, to tell a folder switched elsewhere — in the web
 * version — from one of its own windows' (src/electron/windowSession.ts).
 */
let written: WorkspaceFolder | null = null;

export function noteSettingsFolder(folder: WorkspaceFolder): void {
  written = folderOf(folder);
}

export function settingsFolderWritten(): WorkspaceFolder | null {
  return written;
}

/** The open workspaces, in the order they were opened. */
export function workspaces(): Workspace[] {
  return [...open.values()];
}

export function workspaceById(id: string): Workspace | null {
  return open.get(id) ?? null;
}

/** Hear every window open, close and change folder; the answer stops listening. */
export function onWorkspaceChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The workspace this call chain runs in, or null: no window is behind it. */
export function currentWorkspace(): Workspace | null {
  return active.getStore() ?? null;
}

/** Run `fn` as a window's own work: every settings read inside sees that window's folder. */
export function runInWorkspace<T>(workspace: Workspace | null, fn: () => T): T {
  return active.run(workspace, fn);
}

/**
 * Run `fn` as nobody's work. What outlives the request that started it — a
 * timer, a file watcher, a loop — is started here, or it would go on reading
 * the folder of the window that happened to start it.
 */
export function detached<T>(fn: () => T): T {
  return active.run(null, fn);
}

/** For the tests: no window is open. Who listens goes on listening. */
export function resetWorkspaces(): void {
  open.clear();
  written = null;
}
