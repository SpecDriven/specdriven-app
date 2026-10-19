// The desktop app's entry (package.json "main"): a shim that picks which
// bundle runs — the one shipped inside the app, or the one a self-fix
// rebuilt under the installed source (specs/app/self-healing.feature.md).
// It stays tiny and dependency-free so it is never what needs fixing: the
// decision is bootPolicy.ts, the paths appSource.ts, and everything else
// is main.ts, imported last. The import is awaited at top level, which
// Electron honours before firing `ready`, so main.ts still registers its
// privileged scheme in time.

import { app } from "electron";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { appSourceDir, PATCH_MANIFEST, PATCH_STATE_FILE, selfFixHome } from "../server/appSource";
import { bootEnv, decideBoot, parsePatchManifest, parsePatchState, stateAfterWindow, type PatchState } from "./bootPolicy";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const stateFile = join(selfFixHome(process.env, homedir()), PATCH_STATE_FILE);

function writeState(state: PatchState): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // A state that cannot be written only loses the crash-loop guard.
  }
}

/** The installed source, through the `current` link; null when there is none. */
function sourceDir(): string | null {
  try {
    return realpathSync(appSourceDir(process.env, homedir()));
  } catch {
    return null;
  }
}

const source = sourceDir();
const patch = source ? parsePatchManifest(readText(join(source, PATCH_MANIFEST))) : null;
const decision = decideBoot({ appVersion: app.getVersion(), patch, state: parsePatchState(readText(stateFile)) });
process.env.SPECDRIVEN_BOOT = bootEnv(decision.use, decision.reason, patch?.fixId ?? null);

// Not a literal, so the bundler leaves main.js its own file beside this one.
const shipped = new URL("./main.js", import.meta.url).href;

if (decision.use === "patch" && source && decision.nextState) {
  const state = decision.nextState;
  writeState(state);
  // The window the shipped bundle shows after a fallback is not the
  // patch's: only the patch's own window clears its count.
  let fellBack = false;
  app.on("browser-window-created", (_event, win) => {
    win.webContents.once("did-finish-load", () => {
      if (!fellBack) writeState(stateAfterWindow(state, new Date().toISOString()));
    });
  });
  try {
    await import(pathToFileURL(join(source, "dist", "electron", "main.js")).href);
  } catch (e) {
    // A bundle that cannot even load: back to the shipped one, in this
    // very launch, and remembered so the pane can say why.
    fellBack = true;
    writeState({ ...state, loadError: (e as Error).message });
    process.env.SPECDRIVEN_BOOT = bootEnv("asar", "load-error", patch?.fixId ?? null);
    await import(shipped);
  }
} else {
  await import(shipped);
}
