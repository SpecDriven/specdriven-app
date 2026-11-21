// Automates specs/app/multiple-windows.feature.md "each window is named
// after its folder": the title the desktop shell gives a window
// (src/electron/windowTitle.ts), which is what the Dock menu, the Window
// menu and the task switcher list it by.

import { expect, test } from "bun:test";
import { windowFolderName, windowTitle } from "../src/electron/windowTitle";

test("a window is titled with its folder's name, then the page open in it", () => {
  expect(windowTitle("SpecDriven", "specs-insurance")).toBe("specs-insurance");
  expect(windowTitle("SpecDriven — Checkout", "specs-insurance")).toBe("specs-insurance — Checkout");
  expect(windowTitle("SpecDriven — Checkout · pays by card v2", "specs-insurance")).toBe(
    "specs-insurance — Checkout · pays by card v2",
  );
  expect(windowTitle("SpecDriven — Settings", "specs-insurance")).toBe("specs-insurance — Settings");
  // A code repository's home page is the repository: its name is not said twice.
  expect(windowTitle("SpecDriven — bookshop", "bookshop")).toBe("bookshop");
  // A running pomodoro's clock stays in front.
  expect(windowTitle("12:34 · SpecDriven — Checkout", "specs-insurance")).toBe("12:34 · specs-insurance — Checkout");
  expect(windowTitle("12:34 · SpecDriven", "specs-insurance")).toBe("12:34 · specs-insurance");
});

test("a window with no folder keeps its page's title, and a title that is not the app's is kept whole", () => {
  expect(windowTitle("SpecDriven", null)).toBe("SpecDriven");
  expect(windowTitle("SpecDriven — Settings", null)).toBe("SpecDriven — Settings");
  expect(windowTitle("", null)).toBe("SpecDriven");
  expect(windowTitle("", "specs-insurance")).toBe("specs-insurance");
  expect(windowTitle("localhost", "specs-insurance")).toBe("specs-insurance — localhost");
});

test("a window goes by its code repository, else its specifications folder", () => {
  expect(windowFolderName({ dataRepo: "/work/specs-insurance" })).toBe("specs-insurance");
  expect(windowFolderName({ dataRepo: "https://github.com/acme/specs-claims.git" })).toBe("specs-claims");
  // A code repository opened in place of the specifications folder it came from.
  expect(windowFolderName({ dataRepo: "/work/specs-insurance", openCodeRepo: "/work/bookshop" })).toBe("bookshop");
  expect(windowFolderName({})).toBeNull();
});
