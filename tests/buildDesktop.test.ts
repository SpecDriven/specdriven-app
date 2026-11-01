// Automates specs/app/desktop-app.feature.md "Packaging": which platforms
// `bun run build:desktop` packages, and what it refuses to attempt.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMERGE_WASM,
  CBOR_EXTRACT_DIR,
  PATCH_MANIFEST_FILE,
  bakedPaths,
  buildMode,
  bundleOptions,
  rewriteBakedModule,
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
  expect(electronBuilderArgs(["mac", "linux"], "release", "arm64")).toEqual(["--mac", "--linux"]);
});

test("--local packages only the installer this machine starts, for its own architecture", () => {
  // No .deb: its fpm needs libcrypt.so.1, which Arch and friends lack.
  expect(electronBuilderArgs(["linux"], "local", "arm64")).toEqual(["--linux", "AppImage", "--arm64"]);
  expect(electronBuilderArgs(["linux"], "local", "x64")).toEqual(["--linux", "AppImage", "--x64"]);
  // Electron 44 stopped publishing 32-bit ARM binaries: say so instead of
  // letting electron-builder fail on a download it cannot make.
  expect(() => electronBuilderArgs(["linux"], "local", "arm")).toThrow(/32-bit ARM/);
  expect(electronBuilderArgs(["mac"], "local", "arm64")).toEqual(["--mac", "dmg", "--arm64"]);
  // Windows gets the app itself, unpacked, which install.ps1 starts in place.
  expect(electronBuilderArgs(["win"], "local", "x64")).toEqual(["--win", "dir", "--x64"]);
  expect(electronBuilderArgs(["win"], "local", "arm64")).toEqual(["--win", "dir", "--arm64"]);
  expect(() => electronBuilderArgs(["linux"], "local", "ppc64")).toThrow(/ppc64 architecture/);
});

// release.yml builds each Windows installer on a runner of its architecture:
// cbor-extract's native module is only installed for the machine bun ran on.
test("--host-arch packages the release installers for this machine's architecture only", () => {
  expect(electronBuilderArgs(["win"], "host-arch", "x64")).toEqual(["--win", "nsis", "--x64"]);
  expect(electronBuilderArgs(["win"], "host-arch", "arm64")).toEqual(["--win", "nsis", "--arm64"]);
  expect(electronBuilderArgs(["linux"], "host-arch", "x64")).toEqual(["--linux", "AppImage", "deb", "--x64"]);
  expect(electronBuilderArgs(["mac"], "host-arch", "arm64")).toEqual(["--mac", "dmg", "zip", "--arm64"]);
  expect(buildMode(["--win", "--host-arch"])).toEqual({ mode: "host-arch", rest: ["--win"] });
  expect(buildMode(["--local"])).toEqual({ mode: "local", rest: [] });
  expect(buildMode(["--all"])).toEqual({ mode: "release", rest: ["--all"] });
  expect(() => buildMode(["--local", "--host-arch"])).toThrow(/do not go together/);
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

// The bundle is self-contained: a cross-built .deb or a copied .app starts on
// a machine that has no node_modules at the builder's path. Bun bakes a
// bundled dependency's `__dirname` in as an absolute string; the two that
// read files by it are rewritten to look beside the bundle instead.
test("Automerge's nodejs entry reads its wasm from beside the bundle, not the builder's node_modules", () => {
  const path = "/builder/node_modules/@automerge/automerge/dist/mjs/wasm_bindgen_output/nodejs/automerge_wasm.cjs";
  const source = "const wasmPath = `${__dirname}/automerge_wasm_bg.wasm`;\nconst wasmBytes = require('fs').readFileSync(wasmPath);\n";
  const rewritten = rewriteBakedModule(path, source)!;
  expect(rewritten).not.toContain("__dirname");
  expect(rewritten).toContain(`bundleAssetPath(${JSON.stringify(AUTOMERGE_WASM)})`);
  expect(rewritten).toContain("readFileSync(wasmPath)");
  // The Windows path spelling matches too.
  expect(rewriteBakedModule(path.replaceAll("/", "\\"), source)).not.toBeNull();
  // An Automerge release that loads its wasm some other way fails the build rather than ship a surprise.
  expect(() => rewriteBakedModule(path, "const wasmBytes = fetch('x');")).toThrow(/no longer reads its wasm from __dirname/);
});

test("cbor-extract hands its loader the cbor-extract/ directory beside the bundle", () => {
  const rewritten = rewriteBakedModule("/builder/node_modules/cbor-extract/index.js", "module.exports = require('node-gyp-build-optional-packages')(__dirname)\n")!;
  expect(rewritten).not.toContain("__dirname");
  expect(rewritten).toContain(`bundleAssetPath(${JSON.stringify(CBOR_EXTRACT_DIR)})`);
  expect(rewritten).toContain("node-gyp-build-optional-packages");
  // Its platform packages, and everything else, bundle as they are.
  expect(rewriteBakedModule("/builder/node_modules/@cbor-extract/cbor-extract-darwin-arm64/index.js", "")).toBeNull();
  expect(rewriteBakedModule("/builder/node_modules/@automerge/automerge/dist/mjs/wasm_bindgen_output/web/automerge_wasm.js", "")).toBeNull();
});

test("a bundle that still bakes a build-machine path in is caught", () => {
  const bundle = [
    'var __dirname = "/Users/builder/app/node_modules/@automerge/automerge/dist/mjs/wasm_bindgen_output/nodejs", $Automerge;',
    '  var __dirname = "/Users/builder/app/node_modules/cbor-extract";',
    '  var __filename = "C:\\\\builder\\\\app\\\\node_modules\\\\x\\\\index.js";',
    'const wasmPath = bundleAssetPath("automerge_wasm_bg.wasm");',
  ].join("\n");
  expect(bakedPaths(bundle)).toEqual([
    "/Users/builder/app/node_modules/@automerge/automerge/dist/mjs/wasm_bindgen_output/nodejs",
    "/Users/builder/app/node_modules/cbor-extract",
    "C:\\\\builder\\\\app\\\\node_modules\\\\x\\\\index.js",
  ]);
  expect(bakedPaths('const wasmPath = bundleAssetPath("automerge_wasm_bg.wasm");')).toEqual([]);
});
