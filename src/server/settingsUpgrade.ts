// Upgrading the settings file when a new version of the app starts
// (specs/ui/app-start.feature.md "Settings file"). Two things, in order:
//
// The file is YAML, settings.yaml. One an older app left as settings.json is
// converted, once, at start — the same settings, written as YAML — and the
// JSON file is kept beside it as settings.json.bak.
//
// readState already reads an older file in this app's format
// (SETTINGS_UPGRADES in state.ts); this saves that once, at start, so the
// file on disk is in the new format from the first launch, and keeps the
// file as it was beside it — the way back for someone who returns to the
// older app.

import { copyFile, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { replaceTextFile } from "./fsx";
import { parseSettingsText, serializeSettings } from "./settingsFormat";
import {
  jsonBackupPath,
  LEGACY_JSON_STATE_FILE,
  readState,
  settingsFile,
  STATE_FILE,
  upgradeSettings,
  writeState,
  type SettingsUpgradeResult,
} from "./state";
import { getLogger } from "./telemetry";

const log = getLogger("settings");

/** Where the file as it was before an upgrade from `version` is kept. */
export function settingsBackupPath(path: string, version: number): string {
  return `${path}.v${version}.bak`;
}

export interface SettingsFileConversion {
  /** The settings.yaml written. */
  path: string;
  /** The settings.json it was converted from, where it is kept now. */
  backup: string;
}

/**
 * Converts the settings file readState reads from settings.json to
 * settings.yaml, in the same folder: the settings exactly as the file holds
 * them — no upgrade step, no clean-up, so nothing but the format changes —
 * and the JSON file kept beside it as settings.json.bak (a newer copy
 * replaces one already there). Null when there is nothing to convert: no
 * settings file, one that is YAML already, or a settings.json that does not
 * parse into settings — that one is left alone, and the next save sets it
 * aside (writeState).
 */
export async function convertSettingsFile(rootDir: string): Promise<SettingsFileConversion | null> {
  const json = await settingsFile(rootDir);
  if (!json || basename(json) !== LEGACY_JSON_STATE_FILE) return null;
  let parsed: unknown;
  try {
    parsed = parseSettingsText(await readFile(json, "utf8"), json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const path = join(dirname(json), STATE_FILE);
  const backup = jsonBackupPath(json);
  // The YAML file first: stopped between the two steps, both files are
  // there and the YAML one is read, so no settings are lost.
  await replaceTextFile(path, serializeSettings(parsed));
  await rename(json, backup);
  log.info("settings file converted to YAML", { path, backup });
  return { path, backup };
}

export interface SettingsFileUpgrade extends SettingsUpgradeResult {
  /** The settings file. */
  path: string;
  /** The copy of the file as it was, when it was upgraded. */
  backup: string | null;
  /** Set when the file was converted from settings.json on the way. */
  converted?: SettingsFileConversion;
}

/**
 * Brings the settings file readState reads up to this app's format: a
 * settings.json becomes settings.yaml (convertSettingsFile), then the steps
 * the file has not had run, the file as it was is kept beside it (a backup
 * already there is left alone — it holds the oldest version), and it is
 * saved. A file a newer app wrote is left untouched and logged. Null when
 * there is no settings file, or it does not parse — readState treats that as
 * empty state, and nothing is gained by rewriting it.
 */
export async function upgradeSettingsFile(rootDir: string): Promise<SettingsFileUpgrade | null> {
  const converted = (await convertSettingsFile(rootDir)) ?? undefined;
  const path = await settingsFile(rootDir);
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = parseSettingsText(await readFile(path, "utf8"), path);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const result = upgradeSettings(parsed as Record<string, unknown>);
  if (result.tooNew) {
    log.warn("settings file is from a newer app; reading it as it is", {
      path,
      version: result.from,
    });
    return { ...result, path, backup: null, converted };
  }
  if (result.from === result.to) return { ...result, path, backup: null, converted };
  const backup = settingsBackupPath(path, result.from);
  try {
    await copyFile(path, backup, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  // readState runs the same steps and the usual clean-up; writeState puts
  // the result where the user keeps settings (moving an old-layout file).
  await writeState(await readState(rootDir), rootDir);
  log.info("settings file upgraded", { path, from: result.from, to: result.to, backup, steps: result.steps });
  return { ...result, path, backup, converted };
}
