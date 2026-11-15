// Reading and writing the settings file, as an Effect service. Which file
// that is — the project's, the home one, a settings.json or a plain
// `.specdriven` from older layouts — is decided here; what the settings
// mean is src/server/settingsModel.ts.
//
// Reads never fail: no settings file anywhere is empty state, and a file
// that is there but does not parse is empty state too, not a reason to look
// elsewhere — the user's own settings must not be silently overridden. A
// write can fail, with a FileIoError.
//
// src/server/state.ts is the Promise form of this service.

import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { dirname, join } from "node:path";
import { isYamlPath, parseSettingsText, serializeSettings } from "../settingsFormat";
import {
  APP_PACKAGE_NAME,
  jsonBackupPath,
  jsonStatePath,
  legacyPath,
  normalizeDataRepo,
  normalizeRecentFolders,
  STATE_FILE,
  statePath,
  upgradeSettings,
  type SettingsFileView,
  type SpecDrivenState,
} from "../settingsModel";
import type { FileIoError } from "./errors";
import * as Files from "./Files";
import { HomePaths } from "./HomePaths";

export interface SettingsShape {
  /**
   * The root is a checkout of this app's own source — the specdriven-app repo
   * or one of its worktrees, known by its package.json name.
   */
  readonly isAppCheckout: (rootDir: string) => Effect.Effect<boolean>;
  /**
   * The home file is the only settings file for this root: in the desktop
   * app, and in a run from the app's own source checkout
   * (specs/ui/app-start.feature.md "Settings file").
   */
  readonly homeSettingsOnly: (rootDir: string) => Effect.Effect<boolean>;
  /** The settings file `read` reads, or null when there is none anywhere. */
  readonly file: (rootDir: string) => Effect.Effect<string | null>;
  /** The settings: the project file wins, the home one is the fallback. */
  readonly read: (rootDir: string) => Effect.Effect<SpecDrivenState>;
  /** Write back to whichever settings file `read` would pick up; with none anywhere, the project one. */
  readonly write: (state: SpecDrivenState, rootDir: string) => Effect.Effect<void, FileIoError>;
  /** The directory holding the settings file `write` would write to. */
  readonly directory: (rootDir: string) => Effect.Effect<string>;
  /** The user's home settings file as written — no upgrade, no normalizing. */
  readonly fileView: (rootDir: string) => Effect.Effect<SettingsFileView>;
}

/** The app's package name in a package.json text, or undefined when the text is not one. */
function packageName(text: string): unknown {
  try {
    const pkg = JSON.parse(text) as unknown;
    return typeof pkg === "object" && pkg !== null ? (pkg as { name?: unknown }).name : undefined;
  } catch {
    return undefined;
  }
}

/** Settings text as state in this app's format; text that does not parse is empty state. */
function stateFrom(text: string, path: string): SpecDrivenState {
  try {
    const parsed = parseSettingsText(text, path);
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as SpecDrivenState;
    // A folder saved before normalizing may still carry its trailing slash.
    if (typeof state.dataRepo === "string") state.dataRepo = normalizeDataRepo(state.dataRepo);
    if (typeof state.openCodeRepo === "string") state.openCodeRepo = normalizeDataRepo(state.openCodeRepo);
    // An older file is read in this app's format (SETTINGS_UPGRADES); the
    // next save writes it that way. One a newer app wrote is left as it is.
    upgradeSettings(state as Record<string, unknown>);
    if (state.recentFolders !== undefined) state.recentFolders = normalizeRecentFolders(state.recentFolders);
    return state;
  } catch {
    return {};
  }
}

const make = Effect.gen(function* () {
  const fs = yield* Effect.service(FileSystem);
  const home = yield* Effect.service(HomePaths);
  /** The file programs need a file system; the service has this one. */
  const onFs = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Effect.Effect<A, E> =>
    Effect.provideService(effect, FileSystem, fs);

  const isFile = (path: string): Effect.Effect<boolean> => onFs(Files.fileExists(path));

  /** The fallback settings file: ~/.specdriven/settings.yaml. */
  const homeStatePath = Effect.map(home.appHome, (dir) => join(dir, STATE_FILE));

  const isAppCheckout = (rootDir: string): Effect.Effect<boolean> =>
    onFs(Files.readTextStrict(join(rootDir, "package.json"))).pipe(
      Effect.map((text) => packageName(text) === APP_PACKAGE_NAME),
      Effect.catch(() => Effect.succeed(false)),
    );

  const homeSettingsOnly = (rootDir: string): Effect.Effect<boolean> =>
    Effect.flatMap(home.homeSettingsOnly, (only) => (only ? Effect.succeed(true) : isAppCheckout(rootDir)));

  /**
   * The settings file a folder holds, given its settings.yaml path: that
   * file, or the settings.json from before it while it has not been
   * converted. A settings.json beside a settings.yaml is not read. Null when
   * neither is there.
   */
  const settingsAt = (yamlPath: string): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      if (yield* isFile(yamlPath)) return yamlPath;
      const json = jsonStatePath(yamlPath);
      return (yield* isFile(json)) ? json : null;
    });

  /** Parsed settings at path, or null when there is no settings file there. */
  const readFrom = (path: string): Effect.Effect<SpecDrivenState | null> =>
    Effect.gen(function* () {
      if (!(yield* isFile(path))) return null;
      return yield* onFs(Files.readTextStrict(path)).pipe(
        Effect.map((text) => stateFrom(text, path)),
        Effect.catch(() => Effect.succeed<SpecDrivenState>({})),
      );
    });

  /**
   * Saves settings as the settings.yaml at yamlPath. A settings.json the
   * folder still kept its settings in is then set aside as settings.json.bak,
   * so one file holds the settings; one lying beside a settings.yaml that was
   * already there was not being read, and stays as it is.
   */
  const saveSettings = (yamlPath: string, state: SpecDrivenState): Effect.Effect<void, FileIoError> =>
    Effect.gen(function* () {
      const hadYaml = yield* isFile(yamlPath);
      // In one step: requests read the file while others write it.
      yield* onFs(Files.replaceText(yamlPath, serializeSettings(state)));
      if (hadYaml) return;
      const json = jsonStatePath(yamlPath);
      if (yield* isFile(json)) yield* onFs(Files.rename(json, jsonBackupPath(json)));
    });

  const file = (rootDir: string): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      // The desktop app and the app's own checkout read the home file first;
      // an old project file is read only while there is no home file yet, and
      // the next save moves it home.
      const legacy = legacyPath(rootDir);
      const homePath = yield* homeStatePath;
      const order = (yield* homeSettingsOnly(rootDir))
        ? [homePath, statePath(rootDir), legacy]
        : [statePath(rootDir), legacy, homePath];
      for (const path of order) {
        // Each folder's settings.yaml, or its settings.json from before YAML.
        const found = path === legacy ? ((yield* isFile(path)) ? path : null) : yield* settingsAt(path);
        if (found) return found;
      }
      return null;
    });

  const read = (rootDir: string): Effect.Effect<SpecDrivenState> =>
    Effect.gen(function* () {
      const path = yield* file(rootDir);
      return (path && (yield* readFrom(path))) || {};
    });

  const write = (state: SpecDrivenState, rootDir: string): Effect.Effect<void, FileIoError> =>
    Effect.gen(function* () {
      const homePath = yield* homeStatePath;
      if (yield* homeSettingsOnly(rootDir)) {
        yield* saveSettings(homePath, state);
        return;
      }
      const local = statePath(rootDir);
      const legacy = legacyPath(rootDir);
      if (yield* isFile(legacy)) {
        // The .specdriven directory can't be created while a file of that name
        // is in the way. Move it aside rather than delete it, so an
        // interrupted migration leaves the old settings recoverable instead
        // of gone.
        const aside = `${legacy}.migrating`;
        yield* onFs(Files.rename(legacy, aside));
        yield* saveSettings(local, state);
        yield* onFs(Files.removeFile(aside));
        return;
      }
      const target = !(yield* settingsAt(local)) && (yield* settingsAt(homePath)) ? homePath : local;
      yield* saveSettings(target, state);
    });

  /**
   * No legacy-file migration here: a stale plain `.specdriven` file blocks
   * creating the directory until the next settings save moves it aside.
   */
  const directory = (rootDir: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const local = statePath(rootDir);
      const homePath = yield* homeStatePath;
      if (yield* homeSettingsOnly(rootDir)) return dirname(homePath);
      const target = !(yield* settingsAt(local)) && (yield* settingsAt(homePath)) ? homePath : local;
      return dirname(target);
    });

  const fileView = (rootDir: string): Effect.Effect<SettingsFileView> =>
    Effect.gen(function* () {
      const homePath = yield* homeStatePath;
      const found = yield* settingsAt(homePath);
      const path = found ?? homePath;
      const active = yield* file(rootDir);
      const view: SettingsFileView = {
        path,
        home: yield* home.userHome,
        exists: found !== null,
        settings: {},
      };
      if (active && active !== path) view.activePath = active;
      if (!view.exists) return view;
      const unreadable = isYamlPath(path) ? "The file is not valid YAML." : "The file is not valid JSON.";
      const text = yield* onFs(Files.readTextStrict(path)).pipe(Effect.catch(() => Effect.succeed(null)));
      if (text === null) {
        view.error = unreadable;
        return view;
      }
      try {
        const parsed = parseSettingsText(text, path);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          view.settings = parsed as Record<string, unknown>;
        } else view.error = "The file does not hold a settings object.";
      } catch {
        view.error = unreadable;
      }
      return view;
    });

  return Settings.of({ isAppCheckout, homeSettingsOnly, file, read, write, directory, fileView });
});

/** The settings file of this user and the project roots this process serves. */
export class Settings extends Context.Service<Settings, SettingsShape>()("specdriven/persistence/Settings") {
  /** The settings on whatever file system and home paths the context provides. */
  static readonly layer = Layer.effect(this, make);
}
