// Which bundle the desktop shell boots (specs/app/self-healing.feature.md):
// the patched one a self-fix rebuilt under the installed source, or the one
// shipped inside the app. Pure decisions and parsing, kept out of boot.ts so
// they run under bun test — the shim itself only reads files and imports.

/** `dist/patch.json`, written beside a rebuilt bundle. */
export interface PatchManifest {
  /** The app the bundle was built from — it must be the one running. */
  appVersion: string;
  /** When it was built; a rebuild resets the attempt count. */
  builtAt: string;
  /** The self-fix record the bundle belongs to. */
  fixId: string;
}

/** The shim's own memory of the patched bundle, across launches. */
export interface PatchState {
  fixId: string;
  builtAt: string;
  /** Launches of this bundle since it last showed a window. */
  attempts: number;
  /** When it last showed a window, or null if never. */
  lastOk: string | null;
  /** What importing it threw, when it did. */
  loadError?: string;
}

export type BootReason = "ok" | "none" | "version-mismatch" | "crash-loop" | "load-error";

export interface BootDecision {
  use: "patch" | "asar";
  reason: BootReason;
  /** What to remember before booting the patch; null leaves the file alone. */
  nextState: PatchState | null;
}

/** Two launches that never showed a window: the third boots the shipped bundle. */
export const MAX_ATTEMPTS = 2;

function record(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persisted JSON -> PatchManifest; null for missing, corrupt or wrong-shaped data. */
export function parsePatchManifest(raw: string | null): PatchManifest | null {
  const data = parseJson(raw);
  if (!data) return null;
  const { appVersion, builtAt, fixId } = data;
  if (typeof appVersion !== "string" || typeof builtAt !== "string" || typeof fixId !== "string") return null;
  if (!appVersion || !builtAt || !fixId) return null;
  return { appVersion, builtAt, fixId };
}

/** Persisted JSON -> PatchState; null for missing, corrupt or wrong-shaped data. */
export function parsePatchState(raw: string | null): PatchState | null {
  const data = parseJson(raw);
  if (!data) return null;
  const { fixId, builtAt, attempts, lastOk, loadError } = data;
  if (typeof fixId !== "string" || typeof builtAt !== "string") return null;
  if (typeof attempts !== "number" || !Number.isFinite(attempts) || attempts < 0) return null;
  if (lastOk !== null && typeof lastOk !== "string") return null;
  return {
    fixId,
    builtAt,
    attempts: Math.floor(attempts),
    lastOk: (lastOk as string | null) ?? null,
    ...(typeof loadError === "string" ? { loadError } : {}),
  };
}

/**
 * The decision: no manifest, or one from another app version, boots the
 * shipped bundle; a bundle that failed to show a window on its last
 * MAX_ATTEMPTS launches does too, so a broken fix cannot lock the user
 * out. Otherwise the patch boots, counted as one more attempt until the
 * window loads (boot.ts then resets the count).
 */
export function decideBoot(input: {
  appVersion: string;
  patch: PatchManifest | null;
  state: PatchState | null;
}): BootDecision {
  const { appVersion, patch, state } = input;
  if (!patch) return { use: "asar", reason: "none", nextState: null };
  if (patch.appVersion !== appVersion) return { use: "asar", reason: "version-mismatch", nextState: null };
  const prior: PatchState =
    state && state.fixId === patch.fixId && state.builtAt === patch.builtAt
      ? state
      : { fixId: patch.fixId, builtAt: patch.builtAt, attempts: 0, lastOk: null };
  if (prior.attempts >= MAX_ATTEMPTS) return { use: "asar", reason: "crash-loop", nextState: prior };
  const { loadError: _dropped, ...kept } = prior;
  return { use: "patch", reason: "ok", nextState: { ...kept, attempts: prior.attempts + 1 } };
}

/** What the shim remembers once the patched bundle has shown its window. */
export function stateAfterWindow(state: PatchState, now: string): PatchState {
  const { loadError: _dropped, ...kept } = state;
  return { ...kept, attempts: 0, lastOk: now };
}

/** The SPECDRIVEN_BOOT value the server reads (src/server/relaunch.ts). */
export function bootEnv(use: "patch" | "asar", reason: BootReason, fixId: string | null): string {
  return `${use}:${reason}:${fixId ?? ""}`;
}
