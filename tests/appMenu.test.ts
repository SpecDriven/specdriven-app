// The application menu (src/electron/appMenu.ts): Check for Updates… where
// each platform keeps it, the Debug menu only where it is given.
import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate, CHECK_FOR_UPDATES, EXTRACT_SPECS, NEW_WINDOW, OPEN_FOLDER, OPEN_RECENT } from "../src/electron/appMenu";

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

// specs/app/multiple-windows.feature.md "Opening a window".
describe("the File menu's window items", () => {
  const file = (recent: string[], heard: string[]) => ({
    onNewWindow: () => heard.push("new"),
    onOpenFolder: () => heard.push("open"),
    recent: recent.map((label) => ({ label, onOpen: () => heard.push(label) })),
  });

  test("File holds New Window, Open Folder… and the recent folders, each opening a window", () => {
    const heard: string[] = [];
    const menu = appMenuTemplate({ platform: "darwin", onCheckForUpdates: () => {}, file: file(["/specs/a", "/code/b"], heard) });
    const items = menu[1]!.submenu as MenuItemConstructorOptions[];
    expect(menu[1]!.label).toBe("File");
    expect(labels(items)).toEqual([NEW_WINDOW, OPEN_FOLDER, OPEN_RECENT, "separator", "close"]);
    const recent = items[2]!.submenu as MenuItemConstructorOptions[];
    expect(labels(recent)).toEqual(["/specs/a", "/code/b"]);
    (items[0]!.click as () => void)();
    (items[1]!.click as () => void)();
    (recent[1]!.click as () => void)();
    expect(heard).toEqual(["new", "open", "/code/b"]);
  });

  test("with no recent folders the submenu says so, and File ends in Quit off macOS", () => {
    const menu = appMenuTemplate({ platform: "linux", onCheckForUpdates: () => {}, file: file([], []) });
    const items = menu[0]!.submenu as MenuItemConstructorOptions[];
    expect(labels(items).at(-1)).toBe("quit");
    expect(items[2]!.submenu).toEqual([{ label: "No Recent Folders", enabled: false }]);
  });

  // specs/app/extract-specs-from-code.feature.md "From the desktop app's File menu".
  test("File offers Extract Specs from Code Project… where the shell can start it", () => {
    const heard: string[] = [];
    const menu = appMenuTemplate({
      platform: "darwin",
      onCheckForUpdates: () => {},
      file: { ...file(["/specs/a"], heard), onExtractSpecs: () => heard.push("extract") },
    });
    const items = menu[1]!.submenu as MenuItemConstructorOptions[];
    expect(labels(items)).toEqual([NEW_WINDOW, OPEN_FOLDER, OPEN_RECENT, "separator", EXTRACT_SPECS, "separator", "close"]);
    (items[4]!.click as () => void)();
    expect(heard).toEqual(["extract"]);
  });

  test("without them the standard File menu stays", () => {
    expect(appMenuTemplate({ platform: "darwin", onCheckForUpdates: () => {} })[1]).toEqual({ role: "fileMenu" });
  });
});
