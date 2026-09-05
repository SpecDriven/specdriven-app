// Chunked Automerge storage inside the data repo, synced by git alongside the
// markdown projections. One directory per document under
// `.specdriven/automerge/<kind>/<fileName>/` — `features` for the
// `.feature.md` documents, `docs` for the special folders' plain markdown
// pages — the roadmap's and the tasks' (specs/app/roadmap.feature.md,
// specs/app/tasks.feature.md):
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
  type FeatureDoc,
  type PageDoc,
  type SpecEntry,
  type SpecType,
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
 * The kinds of document the store holds, each under its own directory:
 * `features` for the `.feature.md` documents, `docs` for the plain markdown
 * pages of the special folders — the roadmap's (specs/app/roadmap.feature.md)
 * and the tasks' (specs/app/tasks.feature.md). Inside either, the path is the
 * file's repo-relative name, so the folder in that path is what tells one
 * kind of page from the other.
 */
export type DocKind = "features" | "docs";

function dirRel(kind: DocKind, fileName: string): string {
  return `.specdriven/automerge/${kind}/${fileName}`;
}

/** Repo-relative path of a feature's doc directory, for git pathspecs. */
export function docDirRel(fileName: string): string {
  return dirRel("features", fileName);
}

/** Repo-relative path of a page's doc directory, for git pathspecs. */
export function pageDocDirRel(fileName: string): string {
  return dirRel("docs", fileName);
}

export function docDir(dataDir: string, fileName: string): string {
  return join(dataDir, docDirRel(fileName));
}

function kindDir(dataDir: string, kind: DocKind, fileName: string): string {
  return join(dataDir, dirRel(kind, fileName));
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
): Promise<LoadedDoc<T> | null> {
  const dir = kindDir(dataDir, kind, fileName);
  const { snapshots, changes } = await chunkFiles(dir);
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

/** Load a page's document (specs/app/roadmap.feature.md, tasks.feature.md). */
export async function loadPageDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc<PageDoc> | null> {
  return loadDoc<PageDoc>(dataDir, "docs", fileName);
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

/**
 * Every file (by repo-relative name) of this kind that has a document
 * directory with at least one chunk — the doc-side counterpart of walk().
 */
async function listDocs(dataDir: string, kind: DocKind, suffix: string): Promise<string[]> {
  const rootDir = join(dataDir, ".specdriven", "automerge", kind);
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
        if (await hasDoc(dataDir, kind, path)) found.push(path);
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
  return listDocs(dataDir, "features", ".feature.md");
}

/**
 * Every page of one special folder that has a document. `folder` scopes the
 * listing, so the roadmap's drift pass never sees the tasks' documents, nor
 * the other way round (specs/app/roadmap.feature.md, tasks.feature.md).
 */
export async function listPageDocs(dataDir: string, folder: string): Promise<string[]> {
  const docs = await listDocs(dataDir, "docs", ".md");
  return docs.filter((fileName) => fileName.startsWith(`${folder}/`));
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
