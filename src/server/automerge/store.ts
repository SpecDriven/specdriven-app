// Chunked Automerge storage inside the data repo, synced by git alongside the
// markdown projections. One directory per feature under
// `.specdriven/automerge/features/<fileName>/`:
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
import { SCHEMA_VERSION, type FeatureDoc, type ScenarioEntry } from "./schema";

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

export interface LoadedDoc {
  doc: A.Doc<FeatureDoc>;
  /** Heads as loaded — pass to saveFeatureDoc so it writes only the delta. */
  heads: A.Heads;
  docId: string;
  /** Chunk files that could not be applied (foreign lineage or corrupt). */
  skippedChunks: string[];
}

/** A v1 scenario entry: statuses as booleans instead of the status field. */
type LegacyScenarioEntry = ScenarioEntry & { published?: boolean; proposed?: boolean };

/**
 * Fold a v1 document's `published`/`proposed` booleans into `status`
 * (schema v2). Applied on load; the heads returned by loadFeatureDoc are the
 * pre-migration heads, so the migration ops ride whatever delta the caller
 * saves next — a load that never saves just migrates again next time.
 */
function migrated(doc: A.Doc<FeatureDoc>): A.Doc<FeatureDoc> {
  const entries = doc.scenarios as LegacyScenarioEntry[];
  const stale =
    doc.schemaVersion < SCHEMA_VERSION || entries.some((s) => s.status === undefined);
  if (!stale) return doc;
  return A.change(doc, (d) => {
    if (d.schemaVersion < SCHEMA_VERSION) d.schemaVersion = SCHEMA_VERSION;
    for (const entry of d.scenarios as LegacyScenarioEntry[]) {
      if (entry.status === undefined) {
        entry.status = entry.published ? "published" : entry.proposed ? "proposed" : "draft";
        delete entry.published;
        delete entry.proposed;
      }
    }
  });
}

/** Repo-relative path of a feature's doc directory, for git pathspecs. */
export function docDirRel(fileName: string): string {
  return `.specdriven/automerge/features/${fileName}`;
}

export function docDir(dataDir: string, fileName: string): string {
  return join(dataDir, docDirRel(fileName));
}

/** True when the feature has a doc directory with at least one chunk. */
export async function hasFeatureDoc(dataDir: string, fileName: string): Promise<boolean> {
  const { snapshots, changes } = await chunkFiles(docDir(dataDir, fileName));
  return snapshots.length > 0 || changes.length > 0;
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
 * Load a feature's document by merging every chunk in its directory, or null
 * when the feature has no document yet (pre-migration repo, or a plain-md
 * write from an older app version).
 */
export async function loadFeatureDoc(
  dataDir: string,
  fileName: string,
): Promise<LoadedDoc | null> {
  const dir = docDir(dataDir, fileName);
  const { snapshots, changes } = await chunkFiles(dir);
  if (snapshots.length === 0 && changes.length === 0) return null;

  let doc: A.Doc<FeatureDoc> | null = null;
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
      doc = doc === null ? A.load<FeatureDoc>(bytes) : A.loadIncremental(doc, bytes);
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
  const docId = (await readTextFile(join(dir, "docid")))?.trim() ?? doc.id;
  // Heads are captured before the schema migration on purpose — see migrated.
  const heads = A.getHeads(doc);
  return { doc: migrated(doc), heads, docId, skippedChunks };
}

/**
 * Create a feature's document directory from a fresh doc: full snapshot plus
 * the docid file that gives every peer the same identity for network sync.
 */
export async function createFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
): Promise<LoadedDoc> {
  return withSpan("automerge.create_doc", { "specdriven.file": fileName }, async (span) => {
    const dir = docDir(dataDir, fileName);
    await mkdir(dir, { recursive: true });
    const bytes = A.save(doc);
    await writeFile(join(dir, `snapshot-${contentHash(bytes)}.bin`), bytes);
    const docId = doc.id;
    await writeFile(join(dir, "docid"), `${docId}\n`);
    span.setAttributes({ "automerge.doc_id": docId, "automerge.snapshot_bytes": bytes.length });
    log.debug(`created document for ${fileName}`, { "automerge.doc_id": docId });
    emitDocSaved(dataDir, fileName);
    return { doc, heads: A.getHeads(doc), docId, skippedChunks: [] };
  });
}

/**
 * Persist changes made since `sinceHeads` (the heads returned by
 * loadFeatureDoc) as one incremental chunk, folding everything into a fresh
 * snapshot once enough change files pile up. A no-op delta writes nothing.
 */
export async function saveFeatureDoc(
  dataDir: string,
  fileName: string,
  doc: A.Doc<FeatureDoc>,
  sinceHeads: A.Heads,
): Promise<void> {
  const dir = docDir(dataDir, fileName);
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
      await compactFeatureDoc(dataDir, fileName);
      emitDocSaved(dataDir, fileName);
    },
  );
}

/**
 * Fold snapshots and change files into a single fresh snapshot when the
 * directory has grown past COMPACT_AT change files. Old chunks are deleted
 * from the working tree; two peers compacting concurrently just leave two
 * snapshots for the next load to merge.
 */
export async function compactFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  const dir = docDir(dataDir, fileName);
  const { snapshots, changes } = await chunkFiles(dir);
  if (changes.length < COMPACT_AT) return;
  await withSpan(
    "automerge.compact_doc",
    { "specdriven.file": fileName, "automerge.change_chunks": changes.length },
    async () => {
      const loaded = await loadFeatureDoc(dataDir, fileName);
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

/** Remove a feature's document directory (feature deleted). */
export async function removeFeatureDoc(dataDir: string, fileName: string): Promise<void> {
  await rm(docDir(dataDir, fileName), { recursive: true, force: true });
  log.debug(`removed document for ${fileName}`);
}

/**
 * Every feature (by repo-relative file name) that has a document directory
 * with at least one chunk — the doc-side counterpart of features.ts walk().
 */
export async function listFeatureDocs(dataDir: string): Promise<string[]> {
  const rootDir = join(dataDir, ".specdriven", "automerge", "features");
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
      if (entry.name.endsWith(".feature.md")) {
        if (await hasFeatureDoc(dataDir, path)) found.push(path);
      } else {
        await visit(path);
      }
    }
  };
  await visit("");
  return found.sort();
}

/** Mint an empty feature document with a fresh identity. */
export function newFeatureDoc(init: Omit<FeatureDoc, "schemaVersion" | "id">): A.Doc<FeatureDoc> {
  return A.from<FeatureDoc>({
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    ...init,
  });
}
