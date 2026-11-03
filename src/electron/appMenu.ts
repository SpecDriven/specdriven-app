// The application menu (specs/app/desktop-app.feature.md "Window",
// specs/app/app-updates.feature.md "Check for Updates…"): Electron's
// standard roles, plus Check for Updates… where each platform keeps it — the
// app menu on macOS, Help elsewhere — and, in a development run, the Debug
// menu (src/electron/debugger.ts). A template, so it tests without Electron.

import type { MenuItemConstructorOptions } from "electron";

export const CHECK_FOR_UPDATES = "Check for Updates…";

export interface AppMenuInput {
  platform: NodeJS.Platform;
  onCheckForUpdates: () => void;
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
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(input.debug ? [{ label: "Debug", submenu: input.debug }] : []),
    ...(mac ? [] : [{ role: "help" as const, submenu: [check] }]),
  ];
}
