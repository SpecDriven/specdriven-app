// Built-in git engine (specs/git-operations.spec.md): isomorphic-git over
// smart-HTTP, so the app needs no git installation. Runs on Node APIs plus
// the fetch-based transport in http.ts (the library's own node client
// hangs under Bun). Semantics mirror the system-git engine in cli.ts:
// same result shapes, same messages, same "not a standalone repo" and
// "no upstream" short-circuits.
//
// Two deliberate differences from CLI plumbing, both invisible to callers:
// - isomorphic-git never writes .git/MERGE_HEAD, so an in-progress merge
//   is tracked in .git/specdriven-merge.json (never committable there, and
//   it survives an app restart mid-conflict).
// - Commits need an explicit author: the signed-in GitHub identity, else
//   the repo's own user.name/user.email, else the OS account.

import { userInfo } from "node:os";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs";
import * as git from "isomorphic-git";
import { getAuth, gitOnAuth } from "../auth";
import { readTextFile, writeTextFile } from "../fsx";
import type { GitBackend, PullResult, SyncResult } from "./backend";
import { GitUnsupportedError } from "./backend";
import { gitHttp } from "./http";
import { isRepoRoot } from "./repoRoot";

const http = gitHttp;

/**
 * isomorphic-git error codes the engine itself cannot handle. Transport
 * limits count too: system git speaks ssh and dumb http, this engine
 * doesn't — a repo with such a remote belongs on system git.
 */
const UNSUPPORTED_CODES = new Set([
  "MergeNotSupportedError",
  "UnmergedPathsError",
  "InternalError",
  "MaxDepthError",
  "UnknownTransportError",
  "UrlParseError", // a local-path remote — no url scheme at all
  "SmartHttpError",
]);

function code(e: unknown): string {
  return (e as { code?: string })?.code ?? (e as Error)?.name ?? "";
}

function isAuthError(e: unknown): boolean {
  if (code(e) === "UserCanceledError") return true;
  const status = (e as { data?: { statusCode?: number } })?.data?.statusCode;
  return code(e) === "HttpError" && (status === 401 || status === 403);
}

const SIGN_IN_HINT = "authentication required — sign in with GitHub in Settings";

/** Rethrow engine-capability errors as the facade's fallback trigger. */
function rethrowUnsupported(e: unknown): never {
  if (UNSUPPORTED_CODES.has(code(e))) {
    throw new GitUnsupportedError((e as Error).message, { cause: e });
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Pending merge (the JS engine's MERGE_HEAD)

interface PendingMerge {
  theirsOid: string;
  branch: string;
  filepaths: string[];
}

function pendingPath(repoDir: string): string {
  return join(repoDir, ".git", "specdriven-merge.json");
}

export async function readPendingMerge(repoDir: string): Promise<PendingMerge | null> {
  const raw = await readTextFile(pendingPath(repoDir));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingMerge;
    return parsed && typeof parsed.theirsOid === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writePendingMerge(repoDir: string, pending: PendingMerge): Promise<void> {
  await writeTextFile(pendingPath(repoDir), JSON.stringify(pending, null, 2) + "\n");
}

async function clearPendingMerge(repoDir: string): Promise<void> {
  await rm(pendingPath(repoDir), { force: true });
}

// ---------------------------------------------------------------------------
// Identity

/**
 * Author for commits this engine writes: the signed-in GitHub account,
 * else the repo's own configured identity, else the OS account (only
 * reachable in local repos whose pushes are skipped anyway).
 */
async function commitAuthor(repoDir: string): Promise<{ name: string; email: string }> {
  const auth = await getAuth();
  if (auth) return { name: auth.name ?? auth.login, email: auth.email ?? `${auth.login}@users.noreply.github.com` };
  const name = await git.getConfig({ fs, dir: repoDir, path: "user.name" });
  const email = await git.getConfig({ fs, dir: repoDir, path: "user.email" });
  if (name && email) return { name, email };
  const os = userInfo().username;
  return { name: name ?? os, email: email ?? `${os}@localhost` };
}

// ---------------------------------------------------------------------------
// Status helpers

type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

/** Row differs between index and HEAD (something is staged). */
function stagedChange([, head, , stage]: StatusRow): boolean {
  return head === 1 ? stage !== 1 : stage !== 0;
}

/** Row is not pristine (worktree or index differs from HEAD). */
function dirty([, head, workdir, stage]: StatusRow): boolean {
  return !(head === 1 && workdir === 1 && stage === 1);
}

async function status(repoDir: string, filepaths?: string[]): Promise<StatusRow[]> {
  return (await git.statusMatrix({ fs, dir: repoDir, filepaths })) as StatusRow[];
}

/** Filepaths whose blobs differ between two commits (tree diff). */
async function changedBetween(repoDir: string, oursOid: string, theirsOid: string): Promise<Set<string>> {
  const changed = new Set<string>();
  await git.walk({
    fs,
    dir: repoDir,
    trees: [git.TREE({ ref: oursOid }), git.TREE({ ref: theirsOid })],
    map: async (filepath, entries) => {
      if (filepath === ".") return true;
      const [a, b] = entries ?? [];
      const aOid = a ? await a.oid() : undefined;
      const bOid = b ? await b.oid() : undefined;
      if (aOid === bOid) return null; // identical blob or subtree: prune
      const aType = a ? await a.type() : undefined;
      const bType = b ? await b.type() : undefined;
      if (aType === "blob" || bType === "blob") changed.add(filepath);
      return true;
    },
  });
  return changed;
}

async function currentBranch(repoDir: string): Promise<string | null> {
  const branch = await git.currentBranch({ fs, dir: repoDir, fullname: false });
  return typeof branch === "string" ? branch : null;
}

async function hasUpstream(repoDir: string): Promise<boolean> {
  try {
    const branch = await currentBranch(repoDir);
    if (!branch) return false;
    const remote = await git.getConfig({ fs, dir: repoDir, path: `branch.${branch}.remote` });
    const merge = await git.getConfig({ fs, dir: repoDir, path: `branch.${branch}.merge` });
    return Boolean(remote && merge);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Operations

async function pull(repoDir: string): Promise<PullResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "not a standalone git repository; skipped pull" };
  }
  if (!(await hasUpstream(repoDir))) {
    return { ok: true, conflictedFiles: [], message: "no upstream configured; skipped pull" };
  }
  const branch = (await currentBranch(repoDir))!;
  try {
    await git.fetch({ fs, http, dir: repoDir, onAuth: gitOnAuth() });
  } catch (e) {
    if (isAuthError(e)) return { ok: false, conflictedFiles: [], message: SIGN_IN_HINT };
    if (UNSUPPORTED_CODES.has(code(e))) rethrowUnsupported(e);
    return { ok: false, conflictedFiles: [], message: `pull failed: ${(e as Error).message}` };
  }

  let theirsOid: string;
  try {
    theirsOid = await git.resolveRef({ fs, dir: repoDir, ref: `refs/remotes/origin/${branch}` });
  } catch {
    return { ok: true, conflictedFiles: [], message: "no upstream configured; skipped pull" };
  }
  const oursOid = await git.resolveRef({ fs, dir: repoDir, ref: "HEAD" });
  if (
    theirsOid === oursOid ||
    (await git.isDescendent({ fs, dir: repoDir, oid: oursOid, ancestor: theirsOid, depth: -1 }))
  ) {
    return { ok: true, conflictedFiles: [], message: "Already up to date." };
  }

  // Mirror CLI pull's refusal to merge over uncommitted changes to files
  // the merge would rewrite — checked up front so nothing is touched.
  const dirtyFiles = (await status(repoDir)).filter(dirty).map(([filepath]) => filepath);
  if (dirtyFiles.length > 0) {
    const incoming = await changedBetween(repoDir, oursOid, theirsOid);
    const overlap = dirtyFiles.filter((f) => incoming.has(f));
    if (overlap.length > 0) {
      return {
        ok: false,
        conflictedFiles: [],
        message: `error: Your local changes to the following files would be overwritten by merge:\n  ${overlap.join("\n  ")}`,
      };
    }
  }

  const author = await commitAuthor(repoDir);
  try {
    await git.merge({
      fs,
      dir: repoDir,
      ours: branch,
      theirs: `refs/remotes/origin/${branch}`,
      abortOnConflict: false,
      author,
      committer: author,
    });
  } catch (e) {
    if (code(e) === "MergeConflictError") {
      const data = (e as { data?: { filepaths?: string[] } }).data;
      const filepaths = data?.filepaths ?? [];
      await writePendingMerge(repoDir, { theirsOid, branch, filepaths });
      return {
        ok: false,
        conflictedFiles: filepaths,
        message: `Merge conflict in ${filepaths.join(", ")}`,
      };
    }
    rethrowUnsupported(e);
  }

  // A successful merge moves the branch ref but not the worktree — check
  // out the merged tree. The overlap guard above makes this conflict-free.
  try {
    await git.checkout({ fs, dir: repoDir, ref: branch });
  } catch (e) {
    // Roll the branch back so the repo is exactly as before the pull.
    await git.writeRef({
      fs,
      dir: repoDir,
      ref: `refs/heads/${branch}`,
      value: oursOid,
      force: true,
    });
    return { ok: false, conflictedFiles: [], message: `pull failed: ${(e as Error).message}` };
  }
  return { ok: true, conflictedFiles: [], message: `Merged origin/${branch}` };
}

async function theirsVersion(repoDir: string, relPath: string): Promise<string | null> {
  const pending = await readPendingMerge(repoDir);
  if (!pending) return null;
  try {
    const { blob } = await git.readBlob({
      fs,
      dir: repoDir,
      oid: pending.theirsOid,
      filepath: relPath,
    });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

async function push(repoDir: string): Promise<SyncResult> {
  if (!(await hasUpstream(repoDir))) {
    return { pushed: false, message: "no upstream configured; skipped push" };
  }
  try {
    const res = await git.push({ fs, http, dir: repoDir, onAuth: gitOnAuth() });
    if (res.ok) return { pushed: true, message: "pushed" };
    return { pushed: false, message: `push failed: ${res.error ?? "rejected"}` };
  } catch (e) {
    if (isAuthError(e)) return { pushed: false, message: `push failed: ${SIGN_IN_HINT}` };
    if (UNSUPPORTED_CODES.has(code(e))) rethrowUnsupported(e);
    return { pushed: false, message: `push failed: ${(e as Error).message}` };
  }
}

/** Stage worktree state for the given rows: adds and removals. */
async function stageRows(repoDir: string, rows: StatusRow[]): Promise<void> {
  for (const [filepath, head, workdir] of rows) {
    if (workdir === 0 && head === 1) {
      await git.remove({ fs, dir: repoDir, filepath });
    } else if (workdir === 2) {
      await git.add({ fs, dir: repoDir, filepath });
    }
  }
}

async function commitStaged(repoDir: string, message: string, parent?: string[]): Promise<void> {
  const author = await commitAuthor(repoDir);
  await git.commit({ fs, dir: repoDir, message, author, committer: author, parent });
}

async function resolveConflict(
  repoDir: string,
  relPath: string,
  content: string,
): Promise<SyncResult> {
  await writeTextFile(`${repoDir}/${relPath}`, content);
  await git.add({ fs, dir: repoDir, filepath: relPath });
  const pending = await readPendingMerge(repoDir);
  if (!pending) {
    // No merge in progress (defensive): behave like a plain save.
    await commitStaged(repoDir, `Resolve conflict: ${relPath}`);
    const res = await push(repoDir);
    return {
      pushed: res.pushed,
      message: res.pushed ? "conflict resolved; committed and pushed" : `conflict resolved; committed; ${res.message}`,
    };
  }
  const remaining = pending.filepaths.filter((f) => f !== relPath);
  if (remaining.length > 0) {
    await writePendingMerge(repoDir, { ...pending, filepaths: remaining });
    return {
      pushed: false,
      message: `conflict resolved; ${remaining.length} conflicted file(s) remain`,
    };
  }
  const oursOid = await git.resolveRef({ fs, dir: repoDir, ref: "HEAD" });
  await commitStaged(repoDir, `Merge remote-tracking branch 'origin/${pending.branch}'`, [
    oursOid,
    pending.theirsOid,
  ]);
  await clearPendingMerge(repoDir);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "conflict resolved; committed and pushed" : `conflict resolved; committed; ${res.message}`,
  };
}

async function syncSavedChanges(repoDir: string): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { pushed: false, message: "not a standalone git repository; skipped sync" };
  }
  if (await readPendingMerge(repoDir)) {
    return { pushed: false, message: "merge conflict in progress; skipped sync" };
  }
  try {
    const rows = (await status(repoDir)).filter(dirty);
    if (rows.length === 0) {
      return { pushed: false, message: "no saved changes" };
    }
    await stageRows(repoDir, rows);
    await commitStaged(repoDir, "Auto-save scenarios");
  } catch (e) {
    rethrowUnsupported(e);
  }
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed
      ? "saved scenarios committed and pushed"
      : `saved scenarios committed; ${res.message}`,
  };
}

async function moveAndPush(
  repoDir: string,
  fromPath: string,
  toPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    await rename(`${repoDir}/${fromPath}`, `${repoDir}/${toPath}`);
    return { pushed: false, message: "renamed locally (not a git repository)" };
  }
  try {
    await rename(`${repoDir}/${fromPath}`, `${repoDir}/${toPath}`);
  } catch (e) {
    throw new Error(`git mv failed: ${(e as Error).message}`);
  }
  await git.remove({ fs, dir: repoDir, filepath: fromPath });
  await git.add({ fs, dir: repoDir, filepath: toPath });
  await commitStaged(repoDir, message);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "renamed, committed and pushed" : `renamed, committed; ${res.message}`,
  };
}

async function removeAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    await rm(`${repoDir}/${relPath}`);
    return { pushed: false, message: "deleted locally (not a git repository)" };
  }
  try {
    await rm(`${repoDir}/${relPath}`);
  } catch (e) {
    throw new Error(`git rm failed: ${(e as Error).message}`);
  }
  await git.remove({ fs, dir: repoDir, filepath: relPath });
  await commitStaged(repoDir, message);
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "deleted, committed and pushed" : `deleted, committed; ${res.message}`,
  };
}

async function commitAndPush(
  repoDir: string,
  relPath: string,
  message: string,
): Promise<SyncResult> {
  if (!(await isRepoRoot(repoDir))) {
    return { pushed: false, message: "saved locally (not a git repository)" };
  }
  try {
    await git.add({ fs, dir: repoDir, filepath: relPath });
    // CLI `git commit` refuses empty commits; skip the commit when the
    // file matches HEAD so a republish-without-changes stays a no-op.
    const rows = await status(repoDir, [relPath]);
    if (rows.some(stagedChange)) await commitStaged(repoDir, message);
  } catch (e) {
    rethrowUnsupported(e);
  }
  const res = await push(repoDir);
  return {
    pushed: res.pushed,
    message: res.pushed ? "committed and pushed" : `committed; ${res.message}`,
  };
}

async function clone(url: string, dir: string): Promise<void> {
  // CLI git refuses to clone into a non-empty directory and removes the
  // target on failure; mirror both so a failed probe leaves nothing behind.
  let existedBefore = false;
  try {
    existedBefore = (await stat(dir)).isDirectory() && (await readdir(dir)).length > 0;
  } catch {
    existedBefore = false;
  }
  if (existedBefore) {
    throw new Error(`Could not clone ${url}: destination path already exists and is not an empty directory`);
  }
  try {
    await git.clone({ fs, http, dir, url, onAuth: gitOnAuth() });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (isAuthError(e)) {
      throw new Error(`Could not clone ${url}: ${SIGN_IN_HINT}`);
    }
    if (UNSUPPORTED_CODES.has(code(e))) rethrowUnsupported(e);
    throw new Error(`Could not clone ${url}: ${(e as Error).message}`);
  }
}

/**
 * One-time migration for clones made in the old scheme era: an ssh-form
 * github.com origin is rewritten to https so both engines can talk to it.
 * Only the app's own clones are migrated (see repo.ts); user-provided
 * local repos keep their remotes and reach system git via fallback.
 */
export async function rewriteSshOrigin(repoDir: string): Promise<void> {
  try {
    const url = await git.getConfig({ fs, dir: repoDir, path: "remote.origin.url" });
    if (typeof url !== "string") return;
    const m = url.match(
      /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    );
    if (!m) return;
    await git.setConfig({
      fs,
      dir: repoDir,
      path: "remote.origin.url",
      value: `https://github.com/${m[1]}/${m[2]}.git`,
    });
  } catch {
    // leave the remote as it is — fallback covers unreadable configs
  }
}

export const jsBackend: GitBackend = {
  name: "js",
  clone,
  pull,
  push,
  theirsVersion,
  resolveConflict,
  syncSavedChanges,
  moveAndPush,
  removeAndPush,
  commitAndPush,
  hasUpstream,
  mergeInProgress: async (repoDir) => (await readPendingMerge(repoDir)) !== null,
};
