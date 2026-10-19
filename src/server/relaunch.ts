// Restarting the running app (specs/app/self-healing.feature.md "A rebuilt
// fix restarts the desktop app"). Pluggable like the folder chooser
// (src/server/folderChooser.ts): the desktop shell registers Electron's
// relaunch (src/electron/main.ts); the web server registers nothing, so a
// restart there is the user's to do — the route says so rather than
// pretending.
//
// The boot shim (src/electron/boot.ts) tells the server which bundle it
// loaded through SPECDRIVEN_BOOT, `<patch|asar>:<reason>:<fixId>`, read
// back here for the Fix this app pane.

export type Relauncher = () => void | Promise<void>;

let relauncher: Relauncher | null = null;

export function setRelauncher(fn: Relauncher | null): Relauncher | null {
  const previous = relauncher;
  relauncher = fn;
  return previous;
}

/** Whether something is registered to restart the app. */
export function canRelaunch(): boolean {
  return relauncher !== null;
}

/** Restart the app; throws when nothing is registered to. */
export async function relaunch(): Promise<void> {
  if (!relauncher) throw new Error("This app cannot restart itself; start it again by hand");
  await relauncher();
}

/** The desktop shell, or the web server (bun run start). */
export function appRuntime(): "desktop" | "web" {
  return process.versions.electron ? "desktop" : "web";
}

/** The bundle the desktop shell booted: the patched one, or the shipped one. */
export interface BootInfo {
  /** `patch`: the self-fix bundle; `asar`: the shipped one; `none`: no shim (web, or a desktop build from before self-fix). */
  source: "patch" | "asar" | "none";
  /** Why: `ok`, `none`, `version-mismatch`, `crash-loop`, `load-error`. */
  reason: string;
  /** The fix whose bundle was found, when one was. */
  fixId: string | null;
}

/** Parse the shim's `<source>:<reason>:<fixId>`; anything else is no shim. */
export function parseBootInfo(value: string | undefined): BootInfo {
  const [source, reason, fixId] = (value ?? "").split(":");
  if (source !== "patch" && source !== "asar") return { source: "none", reason: "none", fixId: null };
  return { source, reason: reason || "ok", fixId: fixId || null };
}

export function bootInfo(): BootInfo {
  return parseBootInfo(process.env.SPECDRIVEN_BOOT);
}
