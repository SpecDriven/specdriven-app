// Signed commits (specs/app/user-info-settings.feature.md "Signed commits"):
// some repositories only take signed commits, and nobody should have to tell
// the app which. It signs the commits it makes in a folder when
//
//   - git's own config signs there (`commit.gpgsign`, from the repository,
//     the user's config or an `includeIf` rule),
//   - the newest commits of the branch's upstream are all signed, and git
//     has a signing key for the folder — a habit the app keeps to, where
//     this computer can, or
//   - the remote has refused a push for want of a signature. That is
//     remembered in the settings file (`signedCommitRepos`, a list of GitHub
//     urls: a repository, an owner or a whole host — which may be written
//     there by hand too), and the commits that were waiting are signed again
//     (resign.ts).
//
// A signed commit is made the way git on this computer makes one:
// `commit.gpgsign=true` for that command, with the key and its format (GPG,
// SSH, X.509) from this computer's git config — the app keeps no key. The
// author is this computer's git identity too, not the GitHub account the
// app otherwise commits as: GitHub only verifies a signature whose key
// belongs to the committer's email, and the key was made for the email in
// git config.
//
// The built-in engine cannot sign (just-git has no signing), so it refuses
// a commit in a repository on the list rather than make one the remote
// rejects. What git's config or the history say is a habit it cannot keep
// to, and no reason to stop anyone saving: there it commits as before.
//
// Kept free of imports from the engines, like access.ts, so cli.ts and
// js.ts can both ask it: what it asks git, it asks the binary directly.

import { isHostedMode } from "../hostedMode";
import { run, which } from "../run";
import { originUrl } from "./origin";
import { covers, normalizeSignedCommitRepos, parseRepoScope, scopeUrl } from "./repoScope";
import type { RepoScope } from "./repoScope";

export { normalizeSignedCommitRepos, parseRepoScope, scopeUrl } from "./repoScope";
export type { RepoScope } from "./repoScope";

// The list in effect, as applied from the settings file.
let scopes: RepoScope[] = [];

// Folders whose remote refused an unsigned push and has no url the list
// could hold (a path on this computer): remembered while the app runs.
const refusedHere = new Set<string>();

/**
 * Why the app signs the commits it makes in a folder: its repository is on
 * the remembered list, git's config signs there, or the upstream's newest
 * commits are all signed.
 */
export type SigningReason = "listed" | "git-config" | "history";

// What git answered about each folder, for a minute: a save commits, and a
// commit asks; neither the config nor the upstream's history changes that
// often.
const REASON_STANDS_MS = 60_000;
const answers = new Map<string, { reason: SigningReason | null; at: number }>();

/** How many of the upstream's newest commits must all be signed for the app to sign too. */
export const SIGNED_HISTORY_DEPTH = 5;

/** Apply the list the settings file holds. */
export function setSignedCommitRepos(urls: readonly string[]): void {
  scopes = normalizeSignedCommitRepos(urls).map((url) => parseRepoScope(url)!);
}

/** Forget what git answered, and what was refused here — for tests. */
export function forgetSigning(): void {
  answers.clear();
  refusedHere.clear();
}

/** Whether commits to the repository a remote url names are on the remembered list. */
export function signsCommitsTo(remoteUrl: string | null | undefined): boolean {
  if (scopes.length === 0 || !remoteUrl) return false;
  const repo = parseRepoScope(remoteUrl);
  return repo !== null && scopes.some((scope) => covers(scope, repo));
}

/** What one read-only git command says in a folder; null when it fails, or there is no git. */
async function gitSays(repoDir: string, ...args: string[]): Promise<string | null> {
  const res = await run("git", ["-C", repoDir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 10_000,
    label: `git ${args[0]}`,
  });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/**
 * Whether every commit of a `git log --format=raw` listing carries a
 * signature, and there is at least one. The raw format prints a commit's
 * own headers unindented and its message indented, so a `gpgsig` at the
 * start of a line is the header and nothing a message could say.
 */
export function allSigned(rawLog: string): boolean {
  const commits = rawLog.split(/^commit [0-9a-f]+.*$/m).slice(1);
  return commits.length > 0 && commits.every((commit) => /^gpgsig(-sha256)? /m.test(commit));
}

/**
 * Whether the newest commits the remote holds are all signed — of the
 * branch's upstream, else of the remote's default branch — in a folder git
 * has a signing key for. Without a key the habit cannot be kept, and a
 * commit that then failed would leave what was saved uncommitted: someone
 * with no key must still be able to save where others sign.
 */
async function historySigned(repoDir: string): Promise<boolean> {
  if (!(await gitSays(repoDir, "config", "--get", "user.signingkey"))) return false;
  for (const ref of ["@{upstream}", "refs/remotes/origin/HEAD"]) {
    const log = await gitSays(repoDir, "log", `-${SIGNED_HISTORY_DEPTH}`, "--format=raw", "--no-show-signature", ref, "--");
    if (log !== null) return allSigned(log);
  }
  return false;
}

/** What git itself says about a folder: its config first, then the upstream's history. */
async function askGit(repoDir: string): Promise<SigningReason | null> {
  if (which("git") === null) return null;
  if ((await gitSays(repoDir, "config", "--type=bool", "--get", "commit.gpgsign")) === "true") return "git-config";
  return (await historySigned(repoDir)) ? "history" : null;
}

/**
 * Why the app signs the commits it makes in a folder, or null where it
 * signs none. The list is read from the folder's git config on disk; git is
 * asked at most once a minute per folder, and never by a hosted worker,
 * which signs nothing.
 */
export async function signingReason(repoDir: string): Promise<SigningReason | null> {
  if (isHostedMode()) return null;
  if (refusedHere.has(repoDir)) return "listed";
  if (scopes.length > 0 && signsCommitsTo(await originUrl(repoDir))) return "listed";
  const known = answers.get(repoDir);
  if (known && Date.now() - known.at < REASON_STANDS_MS) return known.reason;
  const reason = await askGit(repoDir);
  answers.set(repoDir, { reason, at: Date.now() });
  return reason;
}

/** Whether the app signs the commits it makes in a folder. */
export async function signsCommitsIn(repoDir: string): Promise<boolean> {
  return (await signingReason(repoDir)) !== null;
}

/**
 * Whether a failed push's output says the remote wants signatures: GitHub's
 * branch protection and rulesets ("Commits must have verified signatures"),
 * GitLab's push rule ("Commit must be signed with a GPG key").
 */
export function signatureRefusal(output: string): boolean {
  return /commits? must (have (verified|valid) signatures|be signed)/i.test(output);
}

// What keeps a learned url: the settings file's writer, registered by the
// API layer, which owns that file.
let keep: ((url: string) => Promise<void>) | null = null;

/** Register what writes a learned url into the settings file; answers what did so before. */
export function onSignedRepoLearned(
  writer: ((url: string) => Promise<void>) | null,
): ((url: string) => Promise<void>) | null {
  const before = keep;
  keep = writer;
  return before;
}

/**
 * Remember that a folder's remote only takes signed commits: its
 * repository's url joins the list, in effect at once and kept in the
 * settings file. Answers the url, or null for a remote with no url the list
 * could hold — remembered for that folder while the app runs.
 */
export async function rememberSigned(repoDir: string): Promise<string | null> {
  const scope = parseRepoScope((await originUrl(repoDir)) ?? "");
  if (!scope || scope.path.length < 2) {
    refusedHere.add(repoDir);
    return null;
  }
  const url = scopeUrl(scope);
  if (signsCommitsTo(url)) return url;
  scopes.push(scope);
  await keep?.(url);
  return url;
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

/** What the built-in engine answers when asked to commit to a repository on the list. */
export const BUILT_IN_CANNOT_SIGN =
  "this repository only takes signed commits, and the built-in git cannot sign — install git and set up its signing key";

/**
 * What a push the remote refused for want of a signature says after git's
 * own words: what the app does about it, and the one thing it cannot do.
 */
export const REFUSED_PUSH_HINT =
  "the remote only takes signed commits: the app signs this repository's commits from now on, with the signing key in this computer's git config — a key the host must know as a signing key of this computer's git user";

/**
 * What a commit that failed where commits are signed says after git's own
 * words: where the key comes from, since the usual reason is that git on
 * this computer has none, or could not ask for its passphrase.
 */
export const SIGNING_HINT =
  "this repository's commits are signed: git signs with the key in this computer's git config (user.signingkey, gpg.format), as this computer's git user";

/**
 * For the one reason the app can fix: ssh-keygen could not open the key.
 * Said wherever a commit fails for it, signed by the app's rule or not.
 */
export const LOCKED_KEY_HINT =
  "the SSH key git signs commits with is locked: enter its passphrase in Settings → Git & GitHub → Signed commits";

/** Whether a failed commit's output says the signing key could not be opened. */
export function lockedKey(output: string): boolean {
  return /incorrect passphrase|passphrase.*(required|needed)/i.test(output);
}

/**
 * What to say after git's own words about a commit that failed: for a
 * locked key, how to unlock it; else, where commits are signed (`signs`),
 * where git looks for the key; else nothing.
 */
export function signingHint(output: string, signs = true): string | null {
  if (lockedKey(output)) return LOCKED_KEY_HINT;
  return signs ? SIGNING_HINT : null;
}
