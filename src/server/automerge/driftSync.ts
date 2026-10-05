// The sync-tick side of the Automerge system-of-record (see reload.ts):
//
// - autoResolveMergeConflicts: a git pull that conflicts on `.feature.md`
//   files no longer goes straight to the resolution dialog. Peers on this
//   app version shipped their edits as chunk files too, which merged cleanly
//   in the same pull — so the merged document already holds both sides' in-app
//   edits. Their markdown still folds in: overlapping text keeps the document
//   so a character merge cannot splice the same insertion twice, and fields
//   the document left at the merge base take theirs (a hand edit riding the
//   same push; Lean H1). Plain-markdown edits (older app versions, GitHub PRs)
//   have no ops to merge, so they go through a scenario-level three-way merge
//   against the git merge base. Only both-sides-edited-the-same-scenario
//   (markdown-only, no ops) remains a human decision, surfaced through the
//   existing conflict UI.
//
// - importDrift: markdown that changed without its document — an external
//   GitHub edit, an old-version peer's push, or a feature that predates its
//   document — is absorbed (or first imported) into the doc, and the file is
//   rewritten to the doc's projection. Drift that would tamper with a
//   published scenario is refused and the file repaired from the doc. The
//   pass first heals every published spec whose live text a CRDT merge left
//   different from its recorded published body (schema.ts publishedBody), so
//   that artifact is never mistaken for tampering and never reaches a file.

import type * as A from "@automerge/automerge";
import { fileExists, readTextFile, writeTextFile } from "../fsx";
import {
  conflictedFiles,
  diffNames,
  existsIn,
  resolveConflict,
  stageVersion,
  theirsVersion,
} from "../git";
import { featureTextError, parseFeature, parsePage, type MarkdownPage } from "../parser";
import { isPageFile, isPageFolderPath } from "../pages";
import { threeWayFeature, threeWayPage, type TextOverlap } from "./merge";
import { docToPage, projectPage, reconcilePage } from "./page";
import { docToFeature, isProjectionOf, projectFeature } from "./project";
import { healPublished, importFeatureDoc, reconcile } from "./reconcile";
import type { FeatureDoc } from "./schema";
import {
  AUTOMERGE_ROOT,
  createFeatureDoc,
  docDirRel,
  featureFileOfDocidPath,
  listFeatureDocs,
  loadFeatureDoc,
  loadPageDoc,
  pageDocDirRel,
  removeFeatureDoc,
  saveFeatureDoc,
  savePageDoc,
} from "./store";
import { errorAttributes, getLogger, withSpan } from "../telemetry";
import { walk } from "../walk";

const log = getLogger("sync");

const EMPTY = { name: "", description: "", scenarios: [] };

export interface AutoResolveResult {
  /** Conflicted files this pass resolved. */
  resolved: string[];
  /** Conflicted files left for the resolution dialog, with the reason. */
  remaining: Map<string, string>;
  message: string;
}

/**
 * Resolve what a merged document (or a three-way merge) can resolve of a
 * conflicted pull. Resolving the last conflicted file completes the merge
 * commit and pushes (backend resolveConflict semantics).
 */
export async function autoResolveMergeConflicts(
  dataDir: string,
  conflicted: string[],
): Promise<AutoResolveResult> {
  return withSpan(
    "sync.auto_resolve_conflicts",
    { "specdriven.dir": dataDir, "sync.conflicted_files": conflicted.length },
    async (span) => {
      const conflictedSet = new Set(conflicted);
      const resolved: string[] = [];
      const remaining = new Map<string, string>();
      for (const path of conflicted) {
        const why = await autoResolveOne(dataDir, path, conflictedSet);
        if (why === null) {
          resolved.push(path);
          log.info(`auto-merged conflicted ${path}`);
        } else {
          remaining.set(path, why);
          log.warn(`conflict on ${path} left for manual resolution`, { "sync.reason": why });
        }
      }
      span.setAttributes({
        "sync.resolved_files": resolved.length,
        "sync.remaining_files": remaining.size,
      });
      const parts = [];
      if (resolved.length > 0) parts.push(`auto-merged ${resolved.length} conflicted file(s)`);
      for (const [path, why] of remaining) parts.push(`${path}: ${why}`);
      return { resolved, remaining, message: parts.join("; ") };
    },
  );
}

/**
 * True when the other side of the merge added chunk files for this document.
 * `docDir` is where that document's chunks live — a feature's or a page's,
 * which are different trees, so the caller passes the right one.
 */
async function theirsBroughtChunks(dataDir: string, docDir: string): Promise<boolean> {
  const changed = await diffNames(dataDir, "HEAD", "MERGE_HEAD", docDir);
  for (const path of changed) {
    if (!path.endsWith(".bin")) continue;
    // The diff lists differences in both directions; a chunk of theirs is one
    // that exists in MERGE_HEAD and not in our HEAD.
    if ((await existsIn(dataDir, "MERGE_HEAD", path)) && !(await existsIn(dataDir, "HEAD", path))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve one conflicted path; null on success, else why it was left.
 *
 * For a conflicted `.feature.md` the decision tree is:
 * - The other peer runs this app version (its pull delivered chunk files for
 *   this feature): the merged document already holds both sides' in-app
 *   operations. Their markdown still folds in, but overlapping text keeps
 *   the document (`merge.ts` `ours`) so a character merge cannot splice the
 *   same insertion twice. Fields the document left at the merge base take
 *   theirs — a hand edit riding the same push, which used to be dropped
 *   (Lean H1).
 * - The other peer sent only markdown (older app version, GitHub edit): its
 *   changes have no operations to merge, so they fold in through a
 *   scenario-level three-way merge against the git merge base.
 * - Concurrent first import (signature: this feature's docid file conflicted
 *   in the same merge): merging the two lineages' chunks picked one side's
 *   content wholesale, so both sides' markdown folds back in three-way.
 */
async function autoResolveOne(
  dataDir: string,
  path: string,
  conflictedSet: Set<string>,
): Promise<string | null> {
  const docidOf = featureFileOfDocidPath(path);
  if (docidOf !== null) {
    // Two peers imported the same feature concurrently and minted different
    // identities. The chunks of both lineages merged in this same pull, and
    // Automerge already picked the winning lineage deterministically — the
    // docid file just records that winner's identity.
    const fileName = docidOf;
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) return "document did not load";
    await resolveConflict(dataDir, path, `${loaded.doc.id}\n`);
    return null;
  }
  // A markdown page — a roadmap page, a task, a notebook entry
  // (specs/app/engineering-notebook.feature.md "Entries are shared through
  // git"): the same decision tree as a feature's below, minus the scenarios.
  if (isPageFolderPath(path) && isPageFile(path)) {
    return autoResolvePage(dataDir, path);
  }
  if (!path.endsWith(".feature.md") || path.startsWith(`${AUTOMERGE_ROOT}/`)) {
    return "not a feature file";
  }
  const loaded = await loadFeatureDoc(dataDir, path);
  if (loaded === null) return "no document behind it";
  const theirsText = (await stageVersion(dataDir, path, 3)) ?? (await theirsVersion(dataDir, path));
  if (theirsText === null) return "deleted on one side";
  const baseText = await stageVersion(dataDir, path, 1);
  const base = baseText === null ? EMPTY : parseFeature(baseText);
  const lineageRace = conflictedSet.has(`${docDirRel(path)}/docid`);
  const opsArrived = await theirsBroughtChunks(dataDir, docDirRel(path));

  let doc = loaded.doc;
  try {
    if (lineageRace) {
      const oursText = await stageVersion(dataDir, path, 2);
      if (oursText !== null && !isProjectionOf(oursText, doc)) {
        const own = threeWayFeature(base, docToFeature(doc), parseFeature(oursText));
        if (!own.ok) return own.conflict;
        doc = reconcile(doc, own.feature);
      }
    }
    // Always fold theirs. When operations already arrived, overlapping
    // text keeps the merged document so the character merge cannot
    // duplicate an insertion the CRDT already applied; fields still at
    // the merge base take theirs (a hand edit in the same push, H1).
    const overlap: TextOverlap = opsArrived && !lineageRace ? "ours" : "merge";
    const merged = threeWayFeature(base, docToFeature(doc), parseFeature(theirsText), overlap);
    if (!merged.ok) return merged.conflict;
    doc = reconcile(doc, merged.feature);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  await saveFeatureDoc(dataDir, path, doc, loaded.heads);
  await resolveConflict(dataDir, path, projectFeature(doc), [docDirRel(path)]);
  return null;
}

/**
 * Resolve a conflicted markdown page; null on success, else why it was left.
 * A page has no scenarios and one projection form, so there is no lineage
 * race to unpick. Their markdown always folds in: overlapping text keeps the
 * merged document when operations arrived (so a character merge cannot
 * duplicate an insertion the CRDT already applied), and fields still at the
 * merge base take theirs — the same mixed-origin rule as a feature (H1).
 * The page merge cannot conflict — every field either merges as text or
 * resolves to one side — so this only bails when there is no document to
 * merge into.
 */
async function autoResolvePage(dataDir: string, path: string): Promise<string | null> {
  const loaded = await loadPageDoc(dataDir, path);
  if (loaded === null) return "no document behind it";
  const theirsText = (await stageVersion(dataDir, path, 3)) ?? (await theirsVersion(dataDir, path));
  if (theirsText === null) return "deleted on one side";
  const baseText = await stageVersion(dataDir, path, 1);
  const base: MarkdownPage = baseText === null ? { name: "", body: "" } : parsePage(baseText);

  let doc = loaded.doc;
  try {
    const overlap: TextOverlap = (await theirsBroughtChunks(dataDir, pageDocDirRel(path)))
      ? "ours"
      : "merge";
    doc = reconcilePage(doc, threeWayPage(base, docToPage(doc), parsePage(theirsText), overlap));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  await savePageDoc(dataDir, path, doc, loaded.heads);
  await resolveConflict(dataDir, path, projectPage(doc), [pageDocDirRel(path)]);
  return null;
}

/**
 * One drift pass over the whole data repo. Returns a human-readable summary
 * ("" when nothing drifted). Never runs during an in-progress merge — the
 * caller checks — since conflict markers must not be absorbed as content.
 */
export async function importDrift(dataDir: string): Promise<string> {
  return withSpan("sync.import_drift", { "specdriven.dir": dataDir }, async (span) => {
    const files = (await walk(dataDir)).files;
    let imported = 0;
    let absorbed = 0;
    let repaired = 0;
    let healed = 0;
    for (const fileName of files) {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      // Unreadable or malformed markdown never reaches the document.
      if (text === null || featureTextError(text) !== null) continue;
      const loaded = await loadFeatureDoc(dataDir, fileName);
      if (loaded === null) {
        const created = await createFeatureDoc(dataDir, fileName, importFeatureDoc(parseFeature(text)));
        const projection = projectFeature(created.doc);
        if (projection !== text) await writeTextFile(`${dataDir}/${fileName}`, projection);
        imported++;
        log.debug(`imported ${fileName} into a document`);
        continue;
      }
      // A published spec whose live text a merge left doubled is tidied
      // first, before any look at the file, so a peer still holding the
      // doubled text (one running an older build, or one that merged the
      // same two absorbs) pulls the heal and stops rewriting the file
      // (reconcile.ts healPublished). Saved below with whatever else the
      // file brings; saveDoc writes nothing when the heal minted no change.
      const doc = healPublished(loaded.doc);
      if (doc !== loaded.doc) {
        healed++;
        log.debug(`healed published text in ${fileName}`);
      }
      // A file in the document's other form — external links written by a
      // peer whose setting differs — is not drift (project.ts).
      if (isProjectionOf(text, doc)) {
        await saveFeatureDoc(dataDir, fileName, doc, loaded.heads);
        continue;
      }
      const drift = absorbDrift(doc, text);
      if (drift.refused === undefined) {
        await saveFeatureDoc(dataDir, fileName, drift.doc, loaded.heads);
        await writeTextFile(`${dataDir}/${fileName}`, projectFeature(drift.doc));
        absorbed++;
        log.debug(`absorbed drifted ${fileName} into its document`);
      } else {
        await saveFeatureDoc(dataDir, fileName, doc, loaded.heads);
        await writeTextFile(`${dataDir}/${fileName}`, projectFeature(doc));
        repaired++;
        log.warn(`refused drift on ${fileName}; repaired from its document`, errorAttributes(drift.refused));
      }
    }
    // A document whose markdown is gone was deleted externally: the markdown
    // is the interchange format, so the deletion stands.
    let removed = 0;
    for (const fileName of await listFeatureDocs(dataDir)) {
      if (!(await fileExists(`${dataDir}/${fileName}`))) {
        await removeFeatureDoc(dataDir, fileName);
        removed++;
        log.debug(`dropped document for deleted ${fileName}`);
      }
    }
    span.setAttributes({
      "sync.imported": imported,
      "sync.absorbed": absorbed,
      "sync.repaired": repaired,
      "sync.healed": healed,
      "sync.removed": removed,
    });
    const parts = [];
    if (imported > 0) parts.push(`imported ${imported} feature(s) into documents`);
    if (absorbed > 0) parts.push(`absorbed ${absorbed} externally edited file(s)`);
    if (repaired > 0) parts.push(`repaired ${repaired} file(s) from their documents`);
    if (healed > 0) parts.push(`healed ${healed} published scenario(s)`);
    if (removed > 0) parts.push(`dropped ${removed} document(s) for deleted features`);
    return parts.join("; ");
  });
}

/**
 * The drift pass's rule for one drifted `.feature.md`, shared with the
 * editor's save (features.ts absorbIntoDoc), which absorbs a file that
 * drifted since the last tick before it writes over it: the markdown is
 * reconciled into the document — unless it tampered with a published
 * scenario, when the document wins (`refused` says why) and the caller
 * repairs the file to its projection.
 */
export function absorbDrift(
  doc: A.Doc<FeatureDoc>,
  text: string,
): { doc: A.Doc<FeatureDoc>; refused?: unknown } {
  try {
    return { doc: reconcile(doc, parseFeature(text)) };
  } catch (e) {
    return { doc, refused: e };
  }
}

/** True while a merge with unresolved conflicts is in progress. */
export async function mergeInProgress(dataDir: string): Promise<boolean> {
  return (await conflictedFiles(dataDir)).length > 0;
}
