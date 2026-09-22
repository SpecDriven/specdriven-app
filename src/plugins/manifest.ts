// What a plugin says about itself, shared by both halves and by the loaders
// (specs/app/plugins.feature.md). A built-in plugin declares this in code;
// a packaged one will carry it under `specdriven` in its package.json.

export interface PluginManifest {
  /** Stable id: the tab id, the settings key's owner, the scope name. */
  id: string;
  /** The kernel contract the plugin was written against. */
  api: "1";
  displayName: string;
  description: string;
  /**
   * The Settings switch that mounts the plugin, as the settings key it is
   * stored under and what an absent key means. Until every module has moved
   * behind the kernel the switches keep their historical keys (`testing`,
   * `issues`, …); the ordered `plugins.enabled` list of the roadmap page
   * replaces them once the last tab moves.
   */
  switch?: { key: string; default: boolean };
  /**
   * Url prefixes the plugin's views live under (`/tests`). The server serves
   * the app shell for them whether or not the plugin is on, so a deep link
   * to a switched-off module still lands in the app and goes home there.
   */
  paths?: string[];
}

/** Whether the switch in `state` mounts the plugin. */
export function pluginWanted(manifest: PluginManifest, state: Record<string, unknown>): boolean {
  if (!manifest.switch) return true;
  const value = state[manifest.switch.key];
  return typeof value === "boolean" ? value : manifest.switch.default;
}
