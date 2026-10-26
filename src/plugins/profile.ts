// The profile (specs/app/plugins.feature.md "The profile lists enabled
// plugins in tab order", "Each data folder keeps its own plugins"): the
// ordered list of enabled plugins, which says exactly which plugins are
// mounted and in what order their tabs follow Specs. Each data folder keeps
// its own, under `plugins.repos[<folder>].enabled` in the device-local
// settings file, so one folder may show Specs alone and another every
// plugin; a folder with no list yet shows Specs alone.
//
// It replaces two older shapes: the per-module switches (`roadmap`, `tasks`,
// `notebook`, `models`, `testing`, `issues`), and one device-wide
// `plugins.enabled`. A file that still has either is read as that list,
// which the next write copies to every folder the file knows (the open one
// and the recent ones) before dropping it; the switches stay as aliases of
// `PUT /api/state` for one release. An older file with neither, that names a
// folder but has no per-folder lists, showed the manifests' defaults (the
// Notebook), and is read as those the same way. Shared by the server, the
// Electron main process and the browser; no imports beyond the manifest.

import type { PluginManifest } from "./manifest";

/** The settings key the profile lives under. */
export const PROFILE_KEY = "plugins";

export interface Profile {
  /** The enabled plugins, in tab order. */
  enabled: string[];
  /**
   * True when the list was derived from an older shape (the legacy switches
   * or the device-wide `plugins.enabled`) rather than read from the open
   * folder's own list.
   */
  migrated: boolean;
}

type State = Record<string, unknown>;

/** The open data folder the profile is kept for, or null while none is. */
function profileRepo(state: State): string | null {
  const repo = state.dataRepo;
  return typeof repo === "string" && repo.trim() !== "" ? repo.trim() : null;
}

function section(state: State): Record<string, unknown> {
  const value = state[PROFILE_KEY];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function repoLists(state: State): Record<string, unknown> {
  const repos = section(state).repos;
  return repos && typeof repos === "object" ? (repos as Record<string, unknown>) : {};
}

/** A stored list cleaned up: ids only, each once, in order; null for none. */
function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return dedupe(value.filter((id): id is string => typeof id === "string" && id.length > 0));
}

/** The list a settings object stores for a data folder, or null for none. */
function repoProfile(state: State, repo: string): string[] | null {
  const entry = repoLists(state)[repo];
  if (!entry || typeof entry !== "object") return null;
  return idList((entry as { enabled?: unknown }).enabled);
}

/**
 * The list the open data folder stores — or, with none open, the
 * device-wide `plugins.enabled` — or null for none.
 */
export function storedProfile(state: State): string[] | null {
  const repo = profileRepo(state);
  return repo ? repoProfile(state, repo) : idList(section(state).enabled);
}

/**
 * The profile a settings object describes: the open folder's own list when
 * it has one; else the list an older file holds (the device-wide
 * `plugins.enabled`, or the legacy switches and the manifests' defaults, in
 * manifest order); else none — Specs alone.
 */
export function readProfile(state: State, manifests: readonly PluginManifest[]): Profile {
  const stored = storedProfile(state);
  if (stored) return { enabled: stored, migrated: false };
  const older = olderProfile(state, manifests);
  return older ? { enabled: older, migrated: true } : { enabled: [], migrated: false };
}

/** The list an older settings file holds, or null when it holds none. */
function olderProfile(state: State, manifests: readonly PluginManifest[]): string[] | null {
  const device = idList(section(state).enabled);
  if (device) return device;
  if (!hasLegacyKeys(state, manifests) && !predatesFolderLists(state)) return null;
  return manifests.filter((m) => legacyOn(m, state)).map((m) => m.id);
}

/**
 * Whether a file names a data folder but has no per-folder lists: one from
 * before them, which showed such a file the manifests' defaults — someone
 * who never changed a plugin saw the Notebook. This app gives a file `repos`
 * as soon as it records a folder (startFolderLists), so its own files never
 * look older.
 */
function predatesFolderLists(state: State): boolean {
  return section(state).repos === undefined && knownRepos(state).length > 0;
}

/** Every folder a settings file knows: the open one, then the recent ones. */
function knownRepos(state: State): string[] {
  const recent = Array.isArray(state.recentDataRepos) ? state.recentDataRepos : [];
  return dedupe(
    [profileRepo(state), ...recent]
      .filter((r): r is string => typeof r === "string" && r.trim() !== "")
      .map((r) => r.trim()),
  );
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
 * Move an older file's list onto the folders: every folder the file knows
 * (the open one, then the recent ones) without a list of its own gets a
 * copy, and the device-wide list and the legacy switches go. With no folder
 * known yet the list stays device-wide (the switches still go). Returns
 * whether the settings changed.
 */
export function migrateProfile(state: State, manifests: readonly PluginManifest[]): boolean {
  const older = olderProfile(state, manifests);
  if (!older) return false;
  const repos = knownRepos(state);
  const { enabled: _device, ...rest } = section(state);
  if (repos.length === 0) {
    state[PROFILE_KEY] = { ...rest, enabled: older };
  } else {
    const lists = { ...repoLists(state) };
    for (const repo of repos) {
      if (!repoProfile(state, repo)) lists[repo] = { enabled: [...older] };
    }
    state[PROFILE_KEY] = { ...rest, repos: lists };
  }
  for (const m of manifests) {
    if (m.legacyKey) delete state[m.legacyKey];
  }
  return true;
}

/**
 * Mark a file as keeping per-folder lists before any folder has one: an
 * empty `repos`. Called as this app records a data folder, after any older
 * list has moved onto the folders, so a restart never reads the file as one
 * from before per-folder lists.
 */
export function startFolderLists(state: State): void {
  const current = section(state);
  if (current.repos === undefined) state[PROFILE_KEY] = { ...current, repos: {} };
}

/**
 * Store the profile for the open data folder (with none open, as the
 * device-wide list). An older file's list is moved onto the folders first
 * (migrateProfile), so the other folders keep what they showed; the
 * section's other keys are kept.
 */
export function writeProfile(
  state: State,
  enabled: readonly string[],
  manifests: readonly PluginManifest[],
): void {
  migrateProfile(state, manifests);
  const repo = profileRepo(state);
  const list = dedupe([...enabled]);
  if (!repo) {
    state[PROFILE_KEY] = { ...section(state), enabled: list };
    return;
  }
  const lists = repoLists(state);
  const entry = lists[repo] && typeof lists[repo] === "object" ? (lists[repo] as object) : {};
  state[PROFILE_KEY] = { ...section(state), repos: { ...lists, [repo]: { ...entry, enabled: list } } };
}

/** The ids a folder has switched on by itself before (`repos[<folder>].autoEnabled`). */
function autoEnabledIn(state: State, repo: string): string[] {
  const entry = repoLists(state)[repo];
  return (entry && typeof entry === "object" ? idList((entry as { autoEnabled?: unknown }).autoEnabled) : null) ?? [];
}

/**
 * Switch on, in the open folder, the plugins whose manifests say they
 * switch themselves on (`autoEnable`) and that the folder has not switched
 * on before — so a folder from before such a plugin, or a fresh one, gets
 * it without a visit to Settings → Plugins, and one switched off there
 * stays off. Records the folder's list and what it switched on; returns
 * the new list, or null when nothing changed (no folder open included).
 */
export function autoEnablePlugins(
  state: State,
  enabled: readonly string[],
  manifests: readonly PluginManifest[],
): string[] | null {
  const repo = profileRepo(state);
  if (!repo) return null;
  const done = autoEnabledIn(state, repo);
  const add = manifests
    .filter((m) => m.autoEnable && !enabled.includes(m.id) && !done.includes(m.id))
    .map((m) => m.id);
  if (add.length === 0) return null;
  const next = [...enabled, ...add];
  writeProfile(state, next, manifests);
  const lists = repoLists(state);
  state[PROFILE_KEY] = {
    ...section(state),
    repos: { ...lists, [repo]: { ...(lists[repo] as object), autoEnabled: dedupe([...done, ...add]) } },
  };
  return next;
}

/**
 * Take a plugin off every folder's list (and the device-wide one) — an
 * uninstalled plugin is gone wherever it was on.
 */
export function dropPlugin(state: State, id: string, manifests: readonly PluginManifest[]): void {
  migrateProfile(state, manifests);
  const current = section(state);
  const next: Record<string, unknown> = { ...current };
  const device = idList(current.enabled);
  if (device) next.enabled = device.filter((x) => x !== id);
  const lists: Record<string, unknown> = {};
  for (const [repo, entry] of Object.entries(repoLists(state))) {
    const list = repoProfile(state, repo);
    lists[repo] = list ? { ...(entry as object), enabled: list.filter((x) => x !== id) } : entry;
  }
  if (current.repos !== undefined) next.repos = lists;
  state[PROFILE_KEY] = next;
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

/** Whether two lists name the same plugins in the same order. */
export function sameProfile(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function dedupe(ids: string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) === i);
}
