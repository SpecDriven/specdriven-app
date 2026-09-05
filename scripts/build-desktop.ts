#!/usr/bin/env bun
/**
 * Builds the desktop app (specs/desktop-app.spec.md "Packaging"):
 *
 *   bun run build:desktop            this machine's platform
 *   bun run build:desktop --mac      release/SpecDriven-<version>-arm64.dmg (+ zip)
 *   bun run build:desktop --linux    release/SpecDriven-<version>-<arch>.AppImage (+ deb)
 *   bun run build:desktop --all      both
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

async function build(platforms: Platform[]): Promise<void> {
  console.log("Building renderer…");
  await rm("dist/renderer", { recursive: true, force: true });
  await $`bun build src/index.html --outdir dist/renderer --production`.quiet();

  console.log("Building main process…");
  await rm("dist/electron", { recursive: true, force: true });
  // The Claude Agent SDK's optional per-platform binaries stay out: the app
  // runs the developer's own `claude` (src/server/agentChat.ts).
  const sdkBinaries = "@anthropic-ai/claude-agent-sdk-*";
  await $`bun build src/electron/main.ts --target=node --format=esm --external electron --external ${sdkBinaries} --sourcemap --define process.env.NODE_ENV=${'"production"'} --outdir dist/electron`.quiet();

  console.log(`Packaging with electron-builder (${platforms.join(", ")})…`);
  await $`bunx electron-builder ${platforms.map((p) => `--${p}`)}`;

  console.log("Done — artifacts in release/");
}

if (import.meta.main) {
  let platforms: Platform[];
  try {
    platforms = selectPlatforms(process.argv.slice(2), process.platform);
  } catch (e) {
    console.error(`build:desktop: ${(e as Error).message}`);
    process.exit(1);
  }
  await build(platforms);
}
