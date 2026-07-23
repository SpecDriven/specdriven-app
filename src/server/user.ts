import { userInfo } from "node:os";
import { run } from "./run";

// Current user (specs/user-info-settings.spec.md): by default the user on
// the OS, plus the git identity that authors the app's commits to the data
// repo. Reported via /api/state and shown in the sidebar's user corner.

export interface CurrentUser {
  /** OS account name — the default identity. */
  username: string;
  /** `git config user.name`, or null when not set. */
  name: string | null;
  /** `git config user.email`, or null when not set. */
  email: string | null;
}

async function gitConfig(key: string): Promise<string | null> {
  const out = await run("git", ["config", key]);
  const value = out.stdout.trim();
  return out.exitCode === 0 && value ? value : null;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  return {
    username: userInfo().username,
    name: await gitConfig("user.name"),
    email: await gitConfig("user.email"),
  };
}
