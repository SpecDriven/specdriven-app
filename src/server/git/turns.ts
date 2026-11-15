// A folder's two turns, for the Promise code of the git engines
// (sync/RepoLocks.ts has the rules, cli.ts createGitBackend says which
// command takes which).

import { promised, run } from "../effect/runtime";
import { RepoLocks } from "../sync/RepoLocks";

/** Run work that changes a folder's index or working tree while no other such work runs on it. */
export function localTurn<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  return run(RepoLocks.use((locks) => locks.withIndex(repoDir, promised(work))));
}

/** Run work that talks to a folder's remote while no other such work runs on it. */
export function remoteTurn<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  return run(RepoLocks.use((locks) => locks.withRemote(repoDir, promised(work))));
}
