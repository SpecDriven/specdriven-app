// Upgrading the settings file when a new version of the app starts
// (specs/ui/app-start.feature.md "Settings file"). readState already reads
// an older file in this app's format (SETTINGS_UPGRADES in state.ts); this
// saves that once, at start, so the file on disk is in the new format from
// the first launch, and keeps the file as it was beside it — the way back
// for someone who returns to the older app.

import { copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import {
  readState,
  settingsFile,
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

export interface SettingsFileUpgrade extends SettingsUpgradeResult {
  /** The settings file. */
  path: string;
  /** The copy of the file as it was, when it was upgraded. */
  backup: string | null;
}

/**
 * Brings the settings file readState reads up to this app's format: runs
 * the steps it has not had, keeps the file as it was beside it (a backup
 * already there is left alone — it holds the oldest version), and saves.
 * A file a newer app wrote is left untouched and logged. Null when there is
 * no settings file, or it does not parse — readState treats that as empty
 * state, and nothing is gained by rewriting it.
 */
export async function upgradeSettingsFile(rootDir: string): Promise<SettingsFileUpgrade | null> {
  const path = await settingsFile(rootDir);
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
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
    return { ...result, path, backup: null };
  }
  if (result.from === result.to) return { ...result, path, backup: null };
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
  return { ...result, path, backup };
}
