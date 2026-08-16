// Runs before every test file (bunfig.toml). Pins PATH so the developer's
// own gh installation cannot change which git engine the suite runs on
// (tests/helpers/binPath.ts).

import { isolatePath } from "./binPath";

isolatePath();

// File logging (src/server/telemetry.ts) is on by default; tests must not
// write into the developer's real ~/.specdriven/logs. Tests of the file sink
// itself opt back in with their own SPECDRIVEN_LOG_FILE / SPECDRIVEN_LOG_DIR.
process.env.SPECDRIVEN_LOG_FILE ??= "0";
