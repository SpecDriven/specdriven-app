#!/usr/bin/env bun
/**
 * Runs the desktop shell against the live Bun dev server
 * (specs/app/desktop-app.feature.md):
 *
 *   bun run dev            in one terminal (frontend + API, HMR)
 *   bun run dev:electron   in another
 *
 * The Electron main process is rebuilt on every launch (it's a ~50ms build);
 * ELECTRON_DEV makes its windows load http://localhost:3000 instead of
 * app://, so frontend edits hot-reload inside them. The API calls those
 * pages make are answered by the desktop process itself, as in the packaged
 * app — which is what lets every window show a folder of its own
 * (specs/app/multiple-windows.feature.md) — so an edit under src/server or
 * src/electron shows after the next launch.
 */
import { $ } from "bun";
import { copyFile, mkdir } from "node:fs/promises";
import { APP_ICON, bundleElectron } from "./build-desktop";

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
// main.js, the boot shim (the entry, src/electron/boot.ts) and the files
// main.js reads beside itself, as the desktop build makes them.
await bundleElectron("dist/electron", { production: false });

await $`bunx electron .`.env({ ...process.env, ELECTRON_DEV: "1" });
