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

const port = process.env.PORT || "3000";
const devUrl = `http://localhost:${port}`;

try {
  await fetch(`${devUrl}/api/state`);
} catch {
  console.error(`No dev server at ${devUrl} — start one first with: bun run dev`);
  process.exit(1);
}

await $`bun build src/electron/main.ts --target=node --format=esm --external electron --sourcemap --outdir dist/electron`.quiet();

await $`bunx electron .`.env({ ...process.env, ELECTRON_DEV: "1" });
