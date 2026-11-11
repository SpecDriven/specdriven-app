// The settings file as tests set it up and read it back: settings.yaml, in
// the format the app writes (src/server/settingsFormat.ts). A path that does
// not end in .yaml — the settings.json from before YAML — is JSON.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isYamlPath, parseSettingsText, serializeSettings } from "../../src/server/settingsFormat";

/** Writes settings to a settings file path, making its folder. */
export async function writeSettings(path: string, state: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, isYamlPath(path) ? serializeSettings(state) : JSON.stringify(state, null, 2) + "\n");
}

/** The settings a settings file holds, as written — no upgrade, no clean-up. */
export async function readSettings(path: string): Promise<Record<string, any>> {
  return parseSettingsText(await readFile(path, "utf8"), path) as Record<string, unknown>;
}
