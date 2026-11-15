// What a hosted worker does for itself as it starts, before it reads its
// settings (src/index.ts; specs/app/hosted-app.feature.md "The gateway never
// writes inside a person's folder"). The gateway used to do the first two as
// root, inside a folder the worker can rearrange — and root follows a link
// wherever it leads. As the worker's own uid they can reach nothing the
// worker could not reach anyway.
//
//   - the account as git's default author, in ~/.gitconfig: the GitHub
//     identity the app passes with each command (src/server/git) wins when
//     there is a token, and without one commits are still attributed;
//   - the remembered repos, into a settings file that is missing
//     (repos.ts): after a redeploy that lost the volume the person's repo
//     opens again instead of the app asking for its url;
//   - no symlink left in a cloned repository. Hosted git checks a link out
//     as a plain file (src/server/git/cli.ts HOSTED_GIT_CONFIG), but a clone
//     from before that rule still holds real ones, and a link in a data repo
//     is a way to point the app's own reads and writes somewhere else.

import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanRepos, HOSTED_REPOS_ENV, seedWorkerRepos } from "./repos";

type Env = Record<string, string | undefined>;

export async function prepareHostedWorker(env: Env = process.env): Promise<void> {
  const email = env.SPECDRIVEN_ACCOUNT_EMAIL?.trim();
  if (email && env.HOME) await writeGitIdentity(env.HOME, email);
  if (env.SPECDRIVEN_ROOT) await seedWorkerRepos(env.SPECDRIVEN_ROOT, rememberedRepos(env[HOSTED_REPOS_ENV]));
  if (env.SPECDRIVEN_REPOS_DIR) {
    const replaced = await replaceSymlinks(env.SPECDRIVEN_REPOS_DIR);
    if (replaced) console.log(`replaced ${replaced} symlinks in the cloned repositories with plain files`);
  }
}

/** The gateway's list as it arrives in the environment; anything else is no list. */
function rememberedRepos(value: string | undefined): string[] {
  try {
    return cleanRepos(JSON.parse(value ?? "[]"));
  } catch {
    return [];
  }
}

/** ~/.gitconfig naming the account; one that is not a plain file is replaced, never followed. */
async function writeGitIdentity(home: string, email: string): Promise<void> {
  const path = join(home, ".gitconfig");
  const there = await lstat(path).catch(() => null);
  if (there && !there.isFile()) await rm(path, { recursive: true, force: true });
  // A git config value ends at the line's end, and `"` and `\` are its escapes.
  const value = email.replace(/[\r\n"\\]/g, "");
  await writeFile(path, `[user]\n\tname = ${value}\n\temail = ${value}\n`, { mode: 0o600 });
}

/**
 * Replace every symlink in the working trees under `dir` with what git
 * itself writes for one when `core.symlinks` is false: a plain file holding
 * the link's target. To git the file is that same link, unchanged. `.git`
 * folders are git's own and are left alone. The number replaced.
 */
export async function replaceSymlinks(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let replaced = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      await rm(path);
      await writeFile(path, target, { flag: "wx" });
      replaced++;
    } else if (entry.isDirectory() && entry.name !== ".git") {
      replaced += await replaceSymlinks(path);
    }
  }
  return replaced;
}
