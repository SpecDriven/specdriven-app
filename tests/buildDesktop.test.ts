// Automates specs/app/desktop-app.feature.md "Packaging": which platforms
// `bun run build:desktop` packages, and what it refuses to attempt.
import { test, expect } from "bun:test";
import { electronBuilderArgs, selectPlatforms } from "../scripts/build-desktop";

test("without flags the build targets the machine it runs on", () => {
  expect(selectPlatforms([], "darwin")).toEqual(["mac"]);
  expect(selectPlatforms([], "linux")).toEqual(["linux"]);
  expect(selectPlatforms([], "win32")).toEqual(["win"]);
});

test("a Mac cross-builds the Linux app", () => {
  expect(selectPlatforms(["--linux"], "darwin")).toEqual(["linux"]);
  expect(selectPlatforms(["--all"], "darwin")).toEqual(["mac", "linux"]);
});

test("the macOS app is only built on macOS", () => {
  expect(() => selectPlatforms(["--mac"], "linux")).toThrow(/only be built on macOS/);
  expect(() => selectPlatforms(["--all"], "linux")).toThrow(/only be built on macOS/);
});

test("the Windows app is only built on Windows, and --all leaves it out", () => {
  expect(selectPlatforms(["--win"], "win32")).toEqual(["win"]);
  expect(() => selectPlatforms(["--win"], "darwin")).toThrow(/only be built on Windows/);
  expect(() => selectPlatforms(["--win"], "linux")).toThrow(/only be built on Windows/);
  // --all is the release a Mac cuts; asking for it on Windows asks for macOS.
  expect(() => selectPlatforms(["--all"], "win32")).toThrow(/only be built on macOS/);
});

test("an unsupported host or a mistyped flag stops before packaging", () => {
  expect(() => selectPlatforms([], "freebsd")).toThrow(/no desktop build for freebsd/);
  expect(() => selectPlatforms(["--linx"], "darwin")).toThrow(/unknown option --linx/);
});

test("a release build packages every target and architecture in package.json", () => {
  expect(electronBuilderArgs(["mac", "linux"], false, "arm64")).toEqual(["--mac", "--linux"]);
});

test("--local packages only the installer this machine starts, for its own architecture", () => {
  // No .deb: its fpm needs libcrypt.so.1, which Arch and friends lack.
  expect(electronBuilderArgs(["linux"], true, "arm64")).toEqual(["--linux", "AppImage", "--arm64"]);
  expect(electronBuilderArgs(["linux"], true, "x64")).toEqual(["--linux", "AppImage", "--x64"]);
  expect(electronBuilderArgs(["linux"], true, "arm")).toEqual(["--linux", "AppImage", "--armv7l"]);
  expect(electronBuilderArgs(["mac"], true, "arm64")).toEqual(["--mac", "dmg", "--arm64"]);
  // Windows gets the app itself, unpacked, which install.ps1 starts in place.
  expect(electronBuilderArgs(["win"], true, "x64")).toEqual(["--win", "dir", "--x64"]);
  expect(electronBuilderArgs(["win"], true, "arm64")).toEqual(["--win", "dir", "--arm64"]);
  expect(() => electronBuilderArgs(["linux"], true, "ppc64")).toThrow(/ppc64 architecture/);
});
