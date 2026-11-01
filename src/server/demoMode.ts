// Whether the app runs as the demo, and the fixed values the demo stands in
// with (src/server/demo.ts). Kept apart from demo.ts, which sets the demo up
// and so reaches the plugin loader, marketplace and agent chat: the git
// engine, logging and the built-in plugins only need to ask "is this the
// demo?", and importing demo.ts for that closed an import cycle back through
// the plugin loader into src/server/pages.ts.

import type { GitHubRepo } from "./repo";

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE;
  return v === "1" || v === "true";
}

/**
 * The demo's stand-in identity. A public demo has no OS account worth
 * showing — in a container `os.userInfo()` reports whatever uid the process
 * happens to run as — so the User info dialog and the commits the demo
 * writes both name this fixed user instead.
 */
export const DEMO_USER = {
  username: "Test User",
  login: null,
  name: "Test User",
  email: "test-user@specdriven.demo",
} as const;

/**
 * The repository whose issues the demo's Issues tab shows. The demo dataset
 * is a .git-less copy, so no code repo on disk names a remote to read; this
 * public repo stands in, and src/server/issues.ts readIssuesRepo returns it
 * while DEMO_MODE is on. Reads go out anonymously — a visitor is signed in
 * to nothing — so GitHub's anonymous rate limit applies and writes fail with
 * the module's usual "sign in" message.
 */
export const DEMO_ISSUES_REPO: GitHubRepo = {
  url: "https://github.com/SpecDriven/specdriven-app",
  host: "github.com",
  owner: "SpecDriven",
  name: "specdriven-app",
};
