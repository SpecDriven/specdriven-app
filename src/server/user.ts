import { userInfo } from "node:os";
import { getAuth } from "./auth";
import { DEMO_USER, isDemoMode } from "./demo";
import { cliGitAvailable, currentEngine, ghAccount } from "./git";
import { run } from "./run";

// Current user (specs/user-info-settings.spec.md): by default the user on
// the OS, plus the identity that authors the app's commits to the data
// repo — the signed-in GitHub account, the GitHub CLI's account when that
// engine is in effect, or the system git identity. Reported via /api/state
// and shown in the sidebar's user corner.

export interface CurrentUser {
  /** OS account name — the default identity. */
  username: string;
  /** Signed-in GitHub login, or null when signed out. */
  login: string | null;
  /** Commit author name, or null when not known. */
  name: string | null;
  /** Commit author email, or null when not known. */
  email: string | null;
}

async function gitConfig(key: string): Promise<string | null> {
  if (!cliGitAvailable()) return null;
  const out = await run("git", ["config", key]);
  const value = out.stdout.trim();
  return out.exitCode === 0 && value ? value : null;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  // The demo has no real user behind it: everyone who opens it is Test User.
  if (isDemoMode()) return { ...DEMO_USER };
  const username = userInfo().username;
  const auth = await getAuth();
  if (auth) {
    return {
      username,
      login: auth.login,
      name: auth.name ?? auth.login,
      email: auth.email,
    };
  }
  // Only when gh is the engine in effect: on system git the gh account
  // authors nothing, so reporting it would misname the commits.
  const gh = currentEngine() === "gh" ? await ghAccount() : null;
  if (gh) {
    return { username, login: gh.login, name: gh.name ?? gh.login, email: gh.email };
  }
  return {
    username,
    login: null,
    name: await gitConfig("user.name"),
    email: await gitConfig("user.email"),
  };
}
