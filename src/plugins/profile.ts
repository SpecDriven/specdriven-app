// The profile (specs/app/plugins.feature.md "The profile lists enabled
// plugins in tab order"): the ordered `plugins.enabled` list in the device-
// local settings file, which says exactly which plugins are mounted and in
// what order their tabs follow Specs. It replaces the per-module switches
// (`roadmap`, `tasks`, `notebook`, `models`, `testing`, `issues`): a file
// that still has them is read as the matching list, and the keys stay as
// aliases of `PUT /api/state` for one release. Shared by the server, the
// Electron main process and the browser; no imports beyond the manifest.

import type { PluginManifest } from "./manifest";

/** The settings key the profile lives under. */
export const PROFILE_KEY = "plugins";

export interface Profile {
  /** The enabled plugins, in tab order. */
  enabled: string[];
  /**
   * True when the list was derived from the legacy switches (or from the
   * manifests' defaults) rather than read from `plugins.enabled`.
   */
  migrated: boolean;
}

type State = Record<string, unknown>;

/** The `plugins.enabled` list a settings object holds, or null for none. */
export function storedProfile(state: State): string[] | null {
  const section = state[PROFILE_KEY];
  if (!section || typeof section !== "object") return null;
  const enabled = (section as { enabled?: unknown }).enabled;
  if (!Array.isArray(enabled)) return null;
  return dedupe(enabled.filter((id): id is string => typeof id === "string" && id.length > 0));
}

/**
 * The profile a settings object describes: `plugins.enabled` when it is
 * there, else the list the legacy switches and the manifests' defaults add
 * up to, in manifest order.
 */
export function readProfile(state: State, manifests: readonly PluginManifest[]): Profile {
  const stored = storedProfile(state);
  if (stored) return { enabled: stored, migrated: false };
  const enabled = manifests.filter((m) => legacyOn(m, state)).map((m) => m.id);
  return { enabled, migrated: true };
}

/** Whether a legacy switch (or, absent, the manifest's default) turns a plugin on. */
function legacyOn(manifest: PluginManifest, state: State): boolean {
  if (!manifest.legacyKey) return manifest.defaultEnabled;
  const value = state[manifest.legacyKey];
  return typeof value === "boolean" ? value : manifest.defaultEnabled;
}

/** Whether a settings object still carries any legacy switch. */
export function hasLegacyKeys(state: State, manifests: readonly PluginManifest[]): boolean {
  return manifests.some((m) => m.legacyKey !== undefined && m.legacyKey in state);
}

/**
 * Store the profile: `plugins.enabled` is set (the section's other keys are
 * kept) and the legacy switches are dropped, so the file carries the list
 * from now on.
 */
export function writeProfile(
  state: State,
  enabled: readonly string[],
  manifests: readonly PluginManifest[],
): void {
  const section =
    state[PROFILE_KEY] && typeof state[PROFILE_KEY] === "object"
      ? (state[PROFILE_KEY] as Record<string, unknown>)
      : {};
  state[PROFILE_KEY] = { ...section, enabled: dedupe([...enabled]) };
  for (const m of manifests) {
    if (m.legacyKey) delete state[m.legacyKey];
  }
}

/**
 * The legacy switches as `GET /api/state` still reports them for one
 * release: `{ testing: true, … }` from the profile, one key per manifest
 * that had one.
 */
export function legacyFields(
  enabled: readonly string[],
  manifests: readonly PluginManifest[],
): Record<string, boolean> {
  const fields: Record<string, boolean> = {};
  for (const m of manifests) {
    if (m.legacyKey) fields[m.legacyKey] = enabled.includes(m.id);
  }
  return fields;
}

/** A list with an id added at the end (on) or taken out (off). */
export function withPlugin(enabled: readonly string[], id: string, on: boolean): string[] {
  const rest = enabled.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

function dedupe(ids: string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) === i);
}
