// A code project read into the snapshot the module analysis works on
// (src/server/intentModules.ts; specs/app/extract-specs-from-code.feature.md):
// the files the project does not ignore, with their sizes, and the text of
// its build files. Read-only — nothing is written into the project — and
// Node APIs only: this module also runs under Electron (src/server/run.ts).

import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gitRepoFiles, walkRepoFiles } from "./codeSearch";
import { isExcludedPath, type RepoSnapshot, type SnapshotFile } from "./intentModules";

/** A project larger than this is analysed on its first files only, and the proposal says so. */
const MAX_SCAN_FILES = 50_000;
/** A build file larger than this is not read: it is not one a person wrote. */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** How deep a build file is still read. */
const MAX_MANIFEST_DEPTH = 6;
/** How many files are looked at at once. */
const STAT_BATCH = 64;

/** The build files the analysis reads, by name. */
const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "tsconfig.json",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
]);

/** Run `fn` over `items`, STAT_BATCH at a time, keeping the order. */
async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += STAT_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + STAT_BATCH).map(fn))));
  }
  return out;
}

/**
 * The project at `root` as a snapshot: the files git lists there (tracked,
 * and untracked ones its ignore rules let through) — or, without git, the
 * tree walked with the `.gitignore` files honoured — less what sits in an
 * installed, built, generated or hidden folder. A link is never followed
 * (a `specs` link into a specification folder least of all), and a
 * submodule is left out.
 */
export async function scanProject(root: string): Promise<RepoSnapshot> {
  const dir = resolve(root);
  const listed = ((await gitRepoFiles(dir)) ?? (await walkRepoFiles(dir))).filter((p) => !isExcludedPath(p));
  const truncated = listed.length > MAX_SCAN_FILES;
  const paths = truncated ? listed.slice(0, MAX_SCAN_FILES) : listed;
  const stats = await inBatches(paths, async (path): Promise<SnapshotFile | null> => {
    const info = await lstat(join(dir, path)).catch(() => null);
    return info?.isFile() ? { path, size: info.size } : null;
  });
  const files = stats.filter((f): f is SnapshotFile => f !== null);

  const wanted = files.filter(
    (f) =>
      MANIFEST_NAMES.has(f.path.slice(f.path.lastIndexOf("/") + 1)) &&
      f.size <= MAX_MANIFEST_BYTES &&
      f.path.split("/").length - 1 <= MAX_MANIFEST_DEPTH,
  );
  const manifests: Record<string, string> = {};
  await inBatches(wanted, async (f) => {
    const text = await readFile(join(dir, f.path), "utf8").catch(() => null);
    if (text !== null) manifests[f.path] = text;
  });
  return { name: basename(dir), files, manifests, ...(truncated ? { truncated: true } : {}) };
}
