// A repository's `origin` remote, read from its git config on disk — no git
// binary, so it costs a file read and works on every engine. Its own module
// so the engines (cli.ts, for the signed-commit list in signing.ts) can ask
// without importing the Issues code that asks too.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * The url of a repo's `origin` remote, from its git config on disk — or
 * null when the folder is no git repo or has no origin. A worktree's `.git`
 * is a file pointing at its private git dir, whose `commondir` names the
 * shared one where the config (and the remotes) live.
 */
export async function originUrl(dir: string): Promise<string | null> {
  const dotGit = resolve(dir, ".git");
  let gitDir: string;
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m);
      if (!pointer) return null;
      const target = pointer[1]!;
      gitDir = isAbsolute(target) ? target : resolve(dir, target);
    }
  } catch {
    return null;
  }
  let commonDir = gitDir;
  try {
    const common = (await readFile(resolve(gitDir, "commondir"), "utf8")).trim();
    if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // No commondir: a plain repository, whose config lives in gitDir itself.
  }
  let config: string;
  try {
    config = await readFile(resolve(commonDir, "config"), "utf8");
  } catch {
    return null;
  }
  return parseOriginUrl(config);
}

/** The `url` of the `[remote "origin"]` section of a git config, or null. */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return null;
}

