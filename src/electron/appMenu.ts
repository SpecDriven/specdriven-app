// The application menu (specs/app/desktop-app.feature.md "Window",
// specs/app/app-updates.feature.md "Check for Updates…"): Electron's
// standard roles, plus Check for Updates… where each platform keeps it — the
// app menu on macOS, Help elsewhere — the File menu's New Window, Open
// Folder… and Open Recent (specs/app/multiple-windows.feature.md), its
// Extract Specs from Code Project… (specs/app/extract-specs-from-code.
// feature.md) and, in a development run, the Debug menu
// (src/electron/debugger.ts). A template, so it tests without Electron.

import type { MenuItemConstructorOptions } from "electron";

export const CHECK_FOR_UPDATES = "Check for Updates…";

/** One row of File → Open Recent. */
export interface RecentItem {
  /** The folder as the recent list names it. */
  label: string;
  onOpen: () => void;
}

/**
 * The File menu's window items (specs/app/multiple-windows.feature.md
 * "Opening a window"): each opens a window, never changes the one in front.
 */
export interface FileMenuInput {
  onNewWindow: () => void;
  onOpenFolder: () => void;
  /** The recent folders, most recent first. */
  recent: RecentItem[];
  /**
   * Start "Extract specs from a code project" in the window in front
   * (specs/app/extract-specs-from-code.feature.md); absent, no such item.
   */
  onExtractSpecs?: () => void;
}

export const NEW_WINDOW = "New Window";
export const OPEN_FOLDER = "Open Folder…";
export const OPEN_RECENT = "Open Recent";
export const EXTRACT_SPECS = "Extract Specs from Code Project…";

function fileMenu(input: FileMenuInput, mac: boolean): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      { id: "new-window", label: NEW_WINDOW, accelerator: "CmdOrCtrl+Shift+N", click: input.onNewWindow },
      { id: "open-folder", label: OPEN_FOLDER, accelerator: "CmdOrCtrl+O", click: input.onOpenFolder },
      {
        id: "open-recent",
        label: OPEN_RECENT,
        submenu:
          input.recent.length > 0
            ? input.recent.map((r) => ({ label: r.label, click: r.onOpen }))
            : [{ label: "No Recent Folders", enabled: false }],
      },
      ...(input.onExtractSpecs
        ? [
            { type: "separator" as const },
            { id: "extract-specs", label: EXTRACT_SPECS, click: input.onExtractSpecs },
          ]
        : []),
      { type: "separator" },
      // What the standard File menu holds: Close Window on macOS, Quit elsewhere.
      mac ? { role: "close" } : { role: "quit" },
    ],
  };
}

export interface AppMenuInput {
  platform: NodeJS.Platform;
  onCheckForUpdates: () => void;
  /** The File menu's window items; absent, the standard File menu. */
  file?: FileMenuInput;
  /** The Debug submenu, in a development run; nothing in a packaged app. */
  debug?: MenuItemConstructorOptions[];
}

export function appMenuTemplate(input: AppMenuInput): MenuItemConstructorOptions[] {
  const check: MenuItemConstructorOptions = { id: "check-for-updates", label: CHECK_FOR_UPDATES, click: input.onCheckForUpdates };
  const mac = input.platform === "darwin";
  return [
    ...(mac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              check,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    input.file ? fileMenu(input.file, mac) : { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(input.debug ? [{ label: "Debug", submenu: input.debug }] : []),
    ...(mac ? [] : [{ role: "help" as const, submenu: [check] }]),
  ];
}
