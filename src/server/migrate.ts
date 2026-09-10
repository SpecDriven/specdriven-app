// Moving a data repo's features under `specs/` (src/server/walk.ts).
//
// Repos written before the spec tree got its own folder keep `.feature.md`
// files at the root and in arbitrary subfolders, sitting beside the reserved
// `roadmap/`, `tasks/` and `models/`. Only `specs/` is scanned now, so such a
// repo would open empty — this pass moves it forward once, on the sync tick,
// before anything reads the tree.
//
// Three things move together, or the repo is left inconsistent:
//
//   1. the `.feature.md` files themselves,
//   2. their Automerge doc directories under
//      `.specdriven/automerge/features/<path>/` — the system of record, so a
//      feature that loses its document loses every scenario id, every
//      draft-only scenario and its whole merge history,
//   3. the feature paths stored inside `models/**/*.model.json` `links`, which
//      are how an Event Model's slice finds the spec it generated.
//
// All of it lands in one commit, as renames, so the history follows the files.

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { moveAndPush } from "./git";
import type { PathMove } from "./git/backend";
import { isModelsFolderPath, MODELS_FOLDER, modelFiles } from "./models";
import { parseModelFile, serializeModelFile } from "./eventModel/serialize";
import type { ModelFile } from "./eventModel/types";
import { isPageFolderPath } from "./pages";
import { getLogger, withSpan } from "./telemetry";
import { SPECS_FOLDER, isFeatureFile, isSpecsFolderPath } from "./walk";

const log = getLogger("migrate");

/** Where a feature's Automerge document lives, relative to the repo. */
function docDirFor(fileName: string): string {
  return `.specdriven/automerge/features/${fileName}`;
}

/**
 * Feature files outside the spec tree, repo-relative. The reserved folders are
 * skipped: a `.feature.md` under `roadmap/` or `models/` is somebody's page or
 * export, not a spec that belongs in the tree.
 */
async function strayFeatures(dataDir: string, rel = ""): Promise<string[]> {
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
    if (isSpecsFolderPath(path) || isPageFolderPath(path) || isModelsFolderPath(path)) continue;
    if (entry.isDirectory()) out.push(...(await strayFeatures(dataDir, path)));
    else if (isFeatureFile(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Rewrite the feature paths an Event Model's slices point at. Returns the
 * model files that changed, so they join the migration commit.
 */
async function relinkModels(dataDir: string, moved: Map<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const fileName of await modelFiles(dataDir, MODELS_FOLDER)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null) continue;
    let model: ModelFile;
    try {
      model = parseModelFile(text);
    } catch {
      // A model we cannot parse is left exactly as it is: the migration must
      // not turn a corrupt file into a differently corrupt one.
      log.warn(`skipped unparseable model during migration: ${fileName}`);
      continue;
    }
    let touched = false;
    const links: ModelFile["links"] = {};
    for (const [sliceId, link] of Object.entries(model.links ?? {})) {
      // A slice with no feature yet, or one naming a spec that did not move,
      // is copied across untouched.
      const to = link.feature === undefined ? undefined : moved.get(link.feature);
      if (to === undefined) {
        links[sliceId] = link;
        continue;
      }
      links[sliceId] = { ...link, feature: to };
      touched = true;
    }
    if (!touched) continue;
    // Written through the model serializer, so the file keeps its canonical
    // key order rather than whatever a hand-rolled stringify would emit.
    await writeTextFile(`${dataDir}/${fileName}`, serializeModelFile({ ...model, links }));
    changed.push(fileName);
  }
  return changed;
}

/**
 * Move any features outside `specs/` into it, with their documents and the
 * model links that name them, in one commit. A no-op — and silent — for a repo
 * that is already migrated, which is every tick after the first.
 *
 * Returns how many features moved.
 */
export async function migrateToSpecsFolder(dataDir: string): Promise<number> {
  const stray = await strayFeatures(dataDir);
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
        if (await fileExists(`${dataDir}/${docDirFor(from)}/docid`)) {
          moves.push({ from: docDirFor(from), to: docDirFor(to) });
        }
      }
      if (moves.length === 0) return 0;
      const relinked = await relinkModels(dataDir, moved);
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
      // The rewritten model files are a content change, not a rename, so they
      // ride the sync tick's own commit rather than this one.
      log.info(`moved ${moved.size} feature(s) under ${SPECS_FOLDER}/`, {
        "migrate.models_relinked": relinked.length,
        "git.pushed": sync.pushed,
      });
      return moved.size;
    },
  );
}
