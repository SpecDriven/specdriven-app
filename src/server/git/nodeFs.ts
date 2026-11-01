// The disk, as just-git wants to see it. just-git runs against a virtual
// filesystem and ships only an in-memory one, but the app's repositories are
// ordinary directories the user can open in their own editor — so this maps
// its FileSystem interface onto node:fs/promises, one method each.
//
// Node APIs only, like every other server module: the same code runs under
// Bun and under Electron's Node runtime (specs/app/desktop-app.feature.md).

import {
  lstat as fsLstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import type { FileStat, FileSystem } from "just-git";

/** node:fs Stats in the shape just-git reads. */
function toFileStat(s: Stats): FileStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    mode: s.mode,
    size: s.size,
    mtime: s.mtime,
  };
}

/**
 * just-git writes files without creating parent directories first — that is
 * the caller's job in its interface — but it also expects a write to a path
 * whose directory it just made to work. Creating the parent on demand covers
 * both without changing the semantics of anything that already succeeds.
 */
export const nodeFileSystem: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),

  async readFileBuffer(path) {
    return new Uint8Array(await readFile(path));
  },

  async writeFile(path, content) {
    await mkdir(dirOf(path), { recursive: true });
    await writeFile(path, content);
  },

  exists: (path) => stat(path).then(() => true, () => false),

  async stat(path) {
    return toFileStat(await stat(path));
  },

  async lstat(path) {
    return toFileStat(await fsLstat(path));
  },

  async mkdir(path, options) {
    await mkdir(path, { recursive: options?.recursive ?? false });
  },

  readdir: (path) => readdir(path),

  async rm(path, options) {
    await rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false });
  },

  readlink: (path) => readlink(path),

  symlink: (target, path) => symlink(target, path),

  mv: (src, dest) => rename(src, dest),
};

/**
 * Parent directory of a path just-git built. It joins with `/`, but the
 * working directory it joins onto is the app's own and on Windows carries
 * backslashes (`C:\Users\…\repos\specs/.git/HEAD`), so the platform's
 * dirname does the splitting rather than a search for the last slash.
 */
function dirOf(path: string): string {
  return dirname(path);
}
