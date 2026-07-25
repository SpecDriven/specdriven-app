// Automates specs/desktop-app.spec.md "Packaging": which platforms
// `bun run build:desktop` packages, and what it refuses to attempt.
import { test, expect } from "bun:test";
import { selectPlatforms } from "../scripts/build-desktop";

test("without flags the build targets the machine it runs on", () => {
  expect(selectPlatforms([], "darwin")).toEqual(["mac"]);
  expect(selectPlatforms([], "linux")).toEqual(["linux"]);
});

test("a Mac cross-builds the Linux app", () => {
  expect(selectPlatforms(["--linux"], "darwin")).toEqual(["linux"]);
  expect(selectPlatforms(["--all"], "darwin")).toEqual(["mac", "linux"]);
});

test("the macOS app is only built on macOS", () => {
  expect(() => selectPlatforms(["--mac"], "linux")).toThrow(/only be built on macOS/);
  expect(() => selectPlatforms(["--all"], "linux")).toThrow(/only be built on macOS/);
});

test("an unsupported host or a mistyped flag stops before packaging", () => {
  expect(() => selectPlatforms([], "win32")).toThrow(/no desktop build for win32/);
  expect(() => selectPlatforms(["--linx"], "darwin")).toThrow(/unknown option --linx/);
});
