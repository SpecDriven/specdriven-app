// Chunked Automerge storage inside the data repo, synced by git alongside the
// markdown projections. One directory per document under
// `.specdriven/automerge/`, in a tree that mirrors the data repo's own
// top-level folders (specs/datastore/automerge-store.feature.md "Storage
// layout"):
//
//   specs/<path>.feature.md/          the `.feature.md` documents
//   roadmap/<name>.md/                the special folders' plain markdown
//   tasks/<name>.md/                  pages (specs/app/roadmap.feature.md,
//   notebook/<name>.md/               tasks.feature.md, engineering-notebook)
//   <folder>/<path>/                  a plugin's per-file documents (the
//                                     Event Models' under event-models/)
//   test-management/project/          the test management module's one doc
//
// and inside each of those directories:
//
//   docid                  stable document identity, shared via git
//   snapshot-<hash>.bin    full document (Automerge.save)
//   changes-<hash>.bin     incremental changes (Automerge.saveSince)
//
// Chunk files are content-addressed and write-once, so concurrent peers never
// collide on a path and a git merge of two peers' pushes is a plain file-set
// union. Loading merges every readable chunk. Chunks from a foreign document
// lineage (possible after a concurrent rename recreates a directory) merge
// too: Automerge resolves each conflicting key to the same winner on every
// peer, so all peers still converge, and the markdown drift pass repairs any
// content the losing lineage held. Corrupt files are skipped, never fatal.
// Node APIs only — this runs under both Bun and Electron's Node runtime (see
// src/server/fsx.ts).

import * as A from "@automerge/automerge";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTextFile } from "../fsx";
import { getLogger, withSpan } from "../telemetry";
import {
  PAGE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  TESTING_SCHEMA_VERSION,
  type FeatureDoc,
  type PageDoc,
  type SpecEntry,
  type SpecType,
  type TestingDoc,
} from "./schema";

const log = getLogger("automerge");

/** Change files tolerated before the next save folds them into a snapshot. */
const COMPACT_AT = 12;

/**
 * Fired after a document gains chunks on disk (created, saved, or absorbed
 * from a pull). The optional network sync bridge (netsync.ts) listens so a
 * local edit reaches websocket peers without polling.
 */
export type DocSavedListener = (dataDir: string, fileName: string) => void;

const docSavedListeners = new Set<DocSavedListener>();

export function onDocSaved(listener: DocSavedListener): () => void {
  docSavedListeners.add(listener);
  return () => docSavedListeners.delete(listener);
}

function emitDocSaved(dataDir: string, fileName: string): void {
  for (const listener of docSavedListeners) listener(dataDir, fileName);
}

export interface LoadedDoc<T = FeatureDoc> {
  doc: A.Doc<T>;
  /** Heads as loaded — pass back on save so it writes only the delta. */
  heads: A.Heads;
  docId: string;
  /** Chunk files that could not be applied (foreign lineage or corrupt). */
  skippedChunks: string[];
}

/**
 * A pre-v3 entry: v1 carried `published`/`proposed` booleans instead of
 * `status`, and nothing before v3 carried `type`.
 */
type LegacySpecEntry = Omit<SpecEntry, "type"> & {
  type?: SpecType;
  published?: boolean;
  proposed?: boolean;
};

/** A document as any schema version may have left it on disk. */
type LegacyFeatureDoc = Omit<FeatureDoc, "specs"> & {
  specs?: LegacySpecEntry[];
  /** The v1/v2 list, renamed to `specs` in v3. */
  scenarios?: LegacySpecEntry[];
};

function legacyStatus(entry: LegacySpecEntry): SpecEntry["status"] {
  if (entry.status !== undefined) return entry.status;
  return entry.published ? "published" : entry.proposed ? "proposed" : "draft";
}

/**
 * Bring a document loaded from disk up to SCHEMA_VERSION: fold a v1 entry's
 * `published`/`proposed` booleans into `status` (v2), move the `scenarios`
 * list to `specs` and stamp each entry `type: "Scenario"` (v3). Applied on
 * load; the heads returned by loadFeatureDoc are the pre-migration heads, so
 * the migration ops ride whatever delta the caller saves next — a load that
 * never saves just migrates again next time.
 *
 * The v3 list move copies entries (ids kept) into a new list, so two peers
 * migrating the same document concurrently produce two `specs` lists and
 * Automerge picks the same winner on every peer — the foreign-lineage case
 * described at the top of this file, repaired by the markdown drift pass.
 */
function migrated(doc: A.Doc<FeatureDoc>): A.Doc<FeatureDoc> {
  const legacy = doc as unknown as A.Doc<LegacyFeatureDoc>;
  const entries = [...(legacy.specs ?? []), ...(legacy.scenarios ?? [])];
  const stale =
    doc.schemaVersion < SCHEMA_VERSION ||
    legacy.scenarios !== undefined ||
    legacy.specs === undefined ||
    entries.some((s) => s.status === undefined || s.type === undefined);
  if (!stale) return doc;
  return A.change(doc, (raw) => {
    const d = raw as unknown as LegacyFeatureDoc;
    if (d.schemaVersion < SCHEMA_VERSION) d.schemaVersion = SCHEMA_VERSION;
    if (d.specs === undefined) d.specs = [];
    if (d.scenarios !== undefined) {
      for (const entry of d.scenarios) {
        d.specs.push({
          id: entry.id,
          type: entry.type ?? "Scenario",
          name: entry.name,
          version: entry.version,
          status: legacyStatus(entry),
          body: entry.body,
          tests: [...entry.tests],
        });
      }
      delete d.scenarios;
    }
    for (const entry of d.specs) {
      if (entry.status === undefined) {
        entry.status = legacyStatus(entry);
        delete entry.published;
        delete entry.proposed;
      }
      if (entry.type === undefined) entry.type = "Scenario";
    }
  });
}

/**
 * The kinds of document the store holds: `features` for the `.feature.md`
 * documents, `docs` for the plain markdown pages of the special folders —
 * the roadmap's (specs/app/roadmap.feature.md), the tasks'
 * (specs/app/tasks.feature.md) and the notebook's — and a plugin's per-file
 * documents (the file-doc functions below, src/plugins/sdk/host.ts), and
 * `testing` for the test management module's one document
 * (specs/app/tests.feature.md), which has no markdown side at all — the
 * chunks are the only copy. The kind says which schema a document follows;
 * where it lives on disk follows from its file name alone (docDirRel and
 * friends below).
 */
export type DocKind = "features" | "docs" | "testing";

/** The store's root, relative to the data repo. */
export const AUTOMERGE_ROOT = ".specdriven/automerge";

/**
 * A document's directory is its source file's repo-relative path with the
 * first folder mapped through this table, so the store mirrors the data
 * repo's own top level: `specs/`, `roadmap/`, `tasks/` and `notebook/` keep
 * their names and `models/` reads as `event-models/` — the Event Models
 * plugin's folder, renamed because `models/` was an old per-kind root below
 * (LEGACY_KIND_ROOTS). A source folder the table does not know keeps its
 * name too (a hand-made page folder, or a plugin's).
 */
const DOC_FOLDERS: Record<string, string> = {
  specs: "specs",
  roadmap: "roadmap",
  tasks: "tasks",
  notebook: "notebook",
  models: "event-models",
};

/**
 * The old, per-kind roots (`features/`, `docs/`, ...) that migrate.ts lifts.
 * `models` held the Event Model documents, which a plugin keeps now.
 */
export const LEGACY_KIND_ROOTS = ["features", "docs", "models", "testing"] as const;
export type LegacyKindRoot = (typeof LEGACY_KIND_ROOTS)[number];

/** The store's folder for a source folder of the data repo. */
export function storeFolderFor(sourceFolder: string): string {
  return DOC_FOLDERS[sourceFolder] ?? sourceFolder;
}

/** A repo-relative file name split at its first `/`; no folder for a bare name. */
function splitFolder(fileName: string): { folder: string; rest: string } {
  const i = fileName.indexOf("/");
  return i < 0 ? { folder: "", rest: fileName } : { folder: fileName.slice(0, i), rest: fileName.slice(i + 1) };
}

/** The test management module's single document, under `test-management/`. */
export const TESTING_DOC_NAME = "project";
const TESTING_FOLDER = "test-management";

function dirRel(fileName: string): string {
  const { folder, rest } = splitFolder(fileName);
  return folder ? `${AUTOMERGE_ROOT}/${storeFolderFor(folder)}/${rest}` : `${AUTOMERGE_ROOT}/${rest}`;
}

/** Repo-relative path of the testing document's directory, for git pathspecs. */
export function testingDocDirRel(): string {
  return `${AUTOMERGE_ROOT}/${TESTING_FOLDER}/${TESTING_DOC_NAME}`;
}

/** Repo-relative path of a feature's doc directory, for git pathspecs. */
export function docDirRel(fileName: string): string {
  return dirRel(fileName);
}

/** Repo-relative path of a page's doc directory, for git pathspecs. */
export function pageDocDirRel(fileName: string): string {
  return dirRel(fileName);
}

/** Repo-relative path of a plugin file's doc directory, for git pathspecs. */
export function fileDocDirRel(fileName: string): string {
  return dirRel(fileName);
}

/**
 * The feature whose `docid` file sits at this repo-relative path, or null
 * when the path is not one — the drift pass recognises a lineage race by it.
 */
export function featureFileOfDocidPath(path: string): string | null {
  const prefix = `${AUTOMERGE_ROOT}/${storeFolderFor("specs")}/`;
  const suffix = ".feature.md/docid";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  return `specs/${path.slice(prefix.length, -"/docid".length)}`;
}

export function docDir(dataDir: string, fileName: string): string {
  return join(dataDir, docDirRel(fileName));
}

function kindDir(dataDir: string, kind: DocKind, fileName: string): string {
  return join(dataDir, kind === "testing" ? testingDocDirRel() : dirRel(fileName));
}

async function hasDoc(dataDir: string, kind: DocKind, fileName: string): Promise<boolean> {
  const { snapshots, changes } = await chunkFiles(kindDir(dataDir, kind, fileName));
  return snapshots.length > 0 || changes.length > 0;
}

/** True when the feature has a doc directory with at least one chunk. */
export async function hasFeatureDoc(dataDir: string, fileName: string): Promise<boolean> {
  return hasDoc(dataDir, "features", fileName);
}

/** True when the page has a doc directory with at least one chunk. */
export async function hasPageDoc(dataDir: string, fileName: string): Promise<boolean> {
  return hasDoc(dataDir, "docs", fileName);
}

/** True when a plugin's file has a doc directory with at least one chunk. */
export async function hasFileDoc(dataDir: string, fileName: string): Promise<boolean> {
  return hasDoc(dataDir, "docs", fileName);
}

/** True once the data repo holds the test management document. */
export async function hasTestingDoc(dataDir: string): Promise<boolean> {
  return hasDoc(dataDir, "testing", TESTING_DOC_NAME);
}

function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function chunkFiles(dir: string): Promise<{ snapshots: string[]; changes: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { snapshots: [], changes: [] };
  }
  // Sorted for deterministic application order across peers.
  entries.sort();
  return {
    snapshots: entries.filter((f) => f.startsWith("snapshot-") && f.endsWith(".bin")),
    changes: entries.filter((f) => f.startsWith("changes-") && f.endsWith(".bin")),
  };
}

/**
 * Load a document by merging every chunk in its directory, or null when there
 * is none yet. `migrate` brings what disk holds up to the current schema (the
 * feature documents' only); the heads returned are the pre-migration ones, so
 * the migration ops ride whatever delta the caller saves next.
 */
async function loadDoc<T>(
  dataDir: string,
  kind: DocKind,
  fileName: string,
  migrate: (doc: A.Doc<T>) => A.Doc<T> = (doc) => doc,
  include: (chunk: string) => boolean = () => true,
): Promise<LoadedDoc<T> | null> {
  const dir = kindDir(dataDir, kind, fileName);
  const all = await chunkFiles(dir);
  const snapshots = all.snapshots.filter(include);
  const changes = all.changes.filter(include);
  if (snapshots.length === 0 && changes.length === 0) return null;

  let doc: A.Doc<T> | null = null;
  const skippedChunks: string[] = [];
  for (const file of [...snapshots, ...changes]) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(dir, file));
    } catch {
      skippedChunks.push(file);
      continue;
    }
    try {
      doc = doc === null ? A.load<T>(bytes) : A.loadIncremental(doc, bytes);
    } catch {
      skippedChunks.push(file);
    }
  }
  if (doc === null) return null;

  if (skippedChunks.length > 0) {
    // Skipping is deliberately non-fatal, but it must not be invisible: a
    // chunk that never loads anywhere means edits living only in that chunk
    // are not reaching this peer.
    log.warn(`skipped ${skippedChunks.length} unreadable chunk(s) for ${fileName}`, {
      "specdriven.file": fileName,
      "automerge.skipped_chunks": skippedChunks.join(","),
    });
  }
  const docId = (await readTextFile(join(dir, "docid")))?.trim() ?? (doc as { id?: string }).id ?? "";
  // Heads are captured before the schema migration on purpose — see migrated.
  const heads = A.getHeads(doc);
  return { doc: migrate(doc), heads, docId, skippedChunks };
}

/**
 * Load a feature's document, or null when the feature has none yet (a
 * pre-migration repo, or a plain-md write from an older app version).
 */
export async function loadFeatureDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc | null> {
  return loadDoc<FeatureDoc>(dataDir, "features", fileName, migrated);
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
  return loadDoc<FeatureDoc>(dataDir, "features", fileName, migrated, include);
}

/** Load a page's document (specs/app/roadmap.feature.md, tasks.feature.md). */
export async function loadPageDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc<PageDoc> | null> {
  return loadDoc<PageDoc>(dataDir, "docs", fileName);
}

/** loadFeatureDocFrom for a page's document. */
export async function loadPageDocFrom(
  dataDir: string,
  fileName: string,
  include: (chunk: string) => boolean,
): Promise<LoadedDoc<PageDoc> | null> {
  return loadDoc<PageDoc>(dataDir, "docs", fileName, undefined, include);
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
  return loadDoc<T>(dataDir, "docs", fileName);
}

/**
 * Load the test management document, or null when the repo has none yet
 * (the module was never used here). Schema v1 has nothing to migrate; the
 * hook is where a later version's migration goes, like `migrated` above.
 */
export async function loadTestingDoc(dataDir: string): Promise<LoadedDoc<TestingDoc> | null> {
  return loadDoc<TestingDoc>(dataDir, "testing", TESTING_DOC_NAME);
}

/**
 * Create a document directory from a fresh doc: full snapshot plus the docid
 * file that gives every peer the same identity for network sync.
 */
async function createDoc<T extends { id: string }>(
  dataDir: string,
  kind: DocKind,
  fileName: string,
  doc: A.Doc<T>,
): Promise<LoadedDoc<T>> {
  return withSpan("automerge.create_doc", { "specdriven.file": fileName }, async (span) => {
    const dir = kindDir(dataDir, kind, fileName);
    await mkdir(dir, { recursive: true });
    const bytes = A.save(doc);
    await writeFile(join(dir, `snapshot-${contentHash(bytes)}.bin`), bytes);
    const docId = doc.id;
    await writeFile(join(dir, "docid"), `${docId}\n`);
    span.setAttributes({ "automerge.doc_id": docId, "automerge.snapshot_bytes": bytes.length });
    log.debug(`created document for ${fileName}`, { "automerge.doc_id": docId });
    if (kind === "features") emitDocSaved(dataDir, fileName);
    return { doc, heads: A.getHeads(doc), docId, skippedChunks: [] };
  });
}

export async function createFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
): Promise<LoadedDoc> {
  return createDoc(dataDir, "features", fileName, doc);
}

export async function createPageDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<PageDoc>,
): Promise<LoadedDoc<PageDoc>> {
  return createDoc(dataDir, "docs", fileName, doc);
}

export async function createFileDoc<T extends { id: string }>(
  dataDir: string,
  fileName: string,
  doc: A.Doc<T>,
): Promise<LoadedDoc<T>> {
  return createDoc(dataDir, "docs", fileName, doc);
}

export async function createTestingDoc(
  dataDir: string,
  doc: A.Doc<TestingDoc>,
): Promise<LoadedDoc<TestingDoc>> {
  return createDoc(dataDir, "testing", TESTING_DOC_NAME, doc);
}

/**
 * Persist changes made since `sinceHeads` (the heads a load returned) as one
 * incremental chunk, folding everything into a fresh snapshot once enough
 * change files pile up. A no-op delta writes nothing.
 */
async function saveDoc<T>(
  dataDir: string,
  kind: DocKind,
  fileName: string,
  doc: A.Doc<T>,
  sinceHeads: A.Heads,
): Promise<void> {
  const dir = kindDir(dataDir, kind, fileName);
  const delta = A.saveSince(doc, sinceHeads);
  if (delta.length === 0) return;
  await withSpan(
    "automerge.save_doc",
    { "specdriven.file": fileName, "automerge.delta_bytes": delta.length },
    async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `changes-${contentHash(delta)}.bin`), delta);
      log.debug(`saved incremental chunk for ${fileName}`, {
        "automerge.delta_bytes": delta.length,
      });
      await compactDoc(dataDir, kind, fileName);
      if (kind === "features") emitDocSaved(dataDir, fileName);
    },
  );
}

export async function saveFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return saveDoc(dataDir, "features", fileName, doc, sinceHeads);
}

export async function savePageDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<PageDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return saveDoc(dataDir, "docs", fileName, doc, sinceHeads);
}

export async function saveFileDoc<T>(
  dataDir: string,
  fileName: string,
  doc: A.Doc<T>,
  sinceHeads: A.Heads,
): Promise<void> {
  return saveDoc(dataDir, "docs", fileName, doc, sinceHeads);
}

export async function saveTestingDoc(
  dataDir: string,
  doc: A.Doc<TestingDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  return saveDoc(dataDir, "testing", TESTING_DOC_NAME, doc, sinceHeads);
}

/**
 * Fold snapshots and change files into a single fresh snapshot when the
 * directory has grown past COMPACT_AT change files. Old chunks are deleted
 * from the working tree; two peers compacting concurrently just leave two
 * snapshots for the next load to merge.
 */
async function compactDoc(dataDir: string, kind: DocKind, fileName: string): Promise<void> {
  const dir = kindDir(dataDir, kind, fileName);
  const { snapshots, changes } = await chunkFiles(dir);
  if (changes.length < COMPACT_AT) return;
  await withSpan(
    "automerge.compact_doc",
    { "specdriven.file": fileName, "automerge.change_chunks": changes.length },
    async () => {
      const loaded = await loadDoc<unknown>(dataDir, kind, fileName);
      if (loaded === null) return;
      const bytes = A.save(loaded.doc);
      const name = `snapshot-${contentHash(bytes)}.bin`;
      await writeFile(join(dir, name), bytes);
      const applied = new Set(loaded.skippedChunks);
      for (const file of [...snapshots, ...changes]) {
        // Only chunks that actually loaded are covered by the new snapshot.
        if (file !== name && !applied.has(file)) await rm(join(dir, file), { force: true });
      }
      log.debug(`compacted ${changes.length} change chunk(s) into a snapshot for ${fileName}`, {
        "automerge.snapshot_bytes": bytes.length,
      });
    },
  );
}

export async function compactFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  return compactDoc(dataDir, "features", fileName);
}

/** Remove a feature's document directory (feature deleted). */
export async function removeFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  await rm(docDir(dataDir, fileName), { recursive: true, force: true });
  log.debug(`removed document for ${fileName}`);
}

/** Remove a page's document directory (the page was deleted). */
export async function removePageDoc(dataDir: string, fileName: string): Promise<void> {
  await rm(kindDir(dataDir, "docs", fileName), { recursive: true, force: true });
  log.debug(`removed document for ${fileName}`);
}

/** Remove a plugin file's document directory (the file was deleted). */
export async function removeFileDoc(dataDir: string, fileName: string): Promise<void> {
  await rm(kindDir(dataDir, "docs", fileName), { recursive: true, force: true });
  log.debug(`removed document for ${fileName}`);
}

/**
 * Every file (by repo-relative name) under one source folder that has a
 * document directory with at least one chunk — the doc-side counterpart of
 * walk(). The walk runs over the store's mirror of the folder and the names
 * come back with the source folder in front, the form the rest of the
 * server speaks.
 */
async function listDocs(dataDir: string, kind: DocKind, folder: string, suffix: string): Promise<string[]> {
  const rootDir = join(dataDir, AUTOMERGE_ROOT, storeFolderFor(folder));
  const found: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(rootDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.endsWith(suffix)) {
        if (await hasDoc(dataDir, kind, `${folder}/${path}`)) found.push(`${folder}/${path}`);
      } else {
        await visit(path);
      }
    }
  };
  await visit("");
  return found.sort();
}

/** Every feature that has a document — the doc side of features.ts walk(). */
export async function listFeatureDocs(dataDir: string): Promise<string[]> {
  return listDocs(dataDir, "features", "specs", ".feature.md");
}

/**
 * Every page of one special folder that has a document. `folder` scopes the
 * listing, so the roadmap's drift pass never sees the tasks' documents, nor
 * the other way round (specs/app/roadmap.feature.md, tasks.feature.md).
 */
export async function listPageDocs(dataDir: string, folder: string): Promise<string[]> {
  return listDocs(dataDir, "docs", folder, ".md");
}

/** Every file of a plugin's folder, by suffix, that has a document. */
export async function listFileDocs(dataDir: string, folder: string, suffix: string): Promise<string[]> {
  return listDocs(dataDir, "docs", folder, suffix);
}

/** Mint an empty feature document with a fresh identity. */
export function newFeatureDoc(init: Omit<FeatureDoc, "schemaVersion" | "id">): A.Doc<FeatureDoc> {
  return A.from<FeatureDoc>({
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    ...init,
  });
}

/** Mint an empty page document with a fresh identity. */
export function newPageDoc(init: Omit<PageDoc, "schemaVersion" | "id">): A.Doc<PageDoc> {
  return A.from<PageDoc>({
    schemaVersion: PAGE_SCHEMA_VERSION,
    id: randomUUID(),
    ...init,
  });
}

/**
 * Mint a plugin's document with a fresh identity: the plugin's own fields,
 * its schema version, and the `id` every peer shares through `docid`.
 */
export function newFileDoc<T extends Record<string, unknown>>(
  schemaVersion: number,
  init: T,
): A.Doc<T & { schemaVersion: number; id: string }> {
  return A.from<T & { schemaVersion: number; id: string }>({
    schemaVersion,
    id: randomUUID(),
    ...init,
  });
}

// The testing document's genesis is deterministic: the same actor id, the
// same zero timestamp, the same initial keys — so its first change hashes
// identically on every machine. A feature's identity is its unique file
// name, but there is exactly one testing document per repo, and two peers
// each using the module for the first time before either has pushed would
// otherwise mint two unrelated lineages. With a shared genesis their chunks
// merge on the next pull like any other concurrent edits.
export const TESTING_DOC_ID = "5f3c1a2e-7b4d-4c9a-9e1f-0d2b6c8a4e73";
const TESTING_GENESIS_ACTOR = "5da7a5e5d0c94e0e9d5e3a1b2c3d4e5f";

/** Mint the empty test management document — identical on every peer. */
export function newTestingDoc(): A.Doc<TestingDoc> {
  const empty = A.init<TestingDoc>({ actor: TESTING_GENESIS_ACTOR });
  const genesis = A.change(empty, { time: 0, message: "genesis" }, (d) => {
    d.schemaVersion = TESTING_SCHEMA_VERSION;
    d.id = TESTING_DOC_ID;
    d.cases = {};
    d.plans = {};
    d.executions = {};
  });
  // The shared actor id is for the genesis change only: every edit after it
  // must come from an actor of this peer's own, or two peers' first edits
  // would carry the same (actor, seq) and each would refuse the other's.
  // A clone keeps the heads and takes a fresh random actor.
  return A.clone(genesis);
}
