// Runs before every test file (bunfig.toml). Pins PATH so the developer's
// own gh installation cannot change which git engine the suite runs on
// (tests/helpers/binPath.ts).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatePath } from "./binPath";

isolatePath();

// The home settings file (src/server/state.ts homeStatePath) is where
// writeState lands whenever a test's SPECDRIVEN_ROOT has no settings file of
// its own — so a test that set only the root overwrote the developer's real
// ~/.specdriven/settings.yaml, pointing the installed app at a deleted temp
// folder (2026-11-09). Every test gets an empty home of its own; the tests
// that need a particular one still set SPECDRIVEN_HOME themselves.
process.env.SPECDRIVEN_HOME = mkdtempSync(join(tmpdir(), "specdriven-test-home-"));

// File logging (src/server/telemetry.ts) is on by default; tests must not
// write into the developer's real ~/.specdriven/logs. Tests of the file sink
// itself opt back in with their own SPECDRIVEN_LOG_FILE / SPECDRIVEN_LOG_DIR.
process.env.SPECDRIVEN_LOG_FILE ??= "0";

// The agent plugins the app installs at start for the commands it finds
// (src/plugins/host/autoInstall.ts) would clone the marketplace from
// GitHub: no test start reaches out. The one test of that start swaps the
// marketplace for a fake and clears this (tests/autoInstall.test.ts).
process.env.SPECDRIVEN_NO_AUTO_INSTALL ??= "1";
