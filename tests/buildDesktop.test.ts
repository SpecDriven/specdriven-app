// Automates specs/app/desktop-app.feature.md "Packaging": which platforms
// `bun run build:desktop` packages, and what it refuses to attempt.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATCH_MANIFEST_FILE,
  bundleOptions,
  electronBuilderArgs,
  patchManifest,
  selectPlatforms,
  writePatchManifest,
} from "../scripts/build-desktop";

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

// specs/app/self-healing.feature.md: a self-fix rebuilds the bundles alone,
// under the installed source, and leaves dist/patch.json for the boot shim.
test("--bundle-only skips the installers, and --fix names the fix the bundle is for", () => {
  expect(bundleOptions([])).toEqual({ bundleOnly: false, fixId: null, rest: [] });
  expect(bundleOptions(["--local"])).toEqual({ bundleOnly: false, fixId: null, rest: ["--local"] });
  expect(bundleOptions(["--bundle-only"])).toEqual({ bundleOnly: true, fixId: null, rest: [] });
  expect(bundleOptions(["--bundle-only", "--fix", "abc"])).toEqual({ bundleOnly: true, fixId: "abc", rest: [] });
  expect(() => bundleOptions(["--bundle-only", "--fix"])).toThrow(/needs the fix's id/);
  expect(() => bundleOptions(["--bundle-only", "--fix", "--local"])).toThrow(/needs the fix's id/);
  expect(() => bundleOptions(["--fix", "abc"])).toThrow(/goes with --bundle-only/);
});

test("the manifest names the app version and the fix; a build without a fix removes a stale one", async () => {
  const manifest = patchManifest("0.1.157", "abc", new Date("2026-10-19T10:00:00Z"));
  expect(manifest).toEqual({ appVersion: "0.1.157", builtAt: "2026-10-19T10:00:00.000Z", fixId: "abc" });
  const dist = await mkdtemp(join(tmpdir(), "specdriven-dist-"));
  try {
    await writePatchManifest(dist, "abc", "0.1.157");
    expect(JSON.parse(await readFile(join(dist, PATCH_MANIFEST_FILE), "utf8"))).toMatchObject({ fixId: "abc", appVersion: "0.1.157" });
    // The next ordinary build — an upgrade's — takes it away.
    await writePatchManifest(dist, null);
    expect(existsSync(join(dist, PATCH_MANIFEST_FILE))).toBe(false);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});
