// Where the app keeps things (specs/desktop-app.spec.md). The web server
// runs relative to the checkout: settings under the current directory and
// GitHub clones in a sibling directory. The packaged desktop app has no
// meaningful working directory, so it points both locations at its own data
// directory via SPECDRIVEN_ROOT / SPECDRIVEN_REPOS_DIR before any server
// module loads.

import { resolve } from "node:path";

/** Root the settings lookup is relative to. */
export function getAppRoot(): string {
  return process.env.SPECDRIVEN_ROOT || process.cwd();
}

/** Directory GitHub data repos are cloned into. */
export function cloneBase(rootDir: string): string {
  return process.env.SPECDRIVEN_REPOS_DIR || resolve(rootDir, "..");
}
