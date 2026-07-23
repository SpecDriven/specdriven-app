#!/usr/bin/env bun
/**
 * Builds the macOS desktop app (specs/desktop-app.spec.md):
 *
 *   bun run build:desktop    ->  release/SpecDriven-<version>-arm64.dmg (+ zip)
 *
 * Three steps: bundle the frontend into static files (served over the
 * app:// protocol), bundle the Electron main process, then hand both to
 * electron-builder. The web build (`bun run build`) is separate and
 * untouched. Add "x64" to the arch lists in package.json's "build" key for
 * Intel artifacts.
 */
import { $ } from "bun";
import { rm } from "node:fs/promises";

console.log("Building renderer…");
await rm("dist/renderer", { recursive: true, force: true });
await $`bun build src/index.html --outdir dist/renderer --production`.quiet();

console.log("Building main process…");
await rm("dist/electron", { recursive: true, force: true });
await $`bun build src/electron/main.ts --target=node --format=esm --external electron --sourcemap --define process.env.NODE_ENV=${'"production"'} --outdir dist/electron`.quiet();

console.log("Packaging with electron-builder…");
await $`bunx electron-builder --mac`;

console.log("Done — artifacts in release/");
