import { userInfo } from "node:os";
import { getAuth } from "./auth";
import { DEMO_USER, isDemoMode } from "./demoMode";
import { isHostedMode } from "./hostedMode";
import { getAppRoot } from "./paths";
import { isReadOnlyMode, READ_ONLY_USER } from "./readOnlyMode";
import { cliGitAvailable, currentEngine, ghAccount, ghAccountInUse, isRepoRoot } from "./git";
import { dataRepoDir } from "./repo";
import { run } from "./run";
import { readState } from "./state";

// Current user (specs/user-info-settings.feature.md): by default the user on
// the OS, plus the identity that authors the app's commits to the data
// repo — the signed-in GitHub account, the GitHub CLI's account when that
// engine is in effect, or the system git identity as git resolves it in the
// data repo. Reported via /api/state
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

/**
 * The data repo's folder when it is already a repository, else null. Git
 * config is read there because that is where the commits are made: the
 * repo's own `.git/config` and any `includeIf "gitdir:…"` rule in the user's
 * config apply to it, while the app's own folder (the desktop app runs from
 * its user-data directory) would only ever see the global identity.
 */
async function dataRepoFolder(): Promise<string | null> {
  const root = getAppRoot();
  const { dataRepo } = await readState(root);
  if (!dataRepo) return null;
  const dir = dataRepoDir(dataRepo, root);
  return (await isRepoRoot(dir)) ? dir : null;
}

async function gitConfig(key: string, cwd: string | null): Promise<string | null> {
  if (!cliGitAvailable()) return null;
  const out = await run("git", ["config", key], cwd ? { cwd } : {});
  const value = out.stdout.trim();
  return out.exitCode === 0 && value ? value : null;
}

/**
 * Who the app's edits are signed by — a notebook entry's author
 * (specs/app/engineering-notebook.feature.md), the creator and last updater
 * of a feature or a scenario (specs/app/specs-authorship.feature.md): the
 * identity that authors the app's commits to the data repo — the GitHub
 * login when one is known, which for an agent given its own token is the
 * agent's account, else the git user name, else the OS user.
 */
export async function currentAuthor(): Promise<string> {
  const user = await getCurrentUser();
  return user.login ?? user.name ?? user.username;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  // The demo has no real user behind it: everyone who opens it is Test User.
  if (isDemoMode()) return { ...DEMO_USER };
  // Nor does the read-only site: every visitor is the same anonymous one.
  if (isReadOnlyMode()) return { ...READ_ONLY_USER };
  // A hosted worker's OS user is the container's; its user is the account
  // the gateway signed in (src/gateway/workers.ts).
  const username = (isHostedMode() && process.env.SPECDRIVEN_ACCOUNT_EMAIL) || userInfo().username;
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
  // authors nothing, so reporting it would misname the commits. Not after
  // signing out of the app either — that turns gh's account off too.
  const gh = currentEngine() === "gh" && (await ghAccountInUse()) ? await ghAccount() : null;
  if (gh) {
    return { username, login: gh.login, name: gh.name ?? gh.login, email: gh.email };
  }
  const repo = await dataRepoFolder();
  return {
    username,
    login: null,
    name: await gitConfig("user.name", repo),
    email: await gitConfig("user.email", repo),
  };
}
