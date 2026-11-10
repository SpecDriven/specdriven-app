// Git access (specs/app/user-info-settings.feature.md "Git access"): where
// git's GitHub credentials come from, picked in Settings → Git & GitHub.
//
// - "gh": the GitHub CLI — the gh engine, gh's credential helper for every
//   host gh is logged in to; the app's own token is not used.
// - "token": a personal access token pasted into the app, on system git (or
//   the built-in engine where git is not installed).
// - "account": the app's browser or device-code sign-in, on the same
//   engines — offered only while the "GitHub account" switch is on.
//
// The engine already says whether it is "gh"; what this module adds is which
// of the app's two sign-ins the other engines stand for, so a failed
// operation can name the one the user actually chose. Kept free of imports
// from the engines so cli.ts can ask it without an import cycle.

export type GitAccess = "gh" | "token" | "account";

/** The access a stored or posted value names; null for anything else. */
export function normalizeGitAccess(value: unknown): GitAccess | null {
  return value === "gh" || value === "token" || value === "account" ? value : null;
}

/**
 * The access in effect for a settings file. The engine decides "gh"; on the
 * others "account" holds only while the GitHub account switch is on, so
 * turning the switch off falls back to the token without losing the choice.
 */
export function effectiveGitAccess(engine: string, stored: unknown, githubAccount: boolean): GitAccess {
  if (engine === "gh") return "gh";
  return stored === "account" && githubAccount ? "account" : "token";
}

// Which of the app's sign-ins a non-gh engine stands for, as applied from
// the settings file.
let appSignIn: "token" | "account" = "token";

/** Apply the app sign-in Settings chose for the system git and built-in engines. */
export function setAppSignIn(kind: "token" | "account"): void {
  appSignIn = kind;
}

// The engine in effect, registered by src/server/git/index.ts.
let engineInEffect: () => string = () => "cli";

/** Called once by the engine facade so this module can ask without importing it. */
export function registerEngineLookup(lookup: () => string): void {
  engineInEffect = lookup;
}

/** The Git access in effect right now. */
export function currentGitAccess(): GitAccess {
  return engineInEffect() === "gh" ? "gh" : appSignIn;
}
