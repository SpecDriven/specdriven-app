// One-shot moves that bring an older data repo up to today's layout, run on
// the sync tick before anything reads the tree. Two of them, in this order:
//
// 1. migrateToSpecsFolder — features under `specs/` (src/server/walk.ts).
//    Repos written before the spec tree got its own folder keep `.feature.md`
//    files at the root and in arbitrary subfolders, sitting beside the
//    reserved `roadmap/` and `tasks/` and the folders plugins own (the
//    Event Models' `models/`). Only `specs/` is scanned now, so such a repo
//    would open empty. The `.feature.md` files and their Automerge doc
//    directories move together, or the repo is left inconsistent — the
//    documents are the system of record, so a feature that loses its
//    document loses every scenario id, every draft-only scenario and its
//    whole merge history — in one commit, as renames, so the history
//    follows the files. A plugin whose files name features (an Event
//    Model's slices link the spec they generated) is told of the moves and
//    rewrites its own files, which ride the tick's next commit.
//
// 2. migrateAutomergeLayout — the store's mirrored layout
//    (specs/datastore/automerge-store.feature.md "Storage layout"). The
//    store used to file documents under a per-kind root — `features/`,
//    `docs/`, `models/`, `testing/` — with the source file's full path
//    beneath it, which doubled every folder name (`features/specs/...`,
//    `models/models/...`). Now a document's directory is its source path
//    with the top folder mapped (src/server/automerge/store.ts docDirRel),
//    and this pass lifts what an older app version filed under the old
//    roots into place: every document directory, identity file included, so
//    nothing about a document changes but where it sits. Step 1 still works
//    on the old `features/` root on purpose — a repo that predates both
//    layouts is moved forward one step at a time, and this pass takes it the
//    rest of the way in the same tick.

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import {
  AUTOMERGE_ROOT,
  LEGACY_KIND_ROOTS,
  TESTING_DOC_NAME,
  docDirRel,
  fileDocDirRel,
  pageDocDirRel,
  testingDocDirRel,
  type LegacyKindRoot,
} from "./automerge/store";
import { directoryExists, fileExists } from "./fsx";
import { commitAndPush, moveAndPush } from "./git";
import type { PathMove } from "./git/backend";
import { isPageFolderPath } from "./pages";
import { getLogger, withSpan } from "./telemetry";
import { SPECS_FOLDER, isFeatureFile, isSpecsFolderPath } from "./walk";

const log = getLogger("migrate");

/**
 * Where a feature's Automerge document lived before the store mirrored the
 * repo's folders — the old `features/` root. The specs-folder migration still
 * addresses documents there: a repo that needs it predates the mirrored
 * layout too, and migrateAutomergeLayout lifts the result right after.
 */
function legacyFeatureDocDir(fileName: string): string {
  return `${AUTOMERGE_ROOT}/features/${fileName}`;
}

/**
 * What the specs-folder migration asks of the plugins (src/plugins/host/
 * services.ts SyncHooks): the top-level folders they own, left alone, and
 * a hook told of the features that moved — the Event Models plugin
 * rewrites the slice links that name them.
 */
export interface MigrationHooks {
  reserved?: readonly string[];
  moved?: (dataDir: string, moved: ReadonlyMap<string, string>) => Promise<unknown>;
}

/**
 * Feature files outside the spec tree, repo-relative. The reserved folders are
 * skipped: a `.feature.md` under `roadmap/` or a plugin's folder is somebody's
 * page or export, not a spec that belongs in the tree.
 */
async function strayFeatures(dataDir: string, reserved: readonly string[], rel = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(rel ? `${dataDir}/${rel}` : dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (isSpecsFolderPath(path) || isPageFolderPath(path) || reserved.includes(path)) continue;
    if (entry.isDirectory()) out.push(...(await strayFeatures(dataDir, reserved, path)));
    else if (isFeatureFile(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Move any features outside `specs/` into it, with their documents, in one
 * commit, and tell the plugins where each went. A no-op — and silent — for a
 * repo that is already migrated, which is every tick after the first.
 *
 * Returns how many features moved.
 */
export async function migrateToSpecsFolder(dataDir: string, hooks: MigrationHooks = {}): Promise<number> {
  const stray = await strayFeatures(dataDir, hooks.reserved ?? []);
  if (stray.length === 0) return 0;
  return withSpan(
    "migrate.specs_folder",
    { "specdriven.dir": dataDir, "migrate.features": stray.length },
    async () => {
      const moves: PathMove[] = [];
      const moved = new Map<string, string>();
      for (const from of stray) {
        const to = `${SPECS_FOLDER}/${from}`;
        // A name already taken in the tree is left where it is rather than
        // overwriting a spec that is already there; the next tick retries.
        if (await fileExists(`${dataDir}/${to}`)) {
          log.warn(`left ${from} in place — ${to} already exists`);
          continue;
        }
        moves.push({ from, to });
        moved.set(from, to);
        if (await fileExists(`${dataDir}/${legacyFeatureDocDir(from)}/docid`)) {
          moves.push({ from: legacyFeatureDocDir(from), to: legacyFeatureDocDir(to) });
        }
      }
      if (moves.length === 0) return 0;
      // moveAndPush takes the first move as its subject and commits the rest
      // alongside it, so the whole migration is one commit of renames.
      const [first, ...rest] = moves;
      const sync = await moveAndPush(
        dataDir,
        first!.from,
        first!.to,
        `Move features under ${SPECS_FOLDER}/`,
        rest,
      );
      // What the plugins rewrite in their own files is a content change, not
      // a rename, so it rides the sync tick's own commit rather than this one.
      await hooks.moved?.(dataDir, moved);
      log.info(`moved ${moved.size} feature(s) under ${SPECS_FOLDER}/`, {
        "git.pushed": sync.pushed,
      });
      return moved.size;
    },
  );
}

/** A document directory: `docid` or at least one chunk file sits in it. */
function isDocEntry(name: string): boolean {
  return name === "docid" || ((name.startsWith("snapshot-") || name.startsWith("changes-")) && name.endsWith(".bin"));
}

/**
 * Every document directory under one of the old per-kind roots, as
 * repo-relative paths, with the file name the document was filed under.
 */
async function legacyDocDirs(dataDir: string, root: string, rel = ""): Promise<{ dir: string; fileName: string }[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(rel ? `${dataDir}/${root}/${rel}` : `${dataDir}/${root}`, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.isFile() && isDocEntry(e.name))) {
    return rel ? [{ dir: `${root}/${rel}`, fileName: rel }] : [];
  }
  const out: { dir: string; fileName: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push(...(await legacyDocDirs(dataDir, root, rel ? `${rel}/${entry.name}` : entry.name)));
  }
  return out;
}

/** Where a document filed under an old root belongs now; null for one to leave alone. */
function mirroredDocDir(kind: LegacyKindRoot, fileName: string): string | null {
  switch (kind) {
    case "features":
      // A feature outside `specs/` is migrateToSpecsFolder's to move first.
      return isSpecsFolderPath(fileName) ? docDirRel(fileName) : null;
    case "docs":
      return pageDocDirRel(fileName);
    case "models":
      // The Event Model documents, which the Models plugin keeps now.
      return fileName.startsWith("models/") ? fileDocDirRel(fileName) : null;
    case "testing":
      return fileName === TESTING_DOC_NAME ? testingDocDirRel() : null;
  }
}

/** True when nothing but directories is left beneath the path. */
async function hasNoFiles(path: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!(await hasNoFiles(`${path}/${entry.name}`))) return false;
  }
  return true;
}

/**
 * Lift every document an older app version filed under the store's old
 * per-kind roots into the mirrored layout, in one commit. A no-op — and
 * silent — for a repo that is already there, which is every tick after the
 * first; a later push from a peer still on the old layout is lifted the same
 * way on the tick that pulls it.
 *
 * A document whose new directory already exists (that peer's case, or two
 * clones migrating concurrently) is merged into it file by file: chunk names
 * are content hashes, so a name already there is the same bytes and the old
 * copy is simply dropped, and a second `docid` is dropped too — loading
 * merges every chunk of both lineages and Automerge picks the winner the
 * same way on every peer, so the identity file that stays is as good as the
 * one that goes.
 *
 * The moves are plain renames committed as a unit rather than `git mv`
 * calls: chunks the sync tick has not committed yet are untracked, and a
 * `git mv` of an untracked file fails. Git records the renames just the same,
 * since the bytes do not change.
 *
 * Returns how many documents moved.
 */
export async function migrateAutomergeLayout(dataDir: string): Promise<number> {
  const present: LegacyKindRoot[] = [];
  for (const kind of LEGACY_KIND_ROOTS) {
    if (await directoryExists(`${dataDir}/${AUTOMERGE_ROOT}/${kind}`)) present.push(kind);
  }
  if (present.length === 0) return 0;
  return withSpan("migrate.automerge_layout", { "specdriven.dir": dataDir }, async (span) => {
    let moved = 0;
    let merged = 0;
    for (const kind of present) {
      for (const { dir, fileName } of await legacyDocDirs(dataDir, `${AUTOMERGE_ROOT}/${kind}`)) {
        const to = mirroredDocDir(kind, fileName);
        if (to === null) {
          log.warn(`left ${dir} where it is — no place for it in the mirrored layout`);
          continue;
        }
        const fromAbs = `${dataDir}/${dir}`;
        const toAbs = `${dataDir}/${to}`;
        if (!(await directoryExists(toAbs))) {
          await mkdir(dirname(toAbs), { recursive: true });
          await rename(fromAbs, toAbs);
          moved++;
          continue;
        }
        for (const entry of await readdir(fromAbs, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (await fileExists(`${toAbs}/${entry.name}`)) await rm(`${fromAbs}/${entry.name}`);
          else await rename(`${fromAbs}/${entry.name}`, `${toAbs}/${entry.name}`);
        }
        merged++;
      }
    }
    // The old roots are not the store's any more: gone once nothing is left
    // in them but the empty directories git never tracked anyway.
    for (const kind of present) {
      const root = `${dataDir}/${AUTOMERGE_ROOT}/${kind}`;
      if (await hasNoFiles(root)) await rm(root, { recursive: true, force: true });
    }
    span.setAttributes({ "migrate.docs_moved": moved, "migrate.docs_merged": merged });
    if (moved + merged === 0) return 0;
    const sync = await commitAndPush(dataDir, AUTOMERGE_ROOT, "Move Automerge documents to the mirrored layout");
    log.info(`moved ${moved + merged} document(s) to the mirrored automerge layout`, {
      "migrate.docs_merged": merged,
      "git.pushed": sync.pushed,
    });
    return moved + merged;
  });
}
