// Bundled git engine (specs/git-operations.spec.md): git implemented in
// JavaScript by just-git, running in this process against the real
// filesystem. The one engine that needs nothing installed, so it is what the
// app falls back to on a machine without git.
//
// It shares every workflow with the two subprocess engines — createGitBackend
// in cli.ts issues the commands, this module only carries them out — so what
// changes here is where the pieces come from: credentials and commit
// identity are handed to just-git as options rather than injected as `-c`
// overrides on a command line, since there is no command line.
//
// Signed out it runs with no credentials, which is enough for public repos
// and fails fast on private ones, and leaves the identity to whatever git
// config the machine has.

import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createGit } from "just-git";
import type { CredentialProvider, IdentityOverride } from "just-git";
import { getAuth } from "../auth";
import { readTextFile } from "../fsx";
import type { RunResult } from "../run";
import type { GitBackend } from "./backend";
import { createGitBackend } from "./cli";
import type { GitRun } from "./cli";
import { nodeFileSystem } from "./nodeFs";

/**
 * Always true: the engine ships with the app. It exists so the engine layer
 * and Settings can ask the same question of all three engines.
 */
export function jsGitAvailable(): boolean {
  return true;
}

/**
 * The GitHub token as an HTTPS credential, in the same
 * `x-access-token:<token>` form the system-git engine feeds its credential
 * helper. Signed out there is no credential to offer, and just-git makes the
 * request anonymously.
 */
async function credentials(): Promise<CredentialProvider> {
  const auth = await getAuth();
  if (!auth) return () => null;
  return () => ({ type: "basic", username: "x-access-token", password: auth.token });
}

/**
 * The user's global git identity. just-git reads a repository's own
 * `.git/config` but knows nothing of the per-user file outside it, so
 * `~/.gitconfig` is read here — otherwise choosing this engine on a machine
 * that does have git would quietly stop honouring the identity every other
 * git on that machine uses. Git prefers `~/.gitconfig` over the XDG path,
 * and `GIT_CONFIG_GLOBAL` over both.
 */
async function globalGitIdentity(): Promise<{ name?: string; email?: string }> {
  const override = process.env.GIT_CONFIG_GLOBAL;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = override
    ? [override]
    : [join(homedir(), ".gitconfig"), join(xdg, "git", "config")];
  for (const path of paths) {
    const text = await readTextFile(path);
    if (text === null) continue;
    const found = userSection(text);
    if (found.name || found.email) return found;
  }
  return {};
}

/** name and email from the `[user]` section of a git config file. */
function userSection(text: string): { name?: string; email?: string } {
  const found: { name?: string; email?: string } = {};
  let inUser = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]\s]+)/);
    if (section) {
      inUser = section[1]!.toLowerCase() === "user";
      continue;
    }
    if (!inUser) continue;
    const entry = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!entry) continue;
    // Values may be quoted; git strips the surrounding pair.
    const value = entry[2]!.trim().replace(/^"(.*)"$/, "$1");
    const key = entry[1]!.toLowerCase();
    if (key === "name") found.name ??= value;
    if (key === "email") found.email ??= value;
  }
  return found;
}

/**
 * Who authors the commits. Signed in, the GitHub account does and nothing
 * may override it, as on the other two engines.
 *
 * Signed out, the identity is a *fallback*, so the machine's own setup keeps
 * authoring wherever it has one: just-git prefers the repository's
 * `.git/config`, and below that comes the user's global git config. Last is
 * the case this engine exists for — no git installed, so no git config
 * anywhere — where the OS user stands in, as git itself does. Without that
 * a commit would fail for want of an author, which is the one thing a
 * bundled engine must not do.
 */
async function identity(): Promise<IdentityOverride> {
  const auth = await getAuth();
  if (auth) {
    return {
      name: auth.name ?? auth.login,
      email: auth.email ?? `${auth.login}@users.noreply.github.com`,
      locked: true,
    };
  }
  const user = userInfo().username;
  const global = await globalGitIdentity();
  return {
    name: global.name ?? user,
    email: global.email ?? `${user}@${hostname()}`,
    locked: false,
  };
}

/**
 * One git command, run in-process. The client is built per command so a
 * sign-in mid-session is picked up by the next operation, exactly as the
 * subprocess engines re-resolve their context every time.
 *
 * `repoDir` is null only for `clone`, whose target directory the app always
 * gives as an absolute path; the working directory is then immaterial.
 */
const jsRun: GitRun = async (repoDir, ...args) => {
  const git = createGit({
    fs: nodeFileSystem,
    credentials: await credentials(),
    identity: await identity(),
  });
  const res = await git.execute(args, {
    fs: nodeFileSystem,
    cwd: repoDir ?? process.cwd(),
    env: new Map<string, string>(),
    stdin: "",
  });
  return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr } satisfies RunResult;
};

export const jsBackend: GitBackend = createGitBackend({ name: "js", git: jsRun });
