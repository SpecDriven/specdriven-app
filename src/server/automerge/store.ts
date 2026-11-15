// Chunked Automerge storage inside the data repo, synced by git alongside the
// markdown projections — the Promise functions the server and the plugins
// (src/plugins/sdk/host.ts) load, save and list documents with.
//
// The layout — one directory per document under `.specdriven/automerge/`,
// content-addressed write-once chunks, how a load merges them — is
// storeLayout.ts, re-exported here. The reading and writing is the DocStore
// service (src/server/persistence/DocStore.ts); each function below runs one
// of its programs and resolves or rejects as it always did.
// Node APIs only — this runs under both Bun and Electron's Node runtime (see
// src/server/fsx.ts).

import type * as A from "@automerge/automerge";
import { documentTooNew } from "../dataFormat";
import { DocStore } from "../persistence/DocStore";
import { run, runSync } from "../persistence/runtime";
import {
  PAGE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  TESTING_SCHEMA_VERSION,
  type FeatureDoc,
  type PageDoc,
  type TestingDoc,
} from "./schema";
import {
  migrated,
  TESTING_DOC_NAME,
  type DocSavedListener,
  type LoadedDoc,
  type RawLoadedDoc,
} from "./storeLayout";

// The layout's public half, under the names this module always exported.
export {
  AUTOMERGE_ROOT,
  docDir,
  docDirRel,
  featureFileOfDocidPath,
  fileDocDirRel,
  isSafeDocDir,
  LEGACY_KIND_ROOTS,
  newFeatureDoc,
  newFileDoc,
  newPageDoc,
  newTestingDoc,
  pageDocDirRel,
  sourceFileOf,
  storeFolderFor,
  TESTING_DOC_ID,
  TESTING_DOC_NAME,
  testingDocDirRel,
  type DocChunk,
  type DocKind,
  type DocSavedListener,
  type LegacyKindRoot,
  type LoadedDoc,
  type RawLoadedDoc,
} from "./storeLayout";

/**
 * Fired after a document gains chunks on disk (created, saved, or absorbed
 * from a pull). The optional network sync bridge (netsync.ts) listens so a
 * local edit reaches websocket peers without polling.
 */
export function onDocSaved(listener: DocSavedListener): () => void {
  return runSync(DocStore.use((store) => store.onSaved(listener)));
}

/** True when the feature has a doc directory with at least one chunk. */
export async function hasFeatureDoc(dataDir: string, fileName: string): Promise<boolean> {
  return run(DocStore.use((store) => store.has(dataDir, "features", fileName)));
}

/** True when the page has a doc directory with at least one chunk. */
export async function hasPageDoc(dataDir: string, fileName: string): Promise<boolean> {
  return run(DocStore.use((store) => store.has(dataDir, "docs", fileName)));
}

/** True when a plugin's file has a doc directory with at least one chunk. */
export async function hasFileDoc(dataDir: string, fileName: string): Promise<boolean> {
  return run(DocStore.use((store) => store.has(dataDir, "docs", fileName)));
}

/** True once the data repo holds the test management document. */
export async function hasTestingDoc(dataDir: string): Promise<boolean> {
  return run(DocStore.use((store) => store.has(dataDir, "testing", TESTING_DOC_NAME)));
}

/**
 * Every document directory under the store, relative to AUTOMERGE_ROOT —
 * `specs/a/b.feature.md`, `tasks/x.md`, `event-models/p.model.json`,
 * `test-management/project`. A directory is a document when it holds a
 * `docid` or a chunk; the walk never descends into one. Loader-agnostic on
 * purpose: a plugin's folder the server never heard of is listed too. The
 * data viewer (src/server/dataViewer.ts) is built on it.
 */
export async function listDocDirs(dataDir: string): Promise<string[]> {
  return run(DocStore.use((store) => store.listDirs(dataDir)));
}

/**
 * Load a document by merging its chunks exactly as they are on disk: no
 * schema version check and no migration, so a too-new or a pre-v3 document
 * reads as written — what the data viewer shows. Null when the directory
 * holds no readable chunk; throws on a directory path that leaves the store.
 */
export async function loadRawDoc(dataDir: string, dirRel: string): Promise<RawLoadedDoc | null> {
  return run(DocStore.use((store) => store.loadRaw(dataDir, dirRel)));
}

/** When the directory itself was last changed — a chunk added or removed. */
export async function docDirMtime(dataDir: string, dirRel: string): Promise<number> {
  return run(DocStore.use((store) => store.dirMtime(dataDir, dirRel)));
}

/**
 * Refuse a document whose schema is newer than this app reads
 * (specs/app/data-format.feature.md): migrating or projecting it would drop
 * what this app does not know, and the tick would push the loss. The folder
 * is flagged too, so the API and the sync tick stop writing to it.
 */
function notNewerThan<T>(
  dataDir: string,
  fileName: string,
  known: number,
  then: (doc: A.Doc<T>) => A.Doc<T> = (doc) => doc,
): (doc: A.Doc<T>) => A.Doc<T> {
  return (doc) => {
    const version = (doc as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version > known) {
      throw documentTooNew(dataDir, fileName, version, known);
    }
    return then(doc);
  };
}

/**
 * Load a feature's document, or null when the feature has none yet (a
 * pre-migration repo, or a plain-md write from an older app version).
 */
export async function loadFeatureDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc | null> {
  const migrate = notNewerThan(dataDir, fileName, SCHEMA_VERSION, migrated);
  return run(DocStore.use((store) => store.load<FeatureDoc>(dataDir, "features", fileName, { migrate })));
}

/**
 * Load a feature's document from only the chunk files `include` admits, by
 * name — one side of a merge, whose chunks the merge left on disk beside the
 * other side's (driftSync.ts autoResolveOne).
 */
export async function loadFeatureDocFrom(
  dataDir: string,
  fileName: string,
  include: (chunk: string) => boolean,
): Promise<LoadedDoc | null> {
  const migrate = notNewerThan(dataDir, fileName, SCHEMA_VERSION, migrated);
  return run(
    DocStore.use((store) => store.load<FeatureDoc>(dataDir, "features", fileName, { migrate, include })),
  );
}

/** Load a page's document (specs/app/roadmap.feature.md, tasks.feature.md). */
export async function loadPageDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc<PageDoc> | null> {
  const migrate = notNewerThan<PageDoc>(dataDir, fileName, PAGE_SCHEMA_VERSION);
  return run(DocStore.use((store) => store.load<PageDoc>(dataDir, "docs", fileName, { migrate })));
}

/** loadFeatureDocFrom for a page's document. */
export async function loadPageDocFrom(
  dataDir: string,
  fileName: string,
  include: (chunk: string) => boolean,
): Promise<LoadedDoc<PageDoc> | null> {
  const migrate = notNewerThan<PageDoc>(dataDir, fileName, PAGE_SCHEMA_VERSION);
  return run(DocStore.use((store) => store.load<PageDoc>(dataDir, "docs", fileName, { migrate, include })));
}

/**
 * Load the document a plugin keeps for one file of the data repo — the
 * Event Models plugin's, one per model. The plugin owns the schema; the
 * store only keeps the chunks.
 */
export async function loadFileDoc<T>(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc<T> | null> {
  return run(DocStore.use((store) => store.load<T>(dataDir, "docs", fileName)));
}

/**
 * Load the test management document, or null when the repo has none yet
 * (the module was never used here). Schema v1 has nothing to migrate; the
 * hook is where a later version's migration goes, like `migrated`.
 */
export async function loadTestingDoc(dataDir: string): Promise<LoadedDoc<TestingDoc> | null> {
  const migrate = notNewerThan<TestingDoc>(dataDir, TESTING_DOC_NAME, TESTING_SCHEMA_VERSION);
  return run(
    DocStore.use((store) => store.load<TestingDoc>(dataDir, "testing", TESTING_DOC_NAME, { migrate })),
  );
}

export async function createFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
): Promise<LoadedDoc> {
  return run(DocStore.use((store) => store.create(dataDir, "features", fileName, doc)));
}

export async function createPageDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<PageDoc>,
): Promise<LoadedDoc<PageDoc>> {
  return run(DocStore.use((store) => store.create(dataDir, "docs", fileName, doc)));
}

export async function createFileDoc<T extends { id: string }>(
  dataDir: string,
  fileName: string,
  doc: A.Doc<T>,
): Promise<LoadedDoc<T>> {
  return run(DocStore.use((store) => store.create(dataDir, "docs", fileName, doc)));
}

export async function createTestingDoc(
  dataDir: string,
  doc: A.Doc<TestingDoc>,
): Promise<LoadedDoc<TestingDoc>> {
  return run(DocStore.use((store) => store.create(dataDir, "testing", TESTING_DOC_NAME, doc)));
}

export async function saveFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return run(DocStore.use((store) => store.save(dataDir, "features", fileName, doc, sinceHeads)));
}

export async function savePageDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<PageDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return run(DocStore.use((store) => store.save(dataDir, "docs", fileName, doc, sinceHeads)));
}

export async function saveFileDoc<T>(
  dataDir: string,
  fileName: string,
  doc: A.Doc<T>,
  sinceHeads: A.Heads,
): Promise<void> {
  return run(DocStore.use((store) => store.save(dataDir, "docs", fileName, doc, sinceHeads)));
}

export async function saveTestingDoc(
  dataDir: string,
  doc: A.Doc<TestingDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return run(DocStore.use((store) => store.save(dataDir, "testing", TESTING_DOC_NAME, doc, sinceHeads)));
}

/**
 * Fold snapshots and change files into a single fresh snapshot when the
 * directory has grown past COMPACT_AT change files. Old chunks are deleted
 * from the working tree; two peers compacting concurrently just leave two
 * snapshots for the next load to merge.
 */
export async function compactFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  return run(DocStore.use((store) => store.compact(dataDir, "features", fileName)));
}

/** Remove a feature's document directory (feature deleted). */
export async function removeFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  return run(DocStore.use((store) => store.remove(dataDir, "features", fileName)));
}

/** Remove a page's document directory (the page was deleted). */
export async function removePageDoc(dataDir: string, fileName: string): Promise<void> {
  return run(DocStore.use((store) => store.remove(dataDir, "docs", fileName)));
}

/** Remove a plugin file's document directory (the file was deleted). */
export async function removeFileDoc(dataDir: string, fileName: string): Promise<void> {
  return run(DocStore.use((store) => store.remove(dataDir, "docs", fileName)));
}

/** Every feature that has a document — the doc side of features.ts walk(). */
export async function listFeatureDocs(dataDir: string): Promise<string[]> {
  return run(DocStore.use((store) => store.list(dataDir, "features", "specs", ".feature.md")));
}

/**
 * Every page of one special folder that has a document. `folder` scopes the
 * listing, so the roadmap's drift pass never sees the tasks' documents, nor
 * the other way round (specs/app/roadmap.feature.md, tasks.feature.md).
 */
export async function listPageDocs(dataDir: string, folder: string): Promise<string[]> {
  return run(DocStore.use((store) => store.list(dataDir, "docs", folder, ".md")));
}

/** Every file of a plugin's folder, by suffix, that has a document. */
export async function listFileDocs(dataDir: string, folder: string, suffix: string): Promise<string[]> {
  return run(DocStore.use((store) => store.list(dataDir, "docs", folder, suffix)));
}
