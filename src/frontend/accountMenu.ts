// The user menu's GitHub entries in the desktop and local app
// (specs/app/user-info-settings.feature.md "log out from the user menu"):
// "Switch account…" while the app is signed in with a token, and "Log out"
// always. Signing in is the first-run screen's, where log out leads. The
// hosted app has its own account page and sign-out; the demo has neither.

export type AccountMenuEntry = "switch-account" | "log-out";

export function accountMenuEntries(opts: { hosted: boolean; demo: boolean; signedIn: boolean }): AccountMenuEntry[] {
  if (opts.hosted || opts.demo) return [];
  return opts.signedIn ? ["switch-account", "log-out"] : ["log-out"];
}
