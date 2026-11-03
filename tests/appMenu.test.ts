// The application menu (src/electron/appMenu.ts): Check for Updates… where
// each platform keeps it, the Debug menu only where it is given.
import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate, CHECK_FOR_UPDATES } from "../src/electron/appMenu";

function labels(items: MenuItemConstructorOptions[] | undefined): (string | undefined)[] {
  return (items ?? []).map((i) => (i.type === "separator" ? "separator" : (i.label ?? i.role)));
}

describe("Check for Updates… in the application menu", () => {
  test("on macOS it sits in the app menu, under About; elsewhere under Help", () => {
    let clicked = 0;
    const mac = appMenuTemplate({ platform: "darwin", onCheckForUpdates: () => clicked++ });
    expect(mac.map((m) => m.role)).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu"]);
    const appMenu = mac[0]!.submenu as MenuItemConstructorOptions[];
    expect(labels(appMenu).slice(0, 3)).toEqual(["about", "separator", CHECK_FOR_UPDATES]);
    expect(labels(appMenu).at(-1)).toBe("quit");
    (appMenu[2]!.click as () => void)();
    expect(clicked).toBe(1);

    const linux = appMenuTemplate({ platform: "linux", onCheckForUpdates: () => clicked++ });
    expect(linux.map((m) => m.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
    expect(labels(linux.at(-1)!.submenu as MenuItemConstructorOptions[])).toEqual([CHECK_FOR_UPDATES]);
    expect(appMenuTemplate({ platform: "win32", onCheckForUpdates: () => {} }).at(-1)!.role).toBe("help");
  });

  test("the Debug menu is there only when given — a development run", () => {
    const debug = [{ label: "Main-Process Debugger…" }];
    const dev = appMenuTemplate({ platform: "darwin", onCheckForUpdates: () => {}, debug });
    expect(dev.map((m) => m.label ?? m.role)).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu", "Debug"]);
    expect(dev.at(-1)!.submenu).toBe(debug);
    expect(appMenuTemplate({ platform: "darwin", onCheckForUpdates: () => {} }).some((m) => m.label === "Debug")).toBe(false);
  });
});
