// Local state lives in .specdriven/settings.yaml — in the project root, or in
// the user's home directory as a fallback (specs/ui/app-start.feature.md). A
// settings.json from before the file was YAML is still read, and converted
// when the app starts (src/server/settingsUpgrade.ts).
// Per specs/ui/app-start.feature.md: if it doesn't name the last data repo,
// the UI must ask the user for one.
//
// What the settings are — their shape, their files' paths, the rules that
// normalize and upgrade them — is settingsModel.ts, re-exported here. The
// functions below read and write the file: each is the Promise form of a
// program of the Settings service (src/server/persistence/Settings.ts).

import { run } from "./persistence/runtime";
import { Settings } from "./persistence/Settings";
import type { SettingsFileView, SpecDrivenState } from "./settingsModel";

export * from "./settingsModel";

/**
 * The root is a checkout of this app's own source — the specdriven-app repo or
 * one of its worktrees, known by its package.json name. A dev server run from
 * there always keeps its settings in the home file
 * (specs/ui/app-start.feature.md "Settings file"), so every checkout and
 * worktree shares the user's one settings file instead of growing its own.
 */
export async function isAppCheckout(rootDir: string): Promise<boolean> {
  return run(Settings.use((settings) => settings.isAppCheckout(rootDir)));
}

/**
 * The home file is the only settings file for this root: in the desktop app,
 * and in a run from the app's own source checkout
 * (specs/ui/app-start.feature.md "Settings file").
 */
export async function homeSettingsOnly(rootDir: string): Promise<boolean> {
  return run(Settings.use((settings) => settings.homeSettingsOnly(rootDir)));
}

/**
 * The directory holding the settings file writeState would write to:
 * <root>/.specdriven, unless only ~/.specdriven/settings.yaml exists (same
 * rule as writeState). Local, non-git session records live beside the
 * settings (src/server/agent.ts). No legacy-file migration here: a stale
 * plain `.specdriven` file blocks creating the directory until the next
 * settings save moves it aside.
 */
export async function settingsDirectory(rootDir: string = process.cwd()): Promise<string> {
  return run(Settings.use((settings) => settings.directory(rootDir)));
}

/**
 * The project settings file wins; the home one is the fallback, so one
 * settings file can serve every checkout (specs/ui/app-start.feature.md). A
 * leftover .specdriven file from the old layout still reads, and is migrated
 * on the next write.
 */
export async function readState(rootDir: string = process.cwd()): Promise<SpecDrivenState> {
  return run(Settings.use((settings) => settings.read(rootDir)));
}

/** The settings file readState reads, or null when there is none anywhere. */
export async function settingsFile(rootDir: string = process.cwd()): Promise<string | null> {
  return run(Settings.use((settings) => settings.file(rootDir)));
}

/**
 * The user's settings file, ~/.specdriven/settings.yaml, as the User info
 * dialog's "View settings file…" shows it (specs/app/user-info-settings
 * .feature.md "view the settings file"): the file as written — no upgrade,
 * no normalizing — so the view matches what is on disk. Always the home
 * file, never a project one — its settings.json while that has not been
 * converted; `activePath` names the file readState reads when that is a
 * different one.
 */
export async function readSettingsFileView(rootDir: string = process.cwd()): Promise<SettingsFileView> {
  return run(Settings.use((settings) => settings.fileView(rootDir)));
}

/**
 * Writes back to whichever settings file readState would pick up, so
 * settings stay where the user keeps them; with none anywhere, the project
 * one is created.
 */
export async function writeState(
  state: SpecDrivenState,
  rootDir: string = process.cwd(),
): Promise<void> {
  return run(Settings.use((settings) => settings.write(state, rootDir)));
}
