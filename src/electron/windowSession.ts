// The desktop app's windows across a restart, and which window a request
// came from (specs/app/multiple-windows.feature.md "Closing and
// restarting"): every window open at quit comes back with its folder and its
// place on screen, and a folder opened again comes back where its window was
// left. Kept in `window-state.json` in the app-data directory, which held
// one window's geometry before there were several
// (src/electron/windowState.ts) — such a file still reads, as that one
// window. Pure rules and parsing, kept out of main.ts so they run under
// bun test.

import { readFileSync, writeFileSync } from "node:fs";
import { folderKey, folderOf, type WorkspaceFolder } from "../server/workspace";
import { parseWindowState, type WindowState } from "./windowState";

export interface SavedWindow {
  /** The folder it shows; empty for a window that asks for one. */
  folder: WorkspaceFolder;
  /** Where it was on screen; absent, the default place. */
  bounds?: WindowState;
  /** The window used last: the one in front after a restart. */
  focused?: boolean;
}

export interface WindowSession {
  /** The windows to bring back, in the order they were opened. */
  windows: SavedWindow[];
  /** Where each folder's window was last, by folder (workspace.ts folderKey). */
  bounds: Record<string, WindowState>;
  /**
   * The folder the settings file named when this was saved. A different
   * one at the next start was picked elsewhere — in the web version, which
   * shares the settings (specs/app/desktop-app.feature.md "desktop and web
   * share settings") — and is opened.
   */
  mirror?: WorkspaceFolder;
}

/** How many folders' places are remembered; the least recently saved go first. */
export const MAX_REMEMBERED_BOUNDS = 30;

function bounds(value: unknown): WindowState | undefined {
  return parseWindowState(typeof value === "object" && value !== null ? JSON.stringify(value) : null) ?? undefined;
}

function folder(value: unknown): WorkspaceFolder {
  return typeof value === "object" && value !== null ? folderOf(value as Record<string, unknown>) : {};
}

/**
 * Persisted JSON -> the session; null for missing, corrupt or wrong-shaped
 * data. A file from before there were several windows — one window's
 * geometry — is a session with no windows named and that geometry kept for
 * whichever folder opens first (`bounds[""]`).
 */
export function parseWindowSession(raw: string | null): WindowSession | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.version !== 2) {
    const legacy = parseWindowState(raw);
    return legacy ? { windows: [], bounds: { "": legacy } } : null;
  }
  const windows: SavedWindow[] = [];
  for (const row of Array.isArray(record.windows) ? record.windows : []) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const place = bounds(r.bounds);
    windows.push({ folder: folder(r.folder), ...(place ? { bounds: place } : {}), ...(r.focused === true ? { focused: true } : {}) });
  }
  const remembered: Record<string, WindowState> = {};
  if (typeof record.bounds === "object" && record.bounds !== null) {
    for (const [key, value] of Object.entries(record.bounds as Record<string, unknown>)) {
      const place = bounds(value);
      if (place) remembered[key] = place;
    }
  }
  const mirror = record.mirror === undefined ? undefined : folder(record.mirror);
  return { windows, bounds: remembered, ...(mirror ? { mirror } : {}) };
}

/**
 * The windows the app starts with: those the last run left open, each on
 * its folder. One window, on the folder the settings name, when none were
 * left or nothing was saved. A folder twice is one window, and a window
 * with no folder comes back only when it is the only one.
 *
 * `settings` is the folder the settings file names now. When that is not
 * the folder this app last wrote there and no window shows it, it was
 * picked elsewhere since: the window used last opens it.
 */
export function planRestore(session: WindowSession | null, settings: WorkspaceFolder): SavedWindow[] {
  const settingsKey = folderKey(settings);
  const remembered = (key: string) => session?.bounds[key] ?? session?.bounds[""];
  const seen = new Set<string>();
  let windows: SavedWindow[] = [];
  for (const window of session?.windows ?? []) {
    const key = folderKey(window.folder);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    windows.push({ ...window, folder: folderOf(window.folder) });
  }
  if (windows.length === 0) {
    const place = remembered(settingsKey);
    return [{ folder: folderOf(settings), ...(place ? { bounds: place } : {}), focused: true }];
  }
  const front = Math.max(0, windows.findIndex((w) => w.focused));
  const pickedElsewhere =
    settingsKey !== "" && !seen.has(settingsKey) && settingsKey !== folderKey(session?.mirror ?? {});
  if (pickedElsewhere) {
    const place = session?.bounds[settingsKey] ?? windows[front]!.bounds;
    windows[front] = { folder: folderOf(settings), ...(place ? { bounds: place } : {}) };
  }
  windows = windows.map((w, i) => {
    const { focused: _focused, ...rest } = w;
    return i === front ? { ...rest, focused: true } : rest;
  });
  return windows;
}

/** `session` with a folder's place on screen remembered; the oldest go when there are too many. */
export function rememberBounds(session: WindowSession, key: string, place: WindowState): WindowSession {
  const { [key]: _old, ...rest } = session.bounds;
  const entries = [...Object.entries(rest), [key, place] as const];
  return { ...session, bounds: Object.fromEntries(entries.slice(-MAX_REMEMBERED_BOUNDS)) };
}

/**
 * The session to save for the windows open now. A window with no folder is
 * not kept; with none left to keep — the last window was just closed, which
 * on macOS leaves the app running — the windows saved before stay, so that
 * window is the one that comes back.
 */
export function sessionFor(
  before: WindowSession,
  open: readonly SavedWindow[],
  mirror: WorkspaceFolder | undefined,
): WindowSession {
  let session: WindowSession = { ...before, ...(mirror ? { mirror: folderOf(mirror) } : {}) };
  const kept = open.filter((w) => folderKey(w.folder) !== "");
  // A window with no folder has its place remembered too, under no folder:
  // where the app's window was, for a folder that has no place of its own.
  for (const window of open) {
    if (window.bounds) session = rememberBounds(session, folderKey(window.folder), window.bounds);
  }
  if (kept.length > 0) {
    const windows = kept.map((w) => ({ ...w, folder: folderOf(w.folder) }));
    session = { ...session, windows: windows.some((w) => w.focused) ? windows : [{ ...windows[0]!, focused: true }, ...windows.slice(1)] };
  }
  return session;
}

/** The session from the file, or null when it is missing or unreadable. */
export function loadWindowSession(file: string): WindowSession | null {
  try {
    return parseWindowSession(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort write (sync: it must land before the app quits); a failure loses only what was remembered. */
export function saveWindowSession(file: string, session: WindowSession): void {
  try {
    writeFileSync(file, JSON.stringify({ version: 2, ...session }));
  } catch {
    // Ignored — the next launch opens one window at the default size.
  }
}

// ---- which window a request came from --------------------------------------
//
// Every window loads the app from the one origin, so a request does not say
// which window sent it. The shell marks each window's requests twice:
// a header set where the request leaves the window (session.webRequest),
// which every request a page makes carries — its navigations too — and a
// token in the window's User-Agent, which a request made from inside a
// worker carries though the first mark never reaches it. Checked on
// Electron 45: between them only a worker's own script file goes unmarked,
// and that is a bundled file, the same for every folder.

/** The header the shell sets on a window's requests: the window's id. */
export const WINDOW_HEADER = "x-specdriven-window";

const UA_TOKEN = /\bSpecDrivenWindow\/([\w-]+)/;

/** A window's User-Agent: the default with the window's id appended. */
export function windowUserAgent(base: string, id: string): string {
  return `${base.replace(/\s*\bSpecDrivenWindow\/[\w-]+/g, "")} SpecDrivenWindow/${id}`;
}

/** The id of the window a request came from, by either mark; null for an unmarked request. */
export function windowIdOf(headers: Headers): string | null {
  const header = headers.get(WINDOW_HEADER)?.trim();
  if (header) return header;
  return UA_TOKEN.exec(headers.get("user-agent") ?? "")?.[1] ?? null;
}

/**
 * Whose request it is, among `open` windows' ids. One open window is asked
 * nothing: every request is its own. With several, a request that names
 * none of them is nobody's — it is refused rather than answered for a
 * folder its page may not be showing.
 */
export function requestWindow(headers: Headers, open: readonly string[]): string | null {
  if (open.length === 1) return open[0]!;
  const id = windowIdOf(headers);
  return id !== null && open.includes(id) ? id : null;
}
