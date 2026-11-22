// System-git engine (git-operations.md): every git operation the
// app performs, run as a `git` subprocess. What separates the two engines is
// injected per command — credentials and commit identity as `-c` overrides,
// never written into the repo's own config — so the GitHub CLI engine in
// gh.ts reuses all of this plumbing and only swaps the context and the clone.
//
// Signed in, every command carries the GitHub token as an HTTPS credential
// (fed through the environment, never argv); signed out, git runs unchanged
// with the system's own configuration — exactly the behavior a user with
// working git auth already has.
//
// createGitBackend() below is the workflow shared by all three engines: it
// knows the order of operations for a pull, a conflict resolution or a save,
// and nothing about how a git command is carried out. Engines supply that as
// a GitRun — a subprocess here and in gh.ts, the bundled implementation in
// js.ts. Every command it issues is therefore one all three understand; the
// one exception is a pull, which the two that run a git binary carry out as
// its fetch and its merge (fetchThenMerge below).

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAuth } from "../auth";
import { readTextFile, writeTextFile } from "../fsx";
import { GITHUB_HOST, webBase } from "../github";
import { isHostedMode } from "../hostedMode";
import { usesGithubApp } from "../hostedToken";
import { currentGitAccess } from "./access";
import { run, which } from "../run";
import { getLogger } from "../telemetry";
import type { RunOptions, RunResult } from "../run";
import type { GitBackend, PathMove, PullResult, SyncResult, WriteAccess } from "./backend";
import { isRepoRoot } from "./repoRoot";
import { BUILT_IN_CANNOT_SIGN, SIGN_CONFIG, makesCommit, maySign, signingHint, signsCommitsIn } from "./signing";
import { signingEnv, signingTimeoutMs } from "./signingKey";
import { localTurn, remoteTurn } from "./turns";
import { FALLBACK_TITLE, pathsInStatus, summarizeSavedChanges } from "./saveSummary";
import { PROJECT_SETTINGS_FILE } from "../members";
import type { ChangedFile } from "./saveSummary";

export function cliGitAvailable(): boolean {
  return which("git") !== null;
}

/**
 * What a failed operation says when git had no usable GitHub credential: the
 * way in that Settings → Git & GitHub's Git access names. The GitHub CLI's
 * is `gh auth login`; a personal access token is pasted in Settings; the
 * browser or device-code sign-in, only offered while the "GitHub account"
 * switch is on, is never named otherwise (specs/app/user-info-settings.feature.md).
 * A hosted worker's GitHub comes from the gateway's account page, not
 * Settings (src/server/hostedMode.ts): the service's GitHub App where it has
 * one (src/server/hostedToken.ts), else a token pasted there.
 */
export function signInHint(): string {
  if (isHostedMode()) {
    return usesGithubApp()
      ? "authentication required — on your account page, connect GitHub and install the SpecDriven app on this repository"
      : "authentication required — add a GitHub token that can read and write it on your account page";
  }
  switch (currentGitAccess()) {
    case "gh":
      return "authentication required — sign the GitHub CLI in with `gh auth login`, or pick another Git access in Settings";
    case "account":
      return "authentication required — sign in with GitHub in Settings";
    default:
      return "authentication required — add a GitHub personal access token in Settings";
  }
}

/**
 * Per-command git configuration an engine runs with. Nothing here is written
 * to disk: the `-c` overrides live for the length of one subprocess, and the
 * environment carries whatever secret the configured credential helper reads.
 */
export interface GitContext {
  config: string[];
  env: Record<string, string>;
  /**
   * Who authors the commits, as `-c` overrides (identityConfig) — apart
   * from the rest so a commit that is signed can leave them out: it is
   * authored by this computer's git user, whose key signs it (signing.ts).
   */
  identity?: string[];
}

/** Runs one git command; `null` repoDir means "outside any repository". */
export type GitRun = (repoDir: string | null, ...args: string[]) => Promise<RunResult>;

/** How many changed files a save reads to describe; the rest are counted. */
const SUMMARY_READ_LIMIT = 40;

/**
 * The files the auto-save summary reads: markdown specs and pages, folder
 * descriptions, and the project settings file the tick makes
 * (specs/app/project-settings.feature.md).
 */
function isSpecText(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".txt") || path === PROJECT_SETTINGS_FILE;
}

/** Commit-author overrides for a known GitHub identity. */
export function identityConfig(name: string, email: string): string[] {
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * Context for the plain-git engine: signed in, remotes on the sign-in's
 * GitHub host are rewritten to https, the token is echoed by the only
 * credential helper for that host, and the account authors the commits. The
 * empty helper entry resets the host's helpers inherited from the machine's
 * config; every other host keeps its own. Signed out, git is left alone.
 */
export async function appContext(): Promise<GitContext> {
  const auth = await getAuth();
  if (!auth) return { config: [], env: {} };
  const name = auth.name ?? auth.login;
  const email = auth.email ?? `${auth.login}@users.noreply.github.com`;
  // A hosted worker whose gateway makes its tokens holds none itself.
  if (auth.brokered) return brokeredContext(name, email);
  return tokenContext(auth.token, name, email, auth.host);
}

/** Remotes written the ssh way go over https, where the credential is. */
function httpsRewrites(base: string, host: string): string[] {
  const sshHost = host.replace(/:\d+$/, "");
  return ["-c", `url.${base}/.insteadOf=git@${sshHost}:`, "-c", `url.${base}/.insteadOf=ssh://git@${sshHost}/`];
}

/**
 * The signed-in context for one fixed token and commit author — appContext's
 * shape, for callers (the hosted gateway's datastore) that hold a token of
 * their own rather than the app's sign-in.
 */
export function tokenContext(token: string, name: string, email: string, host: string = GITHUB_HOST): GitContext {
  const base = webBase(host);
  return {
    config: [
      ...httpsRewrites(base, host),
      "-c", `credential.${base}.helper=`,
      "-c",
      `credential.${base}.helper=!f(){ echo username=x-access-token; echo "password=$SPECDRIVEN_GIT_TOKEN"; };f`,
    ],
    env: { SPECDRIVEN_GIT_TOKEN: token },
    identity: identityConfig(name, email),
  };
}

/**
 * The credential helper a hosted worker's git asks the gateway through
 * (hostedCredential.ts). Found from import.meta.url, which every runtime
 * has: this module also loads in the desktop app, on Electron's Node, where
 * Bun's import.meta.dir is undefined and joining it threw at start.
 */
export const HOSTED_CREDENTIAL_HELPER = join(dirname(fileURLToPath(import.meta.url)), "hostedCredential.ts");

/** `text` as one word of a shell command. */
function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The context of a hosted worker whose service has a GitHub App
 * (docs/hosted-tenant-isolation.md "Step 3"): no token is in it. Git runs
 * the helper when GitHub asks who is calling and tells it the repository
 * (`useHttpPath`), and the helper asks the gateway for that repository's
 * token — an hour's, for it alone. The account authors the commits.
 */
export function brokeredContext(name: string, email: string): GitContext {
  const base = webBase();
  return {
    config: [
      ...httpsRewrites(base, GITHUB_HOST),
      "-c", `credential.${base}.helper=`,
      "-c", `credential.${base}.helper=!${shellWord(process.execPath)} ${shellWord(HOSTED_CREDENTIAL_HELPER)}`,
      "-c", `credential.${base}.useHttpPath=true`,
    ],
    env: {},
    identity: identityConfig(name, email),
  };
}

/**
 * Whether failing output is a credential problem rather than a repository
 * one — including GitHub's "not found" for a private repo the caller cannot
 * see. Such failures are reported with the sign-in hint instead of git's
 * plumbing message. The bare `HTTP 4xx` forms are how the bundled engine
 * reports the same three answers, which it gets from the transport rather
 * than from a git binary's stderr.
 */
export function isAuthFailure(output: string): boolean {
  return /could not read username|authentication failed|terminal prompts disabled|invalid username or password|403 forbidden|401 unauthorized|repository not found|http (401|403|404) /i.test(
    output,
  );
}

/**
 * The error a failed clone surfaces as, on every engine: git's own output,
 * or the sign-in hint when that output is a credential problem.
 */
export function cloneFailure(url: string, res: RunResult): Error {
  const output = res.stderr + res.stdout;
  return new Error(
    `Could not clone ${url}: ${isAuthFailure(output) ? signInHint() : output.trim()}`,
  );
}

/** The default `git clone`, reused by gh.ts for anything gh cannot clone. */
export async function gitClone(git: GitRun, url: string, dir: string): Promise<void> {
  const res = await git(null, "clone", url, dir);
  if (res.exitCode !== 0) throw cloneFailure(url, res);
}

/**
 * The limits on a git command that talks to the remote (specs: git
 * operations, "a git command that hangs is stopped"). A remote that never
 * answers would otherwise hold the folder's git lock, and every save behind
 * it, for as long as the connection stays open.
 */
export interface GitTimeouts {
  /**
   * How long fetch, pull, push and clone may go without reporting progress.
   * They are run with `--progress`, so one that is moving data keeps
   * writing; one that has written nothing for this long has a remote that
   * stopped answering. Also the whole limit of the commands that say
   * nothing until they end: ls-remote, `gh api`, `gh auth status`.
   */
  quietMs: number;
  /** How long fetch, pull, push and clone may run in all, however busy. */
  totalMs: number;
  /**
   * After a remote command on a folder was stopped, how long that folder's
   * pushes are not tried — they would only wait out the same limit — and
   * how long gh's stand-in answers stand before gh is asked again.
   */
  retryMs: number;
}

// The quiet limit stays under the web server's 60-second idle timeout
// (src/index.ts), so a Sync button waiting on a remote that does not answer
// hears that the pull was stopped instead of losing the connection first.
const DEFAULT_TIMEOUTS: GitTimeouts = { quietMs: 50_000, totalMs: 30 * 60_000, retryMs: 60_000 };
let timeouts: GitTimeouts = DEFAULT_TIMEOUTS;

/** Change some of the limits; null puts the defaults back. Returns the previous ones. For tests. */
export function setGitTimeouts(next: Partial<GitTimeouts> | null): GitTimeouts {
  const previous = timeouts;
  timeouts = next ? { ...DEFAULT_TIMEOUTS, ...next } : DEFAULT_TIMEOUTS;
  return previous;
}

export function gitTimeouts(): GitTimeouts {
  return timeouts;
}

/** The verbs that move data and report it as they go. */
const PROGRESS_VERBS = new Set(["fetch", "pull", "push", "clone"]);

// A fetch of fewer than a hundred objects is unpacked one object at a time,
// and reports each only when it is whole — a single large file arrives in
// silence, which would read as a remote that stopped answering. Kept as a
// pack, what arrives is reported by its size, about once a second, however
// few objects it holds (as a clone always is).
const RECEIVE_REPORTS = ["-c", "fetch.unpackLimit=1"];

/**
 * The limits for a git command by its verb; none for one that stays on this
 * computer.
 */
export function limitsFor(verb: string | undefined): Pick<RunOptions, "quietMs" | "timeoutMs"> {
  if (verb !== undefined && PROGRESS_VERBS.has(verb)) return { quietMs: timeouts.quietMs, timeoutMs: timeouts.totalMs };
  return verb === "ls-remote" ? { timeoutMs: timeouts.quietMs } : {};
}

// What `--progress` adds to stderr, in the forms git writes it: a counter
// ("Receiving objects:  45% (9/20), 1.2 MiB | 300 KiB/s", "remote:
// Enumerating objects: 5, done."), and the two summary lines of a pack.
const PROGRESS_LINE =
  /^(remote: )?(.+: +\d+% \(\d+\/\d+\)|[^:]+: \d+, done\.|Total \d+ \(delta \d+\)|Delta compression using )/;

/**
 * A command's stderr as it reads without `--progress`: what a failed pull or
 * push says is shown to the user, and the progress it reported on the way
 * is not part of that. A counter rewrites its own line with carriage
 * returns, so only what a terminal would be left showing is looked at.
 */
export function withoutProgress(stderr: string): string {
  const kept: string[] = [];
  for (const line of stderr.split("\n")) {
    const shown = line.slice(line.lastIndexOf("\r") + 1).replace(/\x1b\[K/g, "");
    if (shown.trim() === "" ? line.includes("\r") : PROGRESS_LINE.test(shown.trimEnd())) continue;
    kept.push(shown === line ? line : shown.trimEnd());
  }
  return kept.join("\n");
}

/**
 * A command's stderr without what ssh adds to it on a machine whose ssh
 * config has `VisualHostKey yes`: the "Host key fingerprint is …" line and
 * the 17×9 box of ASCII art under it, which a failed push would otherwise
 * show the user as part of git's reason.
 */
export function withoutHostKeyArt(stderr: string): string {
  if (!stderr.includes("Host key fingerprint is")) return stderr;
  const kept: string[] = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trimEnd();
    if (/^Host key fingerprint is /.test(trimmed)) continue;
    // The box: a border `+---[ECDSA 256]---+` or `+----[SHA256]-----+`, and
    // rows `|  .o=X*+ .o.=   |` — 19 characters each.
    if (trimmed.length === 19 && /^\+[-[\]A-Za-z0-9 ]{17}\+$|^\|.{17}\|$/.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/** A remote command that was stopped at a limit: when, and what it then said. */
export interface RemoteStop {
  at: number;
  message: string;
}

// Each folder's remote command that was last stopped at a limit, while no
// remote command on the folder has ended by itself since: the remote is not
// answering, as far as this app knows.
const stops = new Map<string, RemoteStop>();

/** The stop that says a folder's remote is not answering; null once a remote command has ended by itself. */
export function remoteStop(repoDir: string): RemoteStop | null {
  return stops.get(resolve(repoDir)) ?? null;
}

/** Keep a folder's stop in step with how one of its remote commands ended. */
function noteRemote(repoDir: string, res: RunResult): RunResult {
  const key = resolve(repoDir);
  if (res.timedOut) stops.set(key, { at: Date.now(), message: (res.stderr + res.stdout).trim() });
  else stops.delete(key);
  return res;
}

/**
 * What every git command of a hosted worker runs with, ahead of anything
 * the repository's own config says (specs/app/hosted-app.feature.md "A
 * repository's contents cannot make a hosted worker run code"). The person
 * controls the repository's contents, and several people's workers share
 * the container, so:
 *
 *   - no hook and no file-system monitor command runs, whatever a write
 *     into `.git` left there;
 *   - a symlink is checked out as a plain file holding its target, so no
 *     link in the repository can point the app's reads and writes at
 *     `.git` or anywhere else (the bundled engine: js.ts);
 *   - the only transports are https, the one the gateway's token is for,
 *     and plain http, which a stand-in GitHub in development speaks; a
 *     remote url that names a command to run (`ext::`), a local path or
 *     ssh is refused.
 */
export const HOSTED_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.symlinks=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.http.allow=always",
];

/**
 * A GitRun that shells out to the git binary, with prompts disabled so a
 * command that cannot authenticate fails fast instead of hanging the server,
 * and limits on the commands that reach the remote for one that hangs
 * anyway: they report their progress, and are stopped when they have gone
 * quiet. The context is resolved per command, so a sign-in mid-session is
 * picked up by the next operation.
 *
 * A command that can make a commit, in a repository whose commits are
 * signed (signing.ts), signs it — and leaves the author to this computer's
 * git config, where the signing key is.
 *
 * Any commit may be signed, though: git signs wherever its own config says
 * so, on the list or off it. So every command that makes a commit on this
 * computer runs with what answers ssh-keygen for the key's passphrase — the
 * one kept in Settings (signingKey.ts), or "none" — instead of a prompt on
 * the terminal the app was started from, and with a time limit: a commit
 * waiting on a question nobody sees would hold the folder's every later
 * save, and a switch to another folder, behind it. A hosted worker signs
 * nothing and keeps no passphrase.
 */
export function subprocessRun(context: () => Promise<GitContext>): GitRun {
  return async (repoDir, ...args) => {
    const { config, env, identity = [] } = await context();
    const base = [...(repoDir ? ["-C", repoDir] : []), ...(isHostedMode() ? HOSTED_GIT_CONFIG : [])];
    const [verb, ...rest] = args;
    const reports = verb !== undefined && PROGRESS_VERBS.has(verb);
    const signs = repoDir !== null && makesCommit(verb) && (await signsCommitsIn(repoDir));
    const who = signs ? SIGN_CONFIG : identity;
    const guarded = repoDir !== null && maySign(verb) && !isHostedMode();
    const unlock = guarded ? await signingEnv() : {};
    const res = await run("git", [...base, ...config, ...who, ...(reports ? [...RECEIVE_REPORTS, verb, "--progress", ...rest] : args)], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, ...unlock },
      ...(guarded ? { timeoutMs: signingTimeoutMs() } : limitsFor(verb)),
      label: `git ${verb ?? ""}`.trim(),
    });
    const stderr = withoutHostKeyArt(reports && !res.timedOut ? withoutProgress(res.stderr) : res.stderr);
    return stderr === res.stderr ? res : { ...res, stderr };
  };
}

export interface BackendOptions {
  name: GitBackend["name"];
  /** How this engine carries out one git command. */
  git: GitRun;
  /** Replaces the default `git clone`; receives this engine's runner. */
  clone?(git: GitRun, url: string, dir: string): Promise<void>;
  /**
   * Whether this engine's fetch and push may run while the folder's index
   * and working tree are being changed — true of a git binary, whose
   * commands lock what they touch. The bundled engine runs in this process
   * and makes no such promise, so everything it does on a folder takes
   * turns.
   */
  remoteBesideLocal?: boolean;
  /**
   * Replaces the dry-run push writeAccess asks the remote with — for the
   * bundled engine, which has no dry run. Runs in the folder's remote turn,
   * given the remote's name and url.
   */
  checkWrite?(repoDir: string, remoteName: string, url: string): Promise<WriteAccess>;
}

/**
 * The ref a write check pushes to, dry: a new one, so the answer never
 * hangs on whether the branch is ahead, behind or diverged — only on whether
 * the remote lets this computer push at all.
 */
export const WRITE_CHECK_REF = "refs/specdriven/write-check";

// What hosts answer a push they will not take from this account, by
// transport: GitHub over ssh ("ERROR: Write access to repository not
// granted.", "Permission to o/r.git denied to u.") and over https (the same
// "Permission … denied", then a 403), GitLab ("You are not allowed to push
// code to this project."), Bitbucket and Azure DevOps (403s, "access
// denied"), a key the host does not know ("Permission denied (publickey)"),
// and the receive-pack of a local path the user cannot write.
const WRITE_DENIED =
  /write access to repository not granted|permission to \S+ denied|permission denied|access denied|not allowed to push|you are not allowed|insufficient permission|returned error: 403|403 forbidden|unable to create temporary object directory/i;

/** A remote url as the page may show it: a user name or token written into it left out. */
export function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/**
 * What a failed write check says: the remote turned the push down, or the
 * check found out nothing — a network that is down, a host that did not
 * answer and anything else that is not about access leaves the folder as it
 * was. A credential problem is a refusal too, with the sign-in hint as its
 * reason: this computer cannot push until it is fixed.
 */
export function writeRefusal(remoteUrl: string, output: string): WriteAccess {
  const said = withoutHostKeyArt(output).trim();
  if (WRITE_DENIED.test(said)) return { kind: "denied", remote: remoteUrl, reason: said };
  if (isAuthFailure(said)) return { kind: "denied", remote: remoteUrl, reason: signInHint() };
  return { kind: "unknown", reason: said || "the remote did not answer" };
}

/**
 * The workflow of every git operation, and who waits for whom on one folder
 * (git-operations.md "git operations on one folder run one at a time",
 * sync/RepoLocks.ts): what changes the index or the working tree — add,
 * commit, mv, rm, merge, checkout — takes the folder's local turn, and what
 * talks to the remote — fetch, push — takes its remote turn. A save's
 * commit therefore waits for another commit or a merge, a moment, and never
 * for the network; its push waits for the push or fetch before it.
 *
 * Neither turn is asked for by code that already holds it. The one place
 * both are held is the bundled engine's pull, which is one command.
 */
export function createGitBackend({
  name,
  git,
  clone: cloneWith,
  remoteBesideLocal = false,
  checkWrite,
}: BackendOptions): GitBackend {
  const local = localTurn;
  const remote = remoteBesideLocal ? remoteTurn : localTurn;

  /**
   * The stop that still holds a folder's pushes back: a remote command was
   * stopped at its limit not long ago, and nothing has answered since. A
   * push tried now would only wait out the same limit.
   */
  function heldBack(repoDir: string): RemoteStop | null {
    const stop = remoteStop(repoDir);
    return stop && Date.now() - stop.at < gitTimeouts().retryMs ? stop : null;
  }

  /**
   * Whether the checked-out branch tracks a remote one. Read from config
   * rather than resolved as the `@{u}` revision, which the bundled engine
   * does not implement — and config is the more direct answer to the
   * question actually being asked, which is whether an upstream is
   * *configured* to push to and pull from.
   */
  async function hasUpstream(repoDir: string): Promise<boolean> {
    const branch = await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch.exitCode !== 0) return false;
    const name = branch.stdout.trim();
    if (!name || name === "HEAD") return false; // detached, or no commit yet
    return (await git(repoDir, "config", "--get", `branch.${name}.remote`)).exitCode === 0;
  }

  /**
   * The remote the checked-out branch pushes to: its upstream's, else
   * `origin`, else the first one listed. Null when the repository has none.
   */
  async function pushRemote(repoDir: string): Promise<string | null> {
    const listed = await git(repoDir, "remote");
    if (listed.exitCode !== 0) return null;
    const remotes = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (remotes.length === 0) return null;
    const branch = await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
    const current = branch.exitCode === 0 ? branch.stdout.trim() : "";
    if (current && current !== "HEAD") {
      const tracked = (await git(repoDir, "config", "--get", `branch.${current}.remote`)).stdout.trim();
      if (remotes.includes(tracked)) return tracked;
    }
    return remotes.includes("origin") ? "origin" : remotes[0]!;
  }

  /**
   * Whether the remote takes a push from here (git-operations.md "a spec
   * folder that cannot be pushed to opens read only"), asked by pushing
   * HEAD to a ref of the app's own with `--dry-run`: git connects, the host
   * decides whether this account may push — GitHub refuses over ssh and
   * https alike before a ref is looked at — and nothing is sent. Hooks are
   * skipped: a pre-push hook runs on a dry run too, and is not asked here.
   * A folder that is not a repository of its own pushes nothing, and stays
   * as editable as it always was.
   */
  async function writeAccess(repoDir: string): Promise<WriteAccess> {
    if (!(await isRepoRoot(repoDir))) return { kind: "writable" };
    const remoteName = await pushRemote(repoDir);
    if (remoteName === null) return { kind: "no-remote" };
    const url = (await git(repoDir, "config", "--get", `remote.${remoteName}.url`)).stdout.trim() || remoteName;
    return remote(repoDir, async (): Promise<WriteAccess> => {
      const held = heldBack(repoDir);
      if (held) return { kind: "unknown", reason: held.message };
      if (checkWrite) return checkWrite(repoDir, remoteName, url);
      const shown = withoutUserinfo(url);
      const res = noteRemote(
        repoDir,
        await git(repoDir, "push", "--dry-run", "--no-verify", remoteName, `HEAD:${WRITE_CHECK_REF}`),
      );
      if (res.exitCode === 0) return { kind: "writable" };
      if (res.timedOut) return { kind: "unknown", reason: "the remote did not answer" };
      return writeRefusal(shown, res.stderr + res.stdout);
    });
  }

  /**
   * Files left conflicted by a merge — the unmerged index entries, which is
   * git's own definition of the set. `ls-files -u` prints one line per stage
   * (base, ours, theirs), so the same path arrives up to three times.
   */
  async function conflictedFiles(repoDir: string): Promise<string[]> {
    const res = await git(repoDir, "ls-files", "-u");
    if (res.exitCode !== 0) return [];
    const paths = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").slice(1).join("\t"))
      .filter(Boolean);
    return [...new Set(paths)];
  }

  /**
   * Per crud-feature.md: before saving, do a `git pull` and merge.
   * A repo with no upstream (e.g. the local-only starter setup) counts as ok.
   */
  async function pull(repoDir: string): Promise<PullResult> {
    if (!(await isRepoRoot(repoDir))) {
      return { ok: true, conflictedFiles: [], message: "not a standalone git repository; skipped pull" };
    }
    if (!(await hasUpstream(repoDir))) {
      return { ok: true, conflictedFiles: [], message: "no upstream configured; skipped pull" };
    }
    const res = remoteBesideLocal
      ? await fetchThenMerge(repoDir)
      : await local(repoDir, async () => noteRemote(repoDir, await git(repoDir, "pull", "--no-rebase")));
    if (res.exitCode === 0) {
      return { ok: true, conflictedFiles: [], message: res.stdout.trim() };
    }
    const conflicts = await conflictedFiles(repoDir);
    const output = (res.stderr + res.stdout).trim();
    return {
      ok: false,
      conflictedFiles: conflicts,
      message: conflicts.length === 0 && isAuthFailure(output) ? signInHint() : output,
    };
  }

  /**
   * `git pull --no-rebase` as the two commands it runs, so each waits only
   * for what it can collide with: the fetch for the remote, the merge of
   * what it fetched for the index. An edit saved while the fetch waits on
   * the network is committed at once, and merged with what arrives.
   */
  async function fetchThenMerge(repoDir: string): Promise<RunResult> {
    const fetched = await remote(repoDir, async () => noteRemote(repoDir, await git(repoDir, "fetch")));
    if (fetched.exitCode !== 0) return fetched;
    return local(repoDir, () => git(repoDir, "merge", "FETCH_HEAD"));
  }

  /** Content of a file on the other side of an in-progress merge (theirs). */
  async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
    const res = await git(repoDir, "show", `MERGE_HEAD:${relPath}`);
    return res.exitCode === 0 ? res.stdout : null;
  }

  /**
   * One merge stage of a conflicted file, read via its blob hash from
   * `ls-files -u` — the `:N:path` shorthand isn't in the bundled engine's
   * vocabulary, but `show <hash>` is in all three.
   */
  async function stageVersion(
    repoDir: string,
    relPath: string,
    stage: 1 | 2 | 3,
  ): Promise<string | null> {
    const res = await git(repoDir, "ls-files", "-u", "--", relPath);
    if (res.exitCode !== 0) return null;
    for (const line of res.stdout.split("\n")) {
      const m = line.match(/^\d+ ([0-9a-f]+) ([123])\t(.*)$/);
      if (m && Number(m[2]) === stage && m[3] === relPath) {
        const show = await git(repoDir, "show", m[1]!);
        return show.exitCode === 0 ? show.stdout : null;
      }
    }
    return null;
  }

  /** Paths under pathspec that differ between two commits (either direction). */
  async function diffNames(
    repoDir: string,
    from: string,
    to: string,
    pathspec: string,
  ): Promise<string[]> {
    const res = await git(repoDir, "diff", "--name-only", from, to, "--", pathspec);
    if (res.exitCode !== 0) return [];
    return res.stdout.split("\n").filter(Boolean);
  }

  /** Whether a path exists in a commit's tree. */
  async function existsIn(repoDir: string, ref: string, relPath: string): Promise<boolean> {
    return (await git(repoDir, "show", `${ref}:${relPath}`)).exitCode === 0;
  }

  /**
   * Commit, refusing to pretend. A commit that fails leaves the work
   * uncommitted, so reporting it as saved would be the worst kind of wrong
   * for an app whose promise is that specs reach the repository — the one
   * benign failure is there being nothing staged to commit.
   */
  async function commit(repoDir: string, ...args: string[]): Promise<void> {
    const res = await git(repoDir, "commit", ...args);
    if (res.exitCode === 0) return;
    const output = (res.stderr + res.stdout).trim();
    if (/nothing to commit|no changes added/i.test(output)) return;
    // A locked signing key is fixed in Settings, wherever git signs; and
    // where commits are signed the usual reason is the signature, so say
    // where git looks for the key. Either follows git's own words.
    const hint = output.includes(BUILT_IN_CANNOT_SIGN) ? null : signingHint(output, await signsCommitsIn(repoDir));
    throw new Error(`git commit failed: ${output}${hint ? ` — ${hint}` : ""}`);
  }

  async function push(repoDir: string): Promise<SyncResult> {
    if (!(await hasUpstream(repoDir))) {
      return { pushed: false, message: "no upstream configured; skipped push" };
    }
    return remote(repoDir, async () => {
      // Looked at once the turn has come: a push that waited behind the
      // command that was stopped is not tried either. The commits stay on
      // this computer, and the next sync that reaches the remote pushes them
      // (syncSavedChanges below).
      const held = heldBack(repoDir);
      if (held) return { pushed: false, failure: held.message, message: `push not tried: ${held.message}` };
      const res = noteRemote(repoDir, await git(repoDir, "push"));
      if (res.exitCode === 0) return { pushed: true, message: "pushed" };
      const output = (res.stderr + res.stdout).trim();
      const failure = isAuthFailure(output) ? signInHint() : output;
      return { pushed: false, failure, message: `push failed: ${failure}` };
    });
  }

  /**
   * A push's result under the wording of the operation it ended: what the
   * operation says when everything reached the remote, and what it got done
   * on this computer when the push did not — with the push's own reason kept,
   * in the message and as `failure`.
   */
  function pushOutcome(res: SyncResult, pushed: string, kept: string): SyncResult {
    return res.pushed ? { pushed: true, message: pushed } : { ...res, message: `${kept}; ${res.message}` };
  }

  /**
   * Mark a conflicted file resolved with the given content, complete the merge,
   * then commit and push (crud-feature.md, "Publish feature with merge
   * conflict").
   */
  async function resolveConflict(
    repoDir: string,
    relPath: string,
    content: string,
    alsoAdd: string[] = [],
  ): Promise<SyncResult> {
    const remaining = await local(repoDir, async () => {
      await writeTextFile(`${repoDir}/${relPath}`, content);
      await git(repoDir, "add", relPath, ...alsoAdd);
      const left = await conflictedFiles(repoDir);
      if (left.length === 0) await commit(repoDir, "--no-edit");
      return left;
    });
    if (remaining.length > 0) {
      return {
        pushed: false,
        message: `conflict resolved; ${remaining.length} conflicted file(s) remain`,
      };
    }
    return pushOutcome(await push(repoDir), "conflict resolved; committed and pushed", "conflict resolved; committed");
  }

  /**
   * Per crud-feature.md ("Scenario is automatically saved locally and
   * pushed to GitHub"): after the cron git pull, commit and push any locally
   * saved scenarios so no data is lost. Skipped while a merge conflict is being
   * resolved so conflict markers are never auto-committed.
   *
   * A clean working tree is not the end of it: commits an earlier push left
   * on this computer — the user was signed out, or offline — are pushed
   * here, so they go up on the first tick that can reach the remote rather
   * than waiting for the next edit to carry them (git-operations.md "a push
   * that fails is shown, and tried again"). `status -b` says how far ahead
   * of its upstream the branch is on all three engines; the revision-walking
   * commands that would count it are not in the bundled engine's vocabulary.
   */
  async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
    if (!(await isRepoRoot(repoDir))) {
      return { pushed: false, message: "not a standalone git repository; skipped sync" };
    }
    // What there is to push, found — and committed — in one local turn: a
    // result when there is nothing, else which kind of commits wait.
    const waiting = await local(repoDir, async (): Promise<SyncResult | "earlier" | "saved"> => {
      if ((await conflictedFiles(repoDir)).length > 0) {
        return { pushed: false, message: "merge conflict in progress; skipped sync" };
      }
      const status = await git(repoDir, "status", "--porcelain", "-b");
      if (status.exitCode !== 0) return { pushed: false, message: "no saved changes" };
      // The branch line (`## main...origin/main [ahead 2]`) leads; no file's
      // status line can start with it.
      const lines = status.stdout.split("\n");
      const branch = lines.find((line) => line.startsWith("## ")) ?? "";
      const changes = lines.filter((line) => !line.startsWith("## ")).join("\n");
      if (changes.trim() === "") {
        return /\[ahead \d+/.test(branch) ? "earlier" : { pushed: false, message: "no saved changes" };
      }
      const message = await saveMessage(repoDir, changes);
      await git(repoDir, "add", "-A");
      await commit(repoDir, "-m", message);
      return "saved";
    });
    if (typeof waiting !== "string") return waiting;
    return waiting === "earlier"
      ? pushOutcome(await push(repoDir), "earlier saved changes pushed", "earlier saved changes not pushed yet")
      : pushOutcome(await push(repoDir), "saved scenarios committed and pushed", "saved scenarios committed");
  }

  /**
   * The commit message for what the working tree holds (saveSummary.ts):
   * each changed spec file read as HEAD has it and as the disk has it now,
   * for the summary to tell what changed. The save itself must never wait
   * on its own wording, so a failure here falls back to the fixed title.
   */
  async function saveMessage(repoDir: string, porcelain: string): Promise<string> {
    try {
      const files: ChangedFile[] = [];
      for (const path of await expandFolders(repoDir, pathsInStatus(porcelain))) {
        if (files.length >= SUMMARY_READ_LIMIT || !isSpecText(path)) {
          files.push({ path });
          continue;
        }
        const shown = await git(repoDir, "show", `HEAD:${path}`);
        files.push({
          path,
          before: shown.exitCode === 0 ? shown.stdout : null,
          after: await readTextFile(`${repoDir}/${path}`),
        });
      }
      const { title, body } = summarizeSavedChanges(files);
      return `${title}\n\n${body}`;
    } catch (e) {
      getLogger("git").warn(`auto-save summary failed: ${(e as Error).message}`);
      return FALLBACK_TITLE;
    }
  }

  /** git lists a whole untracked folder as one entry; its files are what changed. */
  async function expandFolders(repoDir: string, paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      if (!path.endsWith("/")) {
        out.push(path);
        continue;
      }
      const entries = await readdir(`${repoDir}/${path}`, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parent = entry.parentPath.slice(repoDir.length + 1).replace(/\/$/, "");
        out.push(parent ? `${parent}/${entry.name}` : entry.name);
      }
    }
    return out;
  }

  /**
   * Per specs/ui/folders.feature.md: moving a feature between folders is a `git
   * mv`, committed and pushed. Outside a standalone git repo the file is simply
   * renamed on disk.
   */
  async function moveAndPush(
    repoDir: string,
    fromPath: string,
    toPath: string,
    message: string,
    extraMoves: PathMove[] = [],
  ): Promise<SyncResult> {
    const moves = [{ from: fromPath, to: toPath }, ...extraMoves];
    // A doc directory can move into a folder that has never held one — its
    // destination parent (e.g. `.specdriven/automerge/specs/billing/`)
    // must exist before the rename, for git mv and plain rename alike.
    for (const m of moves) await mkdir(dirname(`${repoDir}/${m.to}`), { recursive: true });
    if (!(await isRepoRoot(repoDir))) {
      for (const m of moves) await rename(`${repoDir}/${m.from}`, `${repoDir}/${m.to}`);
      return { pushed: false, message: "renamed locally (not a git repository)" };
    }
    await local(repoDir, async () => {
      for (const m of moves) {
        const mv = await git(repoDir, "mv", m.from, m.to);
        if (mv.exitCode !== 0) {
          throw new Error(`git mv failed: ${(mv.stderr + mv.stdout).trim()}`);
        }
      }
      await commit(repoDir, "-m", message, "--", ...moves.flatMap((m) => [m.from, m.to]));
    });
    return pushOutcome(await push(repoDir), "renamed, committed and pushed", "renamed, committed");
  }

  /**
   * Per specs/ui/ui.feature.md "Feature entry menu": deleting a feature is a
   * `git rm`, committed and pushed. Outside a standalone git repo the file is
   * simply removed from disk.
   */
  async function removeAndPush(
    repoDir: string,
    paths: string | string[],
    message: string,
    alsoAdd: string[] = [],
  ): Promise<SyncResult> {
    const all = Array.isArray(paths) ? paths : [paths];
    if (!(await isRepoRoot(repoDir))) {
      for (const p of all) await rm(`${repoDir}/${p}`, { recursive: true, force: true });
      return { pushed: false, message: "deleted locally (not a git repository)" };
    }
    await local(repoDir, async () => {
      // -r for the Automerge doc directory that rides along with a feature.
      const rmRes = await git(repoDir, "rm", "-f", "-r", ...all);
      if (rmRes.exitCode !== 0) {
        throw new Error(`git rm failed: ${(rmRes.stderr + rmRes.stdout).trim()}`);
      }
      // What is kept rides the same commit — an archived page's document,
      // which must never reach a peer without the removal or the other way
      // round (specs/app/roadmap.feature.md "Archive a roadmap page").
      if (alsoAdd.length > 0) await git(repoDir, "add", ...alsoAdd);
      await commit(repoDir, "-m", message, "--", ...all, ...alsoAdd);
    });
    return pushOutcome(await push(repoDir), "deleted, committed and pushed", "deleted, committed");
  }

  /**
   * Per crud-feature.md, saving ends with "do a git commit and push".
   */
  async function commitAndPush(
    repoDir: string,
    paths: string | string[],
    message: string,
  ): Promise<SyncResult> {
    const all = Array.isArray(paths) ? paths : [paths];
    if (!(await isRepoRoot(repoDir))) {
      return { pushed: false, message: "saved locally (not a git repository)" };
    }
    await local(repoDir, async () => {
      await git(repoDir, "add", ...all);
      await commit(repoDir, "-m", message, "--", ...all);
    });
    return pushOutcome(await push(repoDir), "committed and pushed", "committed");
  }

  async function commitAllAndPublish(repoDir: string, branch: string, message: string): Promise<SyncResult> {
    const current = await local(repoDir, async () => {
      // A clone of an empty repository has no commit, and its HEAD names
      // whatever branch this git defaults to: point it at the one asked for.
      const born = (await git(repoDir, "rev-parse", "--verify", "--quiet", "HEAD")).exitCode === 0;
      if (!born) {
        const res = await git(repoDir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
        if (res.exitCode !== 0) {
          const fallback = await git(repoDir, "checkout", "-b", branch);
          if (fallback.exitCode !== 0) {
            throw new Error(`Could not start the branch ${branch}: ${(fallback.stderr + fallback.stdout).trim()}`);
          }
        }
      }
      await git(repoDir, "add", "-A");
      await commit(repoDir, "-m", message);
      return (await git(repoDir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || branch;
    });
    const res = await remote(repoDir, async () =>
      noteRemote(repoDir, await git(repoDir, "push", "-u", "origin", `${current}:refs/heads/${current}`)),
    );
    if (res.exitCode === 0) return { pushed: true, message: `committed and pushed to ${current}` };
    const output = (res.stderr + res.stdout).trim();
    const failure = isAuthFailure(output) ? signInHint() : output;
    return { pushed: false, failure, message: `committed; push failed: ${failure}` };
  }

  async function headCommit(repoDir: string): Promise<string> {
    const res = await git(repoDir, "rev-parse", "HEAD");
    if (res.exitCode !== 0) throw new Error(`Not a git repository: ${repoDir}`);
    return res.stdout.toString().trim();
  }

  /**
   * A marketplace plugin is pinned to the ref its index names
   * (specs/app/plugins.feature.md "A plugin from the marketplace is
   * installed with consent"): the remote's branches and tags are fetched,
   * then `origin/<ref>` is tried before the bare ref, so a branch follows
   * the remote rather than the local branch the clone made.
   */
  async function checkoutRef(repoDir: string, ref: string): Promise<string> {
    const fetched = await remote(repoDir, async () =>
      noteRemote(repoDir, await git(repoDir, "fetch", "origin", "--tags")),
    );
    if (fetched.exitCode !== 0) {
      const output = fetched.stderr + fetched.stdout;
      throw new Error(
        `Could not fetch ${ref}: ${isAuthFailure(output) ? signInHint() : output.trim()}`,
      );
    }
    const res = await local(repoDir, async () => {
      const tracked = await git(repoDir, "checkout", "--detach", `origin/${ref}`);
      return tracked.exitCode === 0 ? tracked : git(repoDir, "checkout", "--detach", ref);
    });
    if (res.exitCode !== 0) {
      throw new Error(`The repository has no ref "${ref}": ${(res.stderr + res.stdout).trim()}`);
    }
    return headCommit(repoDir);
  }

  return {
    name,
    clone: (url, dir) => (cloneWith ?? gitClone)(git, url, dir),
    checkoutRef,
    headCommit,
    pull,
    push,
    theirsVersion,
    conflictedFiles,
    stageVersion,
    diffNames,
    existsIn,
    resolveConflict,
    syncSavedChanges,
    moveAndPush,
    removeAndPush,
    commitAndPush,
    hasUpstream,
    writeAccess,
    commitAllAndPublish,
  };
}

export const cliBackend = createGitBackend({ name: "cli", git: subprocessRun(appContext), remoteBesideLocal: true });
