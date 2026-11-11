// A plugin's own settings (specs/agents/agent-plugins.feature.md "The
// Settings page shows a plugin's section"): a JSON object kept under the
// plugin's id in settings.yaml's `pluginSettings`, read and patched
// through the service the loader hands each host half (HostConfig.settings).
// The core validates only the shape — an object, JSON, not too big — and
// the plugin's own route validates the keys. `adopt` copies top-level
// settings a plugin's keys lived under before it was a plugin, once, and
// leaves the old keys in the file for the release that still reads them.

export const PLUGIN_SETTINGS_KEY = "pluginSettings";

/** The most a plugin's section may be, serialized. */
export const PLUGIN_SETTINGS_MAX_BYTES = 16 * 1024;

export interface PluginSettings {
  /** The plugin's section, `{}` when there is none. */
  read(): Promise<Record<string, unknown>>;
  /** Merge a patch into the section: `undefined` skips a key, `null` removes it. */
  write(patch: Record<string, unknown>): Promise<void>;
  /** Copy the named top-level settings into the section, those not already there. */
  adopt(legacyKeys: readonly string[]): Promise<void>;
}

type State = Record<string, unknown>;

/** The `pluginSettings` map of a settings object, `{}` when absent or malformed. */
export function pluginSettingsOf(state: State): Record<string, Record<string, unknown>> {
  const all = state[PLUGIN_SETTINGS_KEY];
  if (!all || typeof all !== "object" || Array.isArray(all)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, section] of Object.entries(all as Record<string, unknown>)) {
    if (section && typeof section === "object" && !Array.isArray(section)) {
      out[id] = section as Record<string, unknown>;
    }
  }
  return out;
}

/** One plugin's section, `{}` when there is none. */
export function pluginSection(state: State, id: string): Record<string, unknown> {
  return pluginSettingsOf(state)[id] ?? {};
}

/** Why a patch cannot be taken, or null when it can. */
export function pluginPatchRefusal(patch: unknown): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "a plugin's settings must be an object";
  let text: string;
  try {
    text = JSON.stringify(patch);
  } catch {
    return "a plugin's settings must be JSON";
  }
  if (text === undefined) return "a plugin's settings must be JSON";
  if (Buffer.byteLength(text) > PLUGIN_SETTINGS_MAX_BYTES) {
    return `a plugin's settings may be at most ${PLUGIN_SETTINGS_MAX_BYTES / 1024} KB`;
  }
  return null;
}

/**
 * Apply a patch to a plugin's section in place: `null` removes a key,
 * `undefined` leaves it, anything else replaces it. An emptied section is
 * dropped from the file. Returns the section after.
 */
export function applyPluginPatch(state: State, id: string, patch: Record<string, unknown>): Record<string, unknown> {
  const all = pluginSettingsOf(state);
  const section = { ...(all[id] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete section[key];
    else section[key] = value;
  }
  const next = { ...all };
  if (Object.keys(section).length > 0) next[id] = section;
  else delete next[id];
  if (Object.keys(next).length > 0) state[PLUGIN_SETTINGS_KEY] = next;
  else delete state[PLUGIN_SETTINGS_KEY];
  return section;
}

export interface PluginSettingsDeps {
  readState(): Promise<State>;
  writeState(state: State): Promise<void>;
}

/** The service for one plugin over the app's settings file. */
export function createPluginSettings(id: string, deps: PluginSettingsDeps): PluginSettings {
  return {
    async read() {
      return pluginSection(await deps.readState(), id);
    },
    async write(patch) {
      const refusal = pluginPatchRefusal(patch);
      if (refusal) throw new Error(refusal);
      const state = await deps.readState();
      applyPluginPatch(state, id, patch);
      await deps.writeState(state);
    },
    async adopt(legacyKeys) {
      const state = await deps.readState();
      const section = pluginSection(state, id);
      const patch: Record<string, unknown> = {};
      for (const key of legacyKeys) {
        if (key in section || state[key] === undefined) continue;
        patch[key] = state[key];
      }
      if (Object.keys(patch).length === 0) return;
      applyPluginPatch(state, id, patch);
      await deps.writeState(state);
    },
  };
}
