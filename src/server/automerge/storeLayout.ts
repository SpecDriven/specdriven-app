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
//
// This file is the layout itself and nothing else: where a document lives,
// what its chunk files are called, the shapes a load returns, and how fresh
// documents are minted. It reads and writes nothing, so everything may import
// it — the store's programs (src/server/persistence/DocStore.ts) and their
// Promise forms (store.ts, which re-exports all of this).


import * as A from "@automerge/automerge";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
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

/** Change files tolerated before the next save folds them into a snapshot. */
export const COMPACT_AT = 12;

/**
 * Fired after a document gains chunks on disk (created, saved, or absorbed
 * from a pull). The optional network sync bridge (netsync.ts) listens so a
 * local edit reaches websocket peers without polling.
 */
export type DocSavedListener = (dataDir: string, fileName: string) => void;

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
export function migrated(doc: A.Doc<FeatureDoc>): A.Doc<FeatureDoc> {
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

/** The directory of a document of one kind. */
export function kindDir(dataDir: string, kind: DocKind, fileName: string): string {
  return join(dataDir, kind === "testing" ? testingDocDirRel() : dirRel(fileName));
}

/** The name a chunk's content gives it: chunk files are content-addressed. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** One chunk file of a document directory, as the data viewer lists it. */
export interface DocChunk {
  file: string;
  kind: "snapshot" | "changes";
  bytes: number;
  /** False when the chunk was unreadable or from a foreign lineage. */
  applied: boolean;
}

/** A document as its directory holds it — no schema check, no migration. */
export interface RawLoadedDoc extends LoadedDoc<unknown> {
  /** The document's directory, relative to AUTOMERGE_ROOT. */
  dirRel: string;
  chunks: DocChunk[];
}

/** True for the name of a chunk file, snapshot or changes. */
export function isChunkName(name: string): boolean {
  return (name.startsWith("snapshot-") || name.startsWith("changes-")) && name.endsWith(".bin");
}

/**
 * A store-relative document directory that stays inside the store: no empty
 * or dot-led segment, no `..`, no backslash, not absolute (the rule of
 * features.ts badSegment).
 */
export function isSafeDocDir(dirRel: string): boolean {
  if (!dirRel || isAbsolute(dirRel) || dirRel.includes("\\")) return false;
  return dirRel.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

/**
 * The data repo file a store directory mirrors — the inverse of DOC_FOLDERS
 * (`event-models/p.model.json` → `models/p.model.json`); null for the test
 * management document, which has no file.
 */
export function sourceFileOf(dirRel: string): string | null {
  if (dirRel === `${TESTING_FOLDER}/${TESTING_DOC_NAME}`) return null;
  const { folder, rest } = splitFolder(dirRel);
  if (!folder) return null;
  const source = Object.entries(DOC_FOLDERS).find(([, store]) => store === folder)?.[0] ?? folder;
  return `${source}/${rest}`;
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
