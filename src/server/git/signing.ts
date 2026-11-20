// Signed commits (specs/app/user-info-settings.feature.md "Signed commits"):
// some repositories only take signed commits, so Settings → Git & GitHub
// lists the GitHub urls whose commits the app signs — a repository, an
// owner (every repository of that user or organization) or a whole host.
//
// A commit in a listed repository is made the way git on this computer
// makes a signed one: `commit.gpgsign=true` for that command, with the key
// and its format (GPG, SSH, X.509) from this computer's git config — the
// app keeps no key. The author is this computer's git identity too, not the
// GitHub account the app otherwise commits as: GitHub only verifies a
// signature whose key belongs to the committer's email, and the key was
// made for the email in git config.
//
// The built-in engine cannot sign (just-git has no signing), so it refuses
// a commit in a listed repository rather than make one the remote rejects.
//
// Kept free of imports from the engines, like access.ts, so cli.ts and
// js.ts can both ask it.

import { originUrl } from "./origin";
import { covers, normalizeSignedCommitRepos, parseRepoScope } from "./repoScope";
import type { RepoScope } from "./repoScope";

export { normalizeSignedCommitRepos, parseRepoScope, scopeUrl } from "./repoScope";
export type { RepoScope } from "./repoScope";

// The list in effect, as applied from the settings file.
let scopes: RepoScope[] = [];

/** Apply the list Settings holds. */
export function setSignedCommitRepos(urls: readonly string[]): void {
  scopes = normalizeSignedCommitRepos(urls).map((url) => parseRepoScope(url)!);
}

/** Whether the list names anything: false means no commit is signed, and nothing need be looked up. */
export function signsAnyCommits(): boolean {
  return scopes.length > 0;
}

/** Whether commits to the repository a remote url names are to be signed. */
export function signsCommitsTo(remoteUrl: string | null | undefined): boolean {
  if (scopes.length === 0 || !remoteUrl) return false;
  const repo = parseRepoScope(remoteUrl);
  return repo !== null && scopes.some((scope) => covers(scope, repo));
}

/**
 * Whether the app signs the commits it makes in a folder: its `origin` is
 * on the list. Read from the folder's git config on disk, and not at all
 * while the list is empty.
 */
export async function signsCommitsIn(repoDir: string): Promise<boolean> {
  if (scopes.length === 0) return false;
  return signsCommitsTo(await originUrl(repoDir));
}

/** The git commands that can make a commit: its own, and a merge's. */
const COMMIT_VERBS = new Set(["commit", "merge", "pull"]);

/**
 * Whether a git command may come to sign what it makes, and so to ask for a
 * key's passphrase: the ones above that stay on this computer. A pull talks
 * to the remote, where ssh has questions of its own to ask.
 */
export function maySign(verb: string | undefined): boolean {
  return verb === "commit" || verb === "merge";
}

/** Whether a git command can make a commit. */
export function makesCommit(verb: string | undefined): boolean {
  return verb !== undefined && COMMIT_VERBS.has(verb);
}

/** What signs a commit made by one git command, as `-c` overrides. */
export const SIGN_CONFIG = ["-c", "commit.gpgsign=true"];

/** What the built-in engine answers when asked to commit where commits are signed. */
export const BUILT_IN_CANNOT_SIGN =
  "this repository's commits must be signed (Settings → Git & GitHub → Signed commits), and the built-in git cannot sign — install git and set up its signing key";

/**
 * What a commit that failed where commits are signed says after git's own
 * words: where the key comes from, since the usual reason is that git on
 * this computer has none, or could not ask for its passphrase.
 */
export const SIGNING_HINT =
  "this repository's commits are signed (Settings → Git & GitHub → Signed commits): git signs with the key in this computer's git config (user.signingkey, gpg.format), as this computer's git user";

/**
 * For the one reason the app can fix: ssh-keygen could not open the key.
 * Said wherever git signs — a repository on the list, or any other when
 * git's own config signs every commit.
 */
export const LOCKED_KEY_HINT =
  "the SSH key git signs commits with is locked: enter its passphrase in Settings → Git & GitHub → Signed commits";

/** Whether a failed commit's output says the signing key could not be opened. */
export function lockedKey(output: string): boolean {
  return /incorrect passphrase|passphrase.*(required|needed)/i.test(output);
}

/**
 * What to say after git's own words about a commit that failed: for a
 * locked key, how to unlock it; else, where commits are signed (`listed`),
 * where git looks for the key; else nothing.
 */
export function signingHint(output: string, listed = true): string | null {
  if (lockedKey(output)) return LOCKED_KEY_HINT;
  return listed ? SIGNING_HINT : null;
}
