// Git engine strategy (specs/git-operations.spec.md): every git operation
// the app performs, as one interface with two implementations — the
// bundled JavaScript engine (js.ts, isomorphic-git) and the system git
// binary (cli.ts, subprocess). The facade in index.ts picks the engine and
// falls back from js to cli when the JS engine cannot handle an operation.

export interface PullResult {
  ok: boolean;
  conflictedFiles: string[];
  message: string;
}

export interface SyncResult {
  pushed: boolean;
  message: string;
}

export interface GitBackend {
  readonly name: "js" | "cli";
  /** Clone url into dir; throws with a user-facing message on failure. */
  clone(url: string, dir: string): Promise<void>;
  pull(repoDir: string): Promise<PullResult>;
  push(repoDir: string): Promise<SyncResult>;
  /** Content of a file on the other side of an in-progress merge. */
  theirsVersion(repoDir: string, relPath: string): Promise<string | null>;
  resolveConflict(repoDir: string, relPath: string, content: string): Promise<SyncResult>;
  syncSavedChanges(repoDir: string): Promise<SyncResult>;
  moveAndPush(repoDir: string, fromPath: string, toPath: string, message: string): Promise<SyncResult>;
  removeAndPush(repoDir: string, relPath: string, message: string): Promise<SyncResult>;
  commitAndPush(repoDir: string, relPath: string, message: string): Promise<SyncResult>;
  hasUpstream(repoDir: string): Promise<boolean>;
  /** True while this engine has an unfinished merge in repoDir. */
  mergeInProgress(repoDir: string): Promise<boolean>;
}

/**
 * Thrown by an engine when the engine itself — not the repository state —
 * cannot perform the operation. The facade retries such operations on the
 * system git engine. Domain outcomes (merge conflicts, auth failures, no
 * upstream) are results, never this error: the other engine would fail the
 * same way.
 */
export class GitUnsupportedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitUnsupportedError";
  }
}
