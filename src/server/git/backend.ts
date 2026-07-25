// Git operation surface (specs/git-operations.spec.md): every git operation
// the app performs, as one interface with two implementations. Both drive the
// system `git` binary; they differ only in where GitHub credentials come from
// and how a GitHub repo is cloned — the app's own sign-in (cli.ts) or the
// GitHub CLI (gh.ts).

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
  readonly name: "cli" | "gh";
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
}
