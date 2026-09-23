// What a plugin says about itself, shared by both halves and by the loaders
// (specs/app/plugins.feature.md). A built-in plugin declares this in code;
// a packaged one will carry it under `specdriven` in its package.json.

export interface PluginManifest {
  /** Stable id: the tab id, the profile entry, the scope name. */
  id: string;
  /** The kernel contract the plugin was written against. */
  api: "1";
  displayName: string;
  description: string;
  /**
   * Whether the plugin is on for a profile that never named it — a settings
   * file from before plugins with no switch for it, or none at all
   * (specs/app/plugins.feature.md "The profile lists enabled plugins in tab
   * order").
   */
  defaultEnabled: boolean;
  /**
   * The Settings key the module's switch lived under before the profile
   * (`testing`, `issues`, …). A settings file that still has it is read as
   * the matching profile once, and `PUT /api/state` keeps taking the key as
   * an alias for one release (src/plugins/profile.ts).
   */
  legacyKey?: string;
  /**
   * Url prefixes the plugin's views live under (`/tests`). The server serves
   * the app shell for them whether or not the plugin is on, so a deep link
   * to a switched-off module still lands in the app and goes home there.
   */
  paths?: string[];
}
