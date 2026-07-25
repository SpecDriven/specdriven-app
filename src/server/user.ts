import { userInfo } from "node:os";
import { getAuth } from "./auth";
import { cliGitAvailable } from "./git";
import { run } from "./run";

// Current user (specs/user-info-settings.spec.md): by default the user on
// the OS, plus the identity that authors the app's commits to the data
// repo — the signed-in GitHub account, or the system git identity when
// signed out and git is installed. Reported via /api/state and shown in
// the sidebar's user corner.

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
  const auth = await getAuth();
  if (auth) {
    return {
      username: userInfo().username,
      login: auth.login,
      name: auth.name ?? auth.login,
      email: auth.email,
    };
  }
  return {
    username: userInfo().username,
    login: null,
    name: await gitConfig("user.name"),
    email: await gitConfig("user.email"),
  };
}
