#!/usr/bin/env bun
/**
 * Runs the desktop shell against the live Bun dev server
 * (specs/app/desktop-app.feature.md):
 *
 *   bun run dev            in one terminal (frontend + API, HMR)
 *   bun run dev:electron   in another
 *
 * The Electron main process is rebuilt on every launch (it's a ~50ms build);
 * ELECTRON_DEV makes it load http://localhost:3000 instead of app://, so
 * edits hot-reload inside the desktop window.
 */
import { $ } from "bun";
import { copyFile, mkdir } from "node:fs/promises";
import { APP_ICON } from "./build-desktop";

const port = process.env.PORT || "3000";
const devUrl = `http://localhost:${port}`;

try {
  await fetch(`${devUrl}/api/state`);
} catch {
  console.error(`No dev server at ${devUrl} — start one first with: bun run dev`);
  process.exit(1);
}

await mkdir("dist", { recursive: true });
await copyFile(APP_ICON, "dist/icon.png");
await $`bun build src/electron/main.ts --target=node --format=esm --external electron --sourcemap --outdir dist/electron`.quiet();
// The entry is the boot shim (src/electron/boot.ts), built apart from main.js.
await $`bun build src/electron/boot.ts --target=node --format=esm --external electron --sourcemap --outdir dist/electron`.quiet();

await $`bunx electron .`.env({ ...process.env, ELECTRON_DEV: "1" });
