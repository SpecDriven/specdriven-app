// Engine-independent repo detection. True only when repoDir is itself the
// root of a git repo — the starter setup (a data/ folder inside the app
// repo) must not trigger pulls or commits on the containing repo as a side
// effect of saving specs. A `.git` *file* (worktree, submodule) counts as
// false; such data dirs were never supported.

import { stat } from "node:fs/promises";
import { join } from "node:path";

export async function isRepoRoot(repoDir: string): Promise<boolean> {
  try {
    return (await stat(join(repoDir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}
