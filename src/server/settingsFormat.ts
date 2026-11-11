// The settings file's text format (specs/ui/app-start.feature.md "Settings
// file"): YAML, in settings.yaml. A settings.json from before the switch — and
// the plain `.specdriven` file from before that — is JSON, and still read so
// an existing installation keeps its settings until the file is converted
// (src/server/settingsUpgrade.ts).
//
// The `yaml` package rather than Bun.YAML: this runs under Node too, in the
// desktop app's main process.

import { parse, stringify } from "yaml";

/** The settings file's extension; a path without it holds JSON. */
const YAML_EXTENSION = ".yaml";

/** A settings path names a YAML file, not one of the older JSON ones. */
export function isYamlPath(path: string): boolean {
  return path.toLowerCase().endsWith(YAML_EXTENSION);
}

/**
 * What a settings file's text holds: parsed as YAML or JSON by the file's
 * name. Throws on text that does not parse; an empty YAML file is null.
 */
export function parseSettingsText(text: string, path: string): unknown {
  return isYamlPath(path) ? parse(text) : JSON.parse(text);
}

/**
 * Settings as the file's text. Long values stay on one line (a folder path
 * or url is never folded), and a string YAML would read as something else —
 * "true", "123", "null", an empty one — is written quoted, so every value
 * comes back as it went in.
 */
export function serializeSettings(state: object): string {
  return stringify(state, { lineWidth: 0 });
}
