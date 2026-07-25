// Runs before every test file (bunfig.toml). Pins PATH so the developer's
// own gh installation cannot change which git engine the suite runs on
// (tests/helpers/binPath.ts).

import { isolatePath } from "./binPath";

isolatePath();
