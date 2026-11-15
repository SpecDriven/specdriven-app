// Where this user's own files live, as a service: the app's home directory
// (settings, tokens, secrets), the user's home, and whether the home settings
// file is the only one. The storage core asks this instead of reading
// `process.env` and `os.homedir()` itself, so a test hands it fixed places
// without touching the process.

import { Context, Effect, Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_SETTINGS_ENV, STATE_DIR } from "../settingsModel";

export interface HomePathsShape {
  /** The app's home directory: $SPECDRIVEN_HOME, else ~/.specdriven. */
  readonly appHome: Effect.Effect<string>;
  /** The user's home directory. */
  readonly userHome: Effect.Effect<string>;
  /** True when this process keeps its settings in the home file only — the desktop app. */
  readonly homeSettingsOnly: Effect.Effect<boolean>;
}

export class HomePaths extends Context.Service<HomePaths, HomePathsShape>()(
  "specdriven/persistence/HomePaths",
) {
  /**
   * The process's own: read from the environment on every use, so a changed
   * $SPECDRIVEN_HOME (tests, install scripts) is honored at once.
   */
  static readonly layer = Layer.succeed(this, {
    appHome: Effect.sync(() => process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR)),
    userHome: Effect.sync(() => homedir()),
    homeSettingsOnly: Effect.sync(() => process.env[HOME_SETTINGS_ENV] === "1"),
  });

  /** Fixed places, for a test or a tool that brings its own. */
  static fixed(paths: {
    readonly appHome: string;
    readonly userHome?: string;
    readonly homeSettingsOnly?: boolean;
  }): Layer.Layer<HomePaths> {
    return Layer.succeed(this, {
      appHome: Effect.succeed(paths.appHome),
      userHome: Effect.succeed(paths.userHome ?? paths.appHome),
      homeSettingsOnly: Effect.succeed(paths.homeSettingsOnly ?? false),
    });
  }
}
