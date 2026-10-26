#!/usr/bin/env bun
/**
 * Builds the desktop app (specs/app/desktop-app.feature.md "Packaging"):
 *
 *   bun run build:desktop            this machine's platform
 *   bun run build:desktop --mac      release/SpecDriven-<version>-arm64.dmg (+ zip)
 *   bun run build:desktop --linux    release/SpecDriven-<version>-<arch>.AppImage (+ deb)
 *   bun run build:desktop --win      release/SpecDriven Setup <version>.exe (on Windows only)
 *   bun run build:desktop --all      macOS and Linux, the release set
 *   bun run build:desktop --local    only what runs here: this machine's
 *                                    platform and architecture, as the
 *                                    AppImage (Linux), .dmg (macOS) or
 *                                    unpacked SpecDriven.exe (Windows)
 *   bun run build:desktop --bundle-only [--fix <id>]
 *                                    the bundles alone, no installer: what a
 *                                    self-fix rebuilds under the installed
 *                                    source, with dist/patch.json naming the
 *                                    fix so the boot shim picks it up
 *                                    (specs/app/self-healing.feature.md)
 *
 * Three steps: bundle the frontend into static files (served over the
 * app:// protocol), bundle the Electron main process, then hand both to
 * electron-builder. The web build (`bun run build`) is separate and
 * untouched. Targets and architectures live under "build" in package.json.
 *
 * macOS signing: the .app is code-signed with the Developer ID Application
 * identity in the login keychain (electron-builder finds it on its own).
 * Notarization is off for now — package.json pins `build.mac.notarize` to
 * false. It carries no comments, so the future setup lives here:
 *
 *   1. package.json, under "build":
 *
 *        "mac": {
 *          "notarize": { "teamId": "<APPLE_TEAM_ID>" },
 *          "hardenedRuntime": true,
 *          "gatekeeperAssess": false
 *        },
 *        "afterSign": "scripts/notarize.ts"   // only if a custom hook is needed
 *
 *   2. Export the Apple credentials before building (Bun loads .env, which
 *      already holds APPLE_TEAM_ID):
 *
 *        APPLE_ID=<apple-id-email>
 *        APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password>
 *        APPLE_TEAM_ID=<team-id>
 *
 *   3. Verify the result: `xcrun stapler validate release/mac-arm64/SpecDriven.app`
 */
import { $, type BunPlugin } from "bun";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { version } from "../package.json";
import type { PatchManifest } from "../src/electron/bootPolicy";

export type Platform = "mac" | "linux" | "win";

const PLATFORMS: Platform[] = ["mac", "linux", "win"];

/** What `--all` packages: everything one Mac can cut a release of. */
const RELEASE_PLATFORMS: Platform[] = ["mac", "linux"];

/** Which platform a given `process.platform` builds for by default. */
export function hostPlatform(osPlatform: string): Platform | null {
  if (osPlatform === "darwin") return "mac";
  if (osPlatform === "linux") return "linux";
  if (osPlatform === "win32") return "win";
  return null;
}

/**
 * Resolves `--mac` / `--linux` / `--win` / `--all` against the host, and
 * rejects what this machine cannot build. macOS artifacts need macOS tooling
 * (hdiutil, codesign); Linux ones cross-build from macOS. Windows ones are
 * built on Windows, by install.ps1 — off Windows, electron-builder needs Wine
 * to stamp the executable's resources.
 */
export function selectPlatforms(args: string[], osPlatform: string): Platform[] {
  const known = ["--all", ...PLATFORMS.map((p) => `--${p}`)];
  const unknown = args.find((arg) => !known.includes(arg));
  if (unknown) throw new Error(`unknown option ${unknown} — expected ${known.join(", ")}`);

  const host = hostPlatform(osPlatform);
  let selected = args.includes("--all")
    ? [...RELEASE_PLATFORMS]
    : PLATFORMS.filter((p) => args.includes(`--${p}`));
  if (selected.length === 0) {
    if (!host) throw new Error(`no desktop build for ${osPlatform} — pass --mac or --linux`);
    selected = [host];
  }
  if (selected.includes("mac") && host !== "mac") {
    throw new Error("the macOS app can only be built on macOS");
  }
  if (selected.includes("win") && host !== "win") {
    throw new Error("the Windows app can only be built on Windows");
  }
  return selected;
}

/**
 * What `--local` packages: what install.sh starts or opens, and what
 * install.ps1 starts — on Windows the unpacked app (`dir`), run in place
 * from release/win-unpacked rather than installed a second time.
 */
const LOCAL_TARGET: Record<Platform, string> = { linux: "AppImage", mac: "dmg", win: "dir" };

/** electron-builder's architecture flag for a `process.arch`. */
export function archFlag(osArch: string): string {
  if (osArch === "x64" || osArch === "arm64") return `--${osArch}`;
  if (osArch === "arm") return "--armv7l";
  throw new Error(`no desktop build for the ${osArch} architecture`);
}

/**
 * The electron-builder arguments. A release build takes the targets and
 * architectures in package.json; `--local` narrows that to the host's own
 * architecture and runnable installer. That keeps install.sh off the .deb,
 * whose fpm runs a bundled Ruby that needs libcrypt.so.1 — which Arch and
 * other non-Debian distros lack — and off cross-architecture builds nobody
 * on that machine will start.
 */
export function electronBuilderArgs(platforms: Platform[], local: boolean, osArch: string): string[] {
  if (!local) return platforms.map((p) => `--${p}`);
  const [platform] = platforms;
  return [`--${platform}`, LOCAL_TARGET[platform!], archFlag(osArch)];
}

/** `--bundle-only [--fix <id>]`, parsed; the rest of the arguments follow. */
export function bundleOptions(args: string[]): { bundleOnly: boolean; fixId: string | null; rest: string[] } {
  const rest: string[] = [];
  let bundleOnly = false;
  let fixId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--bundle-only") bundleOnly = true;
    else if (arg === "--fix") {
      const id = args[++i];
      if (!id || id.startsWith("--")) throw new Error("--fix needs the fix's id");
      fixId = id;
    } else rest.push(arg);
  }
  if (fixId !== null && !bundleOnly) throw new Error("--fix goes with --bundle-only");
  return { bundleOnly, fixId, rest };
}

/** What dist/patch.json says of a self-fix bundle (src/electron/bootPolicy.ts). */
export function patchManifest(appVersion: string, fixId: string, now: Date = new Date()): PatchManifest {
  return { appVersion, builtAt: now.toISOString(), fixId };
}

/** Where the manifest goes, under a dist directory. */
export const PATCH_MANIFEST_FILE = "patch.json";

/**
 * Dependencies whose runtime files the main-process bundle reads by path.
 * Bun's bundler replaces `__dirname` inside a bundled dependency with the
 * directory it was bundled from — an absolute path into the builder's
 * node_modules, which a cross-built .deb or a copied .app does not have, so
 * the app died at launch with ENOENT on automerge_wasm_bg.wasm. The bundle
 * instead reads these from beside itself (src/electron/bundleAssets.ts),
 * and the build copies them there:
 *
 *   automerge_wasm_bg.wasm   Automerge's engine, read by its nodejs entry (a
 *                            CommonJS file, automerge_wasm.cjs)
 *   cbor-extract/            cbor-x's optional native string extractor:
 *                            package.json and prebuilds/<platform>-<arch>/
 *                            for every platform package bun installed
 *                            (normally the host's only — elsewhere cbor-x
 *                            falls back to its JavaScript path, as it did
 *                            before). electron-builder unpacks it from the
 *                            asar ("asarUnpack" in package.json) so the
 *                            .node file can be dlopen'ed.
 */
export const AUTOMERGE_WASM = "automerge_wasm_bg.wasm";
export const CBOR_EXTRACT_DIR = "cbor-extract";

/** The bundled helper that locates those files; a virtual specifier the plugin resolves. */
const BUNDLE_ASSETS = "specdriven:bundle-assets";
const BUNDLE_ASSETS_FILE = resolve(import.meta.dir, "..", "src", "electron", "bundleAssets.ts");

const AUTOMERGE_NODEJS_ENTRY = /[\\/]@automerge[\\/]automerge[\\/]dist[\\/]mjs[\\/]wasm_bindgen_output[\\/]nodejs[\\/]automerge_wasm\.cjs$/;
const CBOR_EXTRACT_ENTRY = /[\\/]node_modules[\\/]cbor-extract[\\/]index\.js$/;

/**
 * The source a baked module is bundled from instead: Automerge's nodejs
 * entry reads the wasm beside the bundle, cbor-extract hands its loader the
 * cbor-extract/ directory beside the bundle. Null for any other module.
 */
export function rewriteBakedModule(path: string, source: string): string | null {
  if (AUTOMERGE_NODEJS_ENTRY.test(path)) {
    const needle = "`${__dirname}/automerge_wasm_bg.wasm`";
    if (!source.includes(needle)) {
      throw new Error(`${path} no longer reads its wasm from __dirname — update rewriteBakedModule in scripts/build-desktop.ts`);
    }
    return source.replace(needle, () => `require(${JSON.stringify(BUNDLE_ASSETS)}).bundleAssetPath(${JSON.stringify(AUTOMERGE_WASM)})`);
  }
  if (CBOR_EXTRACT_ENTRY.test(path)) {
    return `module.exports = require("node-gyp-build-optional-packages")(require(${JSON.stringify(BUNDLE_ASSETS)}).bundleAssetPath(${JSON.stringify(CBOR_EXTRACT_DIR)}));\n`;
  }
  return null;
}

/**
 * Absolute paths the bundler baked in as a dependency's `__dirname` or
 * `__filename`. A self-contained bundle has none; the build fails on any,
 * so a new dependency that reads files by path is caught here rather than
 * at launch on another machine.
 */
export function bakedPaths(bundle: string): string[] {
  return [...bundle.matchAll(/\b__(?:dirname|filename) = "([^"]+)"/g)].map((m) => m[1]!);
}

/** Where the rewritten modules came from, for copying their files beside the bundle. */
interface BakedModuleSources {
  automergeNodejsDir: string | null;
  cborExtractDir: string | null;
}

function selfContainedPlugin(sources: BakedModuleSources): BunPlugin {
  return {
    name: "self-contained-native-modules",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${BUNDLE_ASSETS}$`) }, () => ({ path: BUNDLE_ASSETS_FILE }));
      build.onLoad({ filter: AUTOMERGE_NODEJS_ENTRY }, async ({ path }) => {
        sources.automergeNodejsDir = dirname(path);
        return { contents: rewriteBakedModule(path, await Bun.file(path).text())!, loader: "js" };
      });
      build.onLoad({ filter: CBOR_EXTRACT_ENTRY }, async ({ path }) => {
        sources.cborExtractDir = dirname(path);
        return { contents: rewriteBakedModule(path, await Bun.file(path).text())!, loader: "js" };
      });
    },
  };
}

/** The wasm and cbor-extract's loadable pieces, copied beside the bundle (see AUTOMERGE_WASM). */
async function copyBundleAssets(outdir: string, sources: BakedModuleSources): Promise<void> {
  if (!sources.automergeNodejsDir || !sources.cborExtractDir) {
    throw new Error("the main-process bundle no longer pulls in Automerge's nodejs entry or cbor-extract — update bundleElectron in scripts/build-desktop.ts");
  }
  await copyFile(join(sources.automergeNodejsDir, AUTOMERGE_WASM), join(outdir, AUTOMERGE_WASM));

  const dest = join(outdir, CBOR_EXTRACT_DIR);
  await mkdir(dest, { recursive: true });
  await copyFile(join(sources.cborExtractDir, "package.json"), join(dest, "package.json"));
  // The platform packages: node_modules/@cbor-extract/cbor-extract-<platform>-<arch>,
  // laid out as the prebuilds/<platform>-<arch>/ directories its loader scans.
  const scope = join(dirname(sources.cborExtractDir), "@cbor-extract");
  for (const name of await readdir(scope).catch(() => [] as string[])) {
    const tuple = /^cbor-extract-(.+)$/.exec(name)?.[1];
    if (!tuple) continue;
    const to = join(dest, "prebuilds", tuple);
    await mkdir(to, { recursive: true });
    for (const file of await readdir(join(scope, name))) {
      if (file.endsWith(".node")) await copyFile(join(scope, name, file), join(to, file));
    }
  }
}

/** The Claude Agent SDK's optional per-platform binaries stay out: the app runs the developer's own `claude` (src/server/agentChat.ts). */
const SDK_BINARIES = "@anthropic-ai/claude-agent-sdk-*";

async function bundle(entry: string, outdir: string, production: boolean, plugins: BunPlugin[]): Promise<void> {
  await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "node",
    format: "esm",
    external: ["electron", SDK_BINARIES],
    sourcemap: "linked",
    define: production ? { "process.env.NODE_ENV": '"production"' } : {},
    plugins,
  });
}

/**
 * The main process and the boot shim, into `outdir` — what the desktop build
 * and `bun run dev:electron` share. main.js is self-contained: the files it
 * reads at runtime are copied beside it (AUTOMERGE_WASM above), and a bundle
 * that still carries a baked absolute path fails the build.
 */
export async function bundleElectron(outdir: string, opts: { production: boolean }): Promise<void> {
  const sources: BakedModuleSources = { automergeNodejsDir: null, cborExtractDir: null };
  await bundle("src/electron/main.ts", outdir, opts.production, [selfContainedPlugin(sources)]);
  // The shim is its own file: it imports main.js by a computed path, so the
  // bundler leaves the two apart (src/electron/boot.ts).
  await bundle("src/electron/boot.ts", outdir, opts.production, []);
  await copyBundleAssets(outdir, sources);

  const baked = bakedPaths(await Bun.file(join(outdir, "main.js")).text());
  if (baked.length > 0) {
    throw new Error(`dist/electron/main.js bakes in build-machine paths, which only this machine has:\n  ${baked.join("\n  ")}\nRewrite the dependency's loader in rewriteBakedModule (scripts/build-desktop.ts).`);
  }
}

/**
 * The bundles — the renderer, the app icon beside it, the main process and
 * the boot shim that picks between this main process and a self-fix's — all a local
 * launch needs (scripts/crash-test-desktop.ts runs them without the
 * installers). A self-fix's rebuild (`--fix`) leaves dist/patch.json for the
 * shim; any other build removes a stale one, so a fresh install never boots
 * the bundle of a fix made for the version before it.
 */
export async function bundleDesktop(opts: { fixId?: string | null; distDir?: string } = {}): Promise<void> {
  const dist = opts.distDir ?? "dist";
  console.log("Building renderer…");
  await rm(join(dist, "renderer"), { recursive: true, force: true });
  await $`bun build src/index.html --outdir ${join(dist, "renderer")} --production`.quiet();
  await copyFile(APP_ICON, join(dist, "icon.png"));

  console.log("Building main process…");
  await rm(join(dist, "electron"), { recursive: true, force: true });
  await bundleElectron(join(dist, "electron"), { production: true });

  await writePatchManifest(dist, opts.fixId ?? null);
}

/** The 1024px app icon (`bun run build:icons`), shipped as dist/icon.png for src/electron/main.ts. */
export const APP_ICON = "build/icon.png";

/** dist/patch.json for a fix's bundle; none otherwise. */
export async function writePatchManifest(dist: string, fixId: string | null, appVersion: string = version): Promise<void> {
  const file = join(dist, PATCH_MANIFEST_FILE);
  await rm(file, { force: true });
  if (fixId) await writeFile(file, JSON.stringify(patchManifest(appVersion, fixId), null, 2) + "\n");
}

async function build(builderArgs: string[]): Promise<void> {
  await bundleDesktop();

  console.log(`Packaging with electron-builder (${builderArgs.join(" ")})…`);
  await $`bunx electron-builder ${builderArgs}`;

  console.log("Done — artifacts in release/");
}

if (import.meta.main) {
  let bundle: ReturnType<typeof bundleOptions>;
  try {
    bundle = bundleOptions(process.argv.slice(2));
  } catch (e) {
    console.error(`build:desktop: ${(e as Error).message}`);
    process.exit(1);
  }
  if (bundle.bundleOnly) {
    if (bundle.rest.length > 0) {
      console.error(`build:desktop: --bundle-only takes no platform (got ${bundle.rest.join(" ")})`);
      process.exit(1);
    }
    await bundleDesktop({ fixId: bundle.fixId });
    console.log(bundle.fixId ? `Done — dist/ carries fix ${bundle.fixId}` : "Done — bundles in dist/");
    process.exit(0);
  }
  const args = bundle.rest;
  const local = args.includes("--local");
  let builderArgs: string[];
  try {
    const platforms = selectPlatforms(args.filter((a) => a !== "--local"), process.platform);
    if (local && (platforms.length !== 1 || platforms[0] !== hostPlatform(process.platform))) {
      throw new Error("--local builds only this machine's platform");
    }
    builderArgs = electronBuilderArgs(platforms, local, process.arch);
  } catch (e) {
    console.error(`build:desktop: ${(e as Error).message}`);
    process.exit(1);
  }
  await build(builderArgs);
}
