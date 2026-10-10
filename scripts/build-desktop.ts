#!/usr/bin/env bun
/**
 * Builds the desktop app (specs/app/desktop-app.feature.md "Packaging"):
 *
 *   bun run build:desktop            this machine's platform
 *   bun run build:desktop --mac      release/SpecDriven-<version>-arm64.dmg (+ zip)
 *   bun run build:desktop --linux    release/SpecDriven-<version>-<arch>.AppImage (+ deb)
 *   bun run build:desktop --all      both
 *   bun run build:desktop --local    only what runs here: this machine's
 *                                    platform and architecture, as the
 *                                    AppImage (Linux) or .dmg (macOS)
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
import { $ } from "bun";
import { rm } from "node:fs/promises";

export type Platform = "mac" | "linux";

const PLATFORMS: Platform[] = ["mac", "linux"];

/** Which platform a given `process.platform` builds for by default. */
export function hostPlatform(osPlatform: string): Platform | null {
  if (osPlatform === "darwin") return "mac";
  if (osPlatform === "linux") return "linux";
  return null;
}

/**
 * Resolves `--mac` / `--linux` / `--all` against the host, and rejects what
 * this machine cannot build. macOS artifacts need macOS tooling (hdiutil,
 * codesign); Linux ones cross-build from macOS.
 */
export function selectPlatforms(args: string[], osPlatform: string): Platform[] {
  const known = ["--all", ...PLATFORMS.map((p) => `--${p}`)];
  const unknown = args.find((arg) => !known.includes(arg));
  if (unknown) throw new Error(`unknown option ${unknown} — expected ${known.join(", ")}`);

  const host = hostPlatform(osPlatform);
  let selected = args.includes("--all")
    ? [...PLATFORMS]
    : PLATFORMS.filter((p) => args.includes(`--${p}`));
  if (selected.length === 0) {
    if (!host) throw new Error(`no desktop build for ${osPlatform} — pass --mac or --linux`);
    selected = [host];
  }
  if (selected.includes("mac") && host !== "mac") {
    throw new Error("the macOS app can only be built on macOS");
  }
  return selected;
}

/** What `--local` packages: the one installer install.sh starts or opens. */
const LOCAL_TARGET: Record<Platform, string> = { linux: "AppImage", mac: "dmg" };

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

/**
 * The first two steps — the renderer bundle and the main-process bundle —
 * which is all a local launch needs (scripts/crash-test-desktop.ts runs them
 * without the installers).
 */
export async function bundleDesktop(): Promise<void> {
  console.log("Building renderer…");
  await rm("dist/renderer", { recursive: true, force: true });
  await $`bun build src/index.html --outdir dist/renderer --production`.quiet();

  console.log("Building main process…");
  await rm("dist/electron", { recursive: true, force: true });
  // The Claude Agent SDK's optional per-platform binaries stay out: the app
  // runs the developer's own `claude` (src/server/agentChat.ts).
  const sdkBinaries = "@anthropic-ai/claude-agent-sdk-*";
  await $`bun build src/electron/main.ts --target=node --format=esm --external electron --external ${sdkBinaries} --sourcemap --define process.env.NODE_ENV=${'"production"'} --outdir dist/electron`.quiet();
}

async function build(builderArgs: string[]): Promise<void> {
  await bundleDesktop();

  console.log(`Packaging with electron-builder (${builderArgs.join(" ")})…`);
  await $`bunx electron-builder ${builderArgs}`;

  console.log("Done — artifacts in release/");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
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
