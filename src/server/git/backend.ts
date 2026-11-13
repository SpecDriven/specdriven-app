// Git operation surface (git-operations.md): every git operation
// the app performs, as one interface with three implementations. Two drive
// the system `git` binary and differ only in where GitHub credentials come
// from and how a GitHub repo is cloned — the app's own sign-in (cli.ts) or
// the GitHub CLI (gh.ts). The third (js.ts) needs no binary at all: it is
// git implemented in JavaScript, running in this process.

export interface PullResult {
  ok: boolean;
  conflictedFiles: string[];
  message: string;
}

export interface SyncResult {
  pushed: boolean;
  message: string;
  /**
   * Why a push that was tried did not go through — git's own words, or the
   * sign-in hint for a credential problem. Absent when nothing was pushed
   * because nothing needed to be (no changes, no upstream): the commits a
   * failed push leaves on this computer are what the app warns about
   * (git-operations.md "a push that fails is shown, and tried again").
   */
  failure?: string;
}

/** A path rename carried alongside a move (e.g. a feature's Automerge doc dir). */
export interface PathMove {
  from: string;
  to: string;
}

export interface GitBackend {
  readonly name: "cli" | "gh" | "js";
  /** Clone url into dir; throws with a user-facing message on failure. */
  clone(url: string, dir: string): Promise<void>;
  pull(repoDir: string): Promise<PullResult>;
  push(repoDir: string): Promise<SyncResult>;
  /** Content of a file on the other side of an in-progress merge. */
  theirsVersion(repoDir: string, relPath: string): Promise<string | null>;
  /** Files left conflicted by an in-progress merge. */
  conflictedFiles(repoDir: string): Promise<string[]>;
  /** One merge stage of a conflicted file: 1 = base, 2 = ours, 3 = theirs. */
  stageVersion(repoDir: string, relPath: string, stage: 1 | 2 | 3): Promise<string | null>;
  /** Paths under pathspec that differ between two commits (either direction). */
  diffNames(repoDir: string, from: string, to: string, pathspec: string): Promise<string[]>;
  /** Whether a path exists in a commit's tree. */
  existsIn(repoDir: string, ref: string, relPath: string): Promise<boolean>;
  /** Extra paths (e.g. doc chunk dirs) may be staged into the merge commit. */
  resolveConflict(
    repoDir: string,
    relPath: string,
    content: string,
    alsoAdd?: string[],
  ): Promise<SyncResult>;
  syncSavedChanges(repoDir: string): Promise<SyncResult>;
  /** Extra renames ride along in the same commit (a feature's doc dir). */
  moveAndPush(
    repoDir: string,
    fromPath: string,
    toPath: string,
    message: string,
    extraMoves?: PathMove[],
  ): Promise<SyncResult>;
  /** Extra paths (e.g. an archived page's doc dir) are staged into the same commit. */
  removeAndPush(
    repoDir: string,
    paths: string | string[],
    message: string,
    alsoAdd?: string[],
  ): Promise<SyncResult>;
  commitAndPush(repoDir: string, paths: string | string[], message: string): Promise<SyncResult>;
  hasUpstream(repoDir: string): Promise<boolean>;
  /**
   * Commit everything in the working tree and push it, setting the branch
   * to track the remote's — the first push into a repository created empty
   * on its host, where there is no branch to track yet. A clone with no
   * commit yet starts on `branch`; one that has commits pushes the branch it
   * is on. A push that fails comes back as `failure`, the commit kept.
   */
  commitAllAndPublish(repoDir: string, branch: string, message: string): Promise<SyncResult>;
  /**
   * Put a clone at a ref the remote names — a tag, a branch or a commit —
   * fetching first, so an update lands on what the remote holds now, and
   * detached, so a branch name leaves no stale local branch behind. Answers
   * the commit checked out. Throws with a user-facing message.
   */
  checkoutRef(repoDir: string, ref: string): Promise<string>;
  /** The commit HEAD is at. */
  headCommit(repoDir: string): Promise<string>;
}
