// The chunked Automerge store as an Effect service: load, create, save,
// compact, remove and list the documents of a data repo. The layout — where
// a document lives and what its chunks are called — is
// src/server/automerge/storeLayout.ts; this file is the reading and writing.
//
// What can go wrong is in each program's type: a file operation that fails
// (FileIoError), a document the caller's check refuses (DocumentRejected),
// a path that would leave the store (InvalidDocPath). What the store
// tolerates stays tolerated, on purpose: a directory that cannot be listed
// holds no chunks, and a chunk that cannot be read or applied is skipped,
// reported in `skippedChunks`, and logged — never fatal.
//
// src/server/automerge/store.ts is the Promise form of this service.

import * as A from "@automerge/automerge";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { join, resolve, sep } from "node:path";
import {
  AUTOMERGE_ROOT,
  COMPACT_AT,
  contentHash,
  isChunkName,
  isSafeDocDir,
  kindDir,
  storeFolderFor,
  type DocChunk,
  type DocKind,
  type DocSavedListener,
  type LoadedDoc,
  type RawLoadedDoc,
} from "../automerge/storeLayout";
import { getLogger } from "../telemetry";
import { DocumentRejected, InvalidDocPath, type FileIoError } from "./errors";
import * as Files from "./Files";
import { logged, traced } from "../effect/Tracing";

const log = getLogger("automerge");

/** How a load treats what the directory holds. */
export interface LoadOptions<T> {
  /**
   * Brings the merged document up to the current schema, or throws to refuse
   * it; the heads a load returns are the ones from before it ran, so its
   * changes ride whatever delta the caller saves next.
   */
  readonly migrate?: (doc: A.Doc<T>) => A.Doc<T>;
  /** Admits chunk files by name — one side of a merge. */
  readonly include?: (chunk: string) => boolean;
}

export interface DocStoreShape {
  /** True when the document's directory holds at least one chunk. */
  readonly has: (dataDir: string, kind: DocKind, fileName: string) => Effect.Effect<boolean>;
  /** Load a document by merging every chunk in its directory, or null when there is none yet. */
  readonly load: <T>(
    dataDir: string,
    kind: DocKind,
    fileName: string,
    options?: LoadOptions<T>,
  ) => Effect.Effect<LoadedDoc<T> | null, FileIoError | DocumentRejected>;
  /** Load a document exactly as its directory holds it: no schema check, no migration. */
  readonly loadRaw: (
    dataDir: string,
    dirRel: string,
  ) => Effect.Effect<RawLoadedDoc | null, FileIoError | InvalidDocPath>;
  /** Create a document directory from a fresh doc: a full snapshot plus the docid file. */
  readonly create: <T extends { id: string }>(
    dataDir: string,
    kind: DocKind,
    fileName: string,
    doc: A.Doc<T>,
  ) => Effect.Effect<LoadedDoc<T>, FileIoError>;
  /** Persist the changes made since `sinceHeads` as one chunk; a no-op delta writes nothing. */
  readonly save: <T>(
    dataDir: string,
    kind: DocKind,
    fileName: string,
    doc: A.Doc<T>,
    sinceHeads: A.Heads,
  ) => Effect.Effect<void, FileIoError | DocumentRejected>;
  /** Fold the chunks into one fresh snapshot once enough change files have piled up. */
  readonly compact: (
    dataDir: string,
    kind: DocKind,
    fileName: string,
  ) => Effect.Effect<void, FileIoError | DocumentRejected>;
  /** Remove a document's directory. */
  readonly remove: (dataDir: string, kind: DocKind, fileName: string) => Effect.Effect<void, FileIoError>;
  /** Every file under one source folder, by suffix, that has a document. */
  readonly list: (dataDir: string, kind: DocKind, folder: string, suffix: string) => Effect.Effect<string[]>;
  /** Every document directory under the store, relative to its root. */
  readonly listDirs: (dataDir: string) => Effect.Effect<string[]>;
  /** When a document's directory last changed — a chunk added or removed; 0 when it is not there. */
  readonly dirMtime: (dataDir: string, dirRel: string) => Effect.Effect<number>;
  /** Hear of every feature document that gains chunks on disk; the result stops listening. */
  readonly onSaved: (listener: DocSavedListener) => Effect.Effect<() => void>;
}

interface Chunks {
  snapshots: string[];
  changes: string[];
}

interface Merged<T> {
  doc: A.Doc<T> | null;
  skippedChunks: string[];
  chunks: DocChunk[];
}

/** The chunk files of a directory; one that cannot be listed holds none. */
const chunkFiles = (dir: string): Effect.Effect<Chunks, never, FileSystem> =>
  Files.listNames(dir).pipe(
    Effect.catch(() => Effect.succeed<string[]>([])),
    Effect.map((entries) => {
      // Sorted for deterministic application order across peers.
      entries.sort();
      return {
        snapshots: entries.filter((f) => f.startsWith("snapshot-") && f.endsWith(".bin")),
        changes: entries.filter((f) => f.startsWith("changes-") && f.endsWith(".bin")),
      };
    }),
  );

/** The document with one more chunk applied, or null when Automerge refuses the chunk. */
function applied<T>(doc: A.Doc<T> | null, bytes: Uint8Array): A.Doc<T> | null {
  try {
    return doc === null ? A.load<T>(bytes) : A.loadIncremental(doc, bytes);
  } catch {
    return null; // corrupt, or from a foreign lineage
  }
}

/** Merge the named chunk files in order; an unreadable or refused chunk is skipped, not fatal. */
const mergeChunks = <T>(dir: string, files: string[]): Effect.Effect<Merged<T>, never, FileSystem> =>
  Effect.gen(function* () {
    let doc: A.Doc<T> | null = null;
    const skippedChunks: string[] = [];
    const chunks: DocChunk[] = [];
    for (const file of files) {
      const kind = file.startsWith("snapshot-") ? "snapshot" : "changes";
      const bytes = yield* Files.readBytes(join(dir, file)).pipe(Effect.catch(() => Effect.succeed(null)));
      if (bytes === null) {
        skippedChunks.push(file);
        chunks.push({ file, kind, bytes: 0, applied: false });
        continue;
      }
      const next: A.Doc<T> | null = applied(doc, bytes);
      if (next === null) skippedChunks.push(file);
      else doc = next;
      chunks.push({ file, kind, bytes: bytes.byteLength, applied: next !== null });
    }
    return { doc, skippedChunks, chunks };
  });

/** The identity every peer shares: the `docid` file, else the document's own id. */
const docIdOf = (dir: string, doc: A.Doc<unknown>): Files.FileEffect<string> =>
  Effect.map(
    Files.readText(join(dir, "docid")),
    (text) => text?.trim() ?? (doc as { id?: string }).id ?? "",
  );

const has = (dataDir: string, kind: DocKind, fileName: string): Effect.Effect<boolean, never, FileSystem> =>
  Effect.map(
    chunkFiles(kindDir(dataDir, kind, fileName)),
    ({ snapshots, changes }) => snapshots.length > 0 || changes.length > 0,
  );

const load = <T>(
  dataDir: string,
  kind: DocKind,
  fileName: string,
  options: LoadOptions<T> = {},
): Effect.Effect<LoadedDoc<T> | null, FileIoError | DocumentRejected, FileSystem> =>
  Effect.gen(function* () {
    const { migrate, include = () => true } = options;
    const dir = kindDir(dataDir, kind, fileName);
    const all = yield* chunkFiles(dir);
    const snapshots = all.snapshots.filter(include);
    const changes = all.changes.filter(include);
    if (snapshots.length === 0 && changes.length === 0) return null;

    const { doc, skippedChunks } = yield* mergeChunks<T>(dir, [...snapshots, ...changes]);
    if (doc === null) return null;

    if (skippedChunks.length > 0) {
      // Skipping is deliberately non-fatal, but it must not be invisible: a
      // chunk that never loads anywhere means edits living only in that chunk
      // are not reaching this peer.
      yield* logged(() =>
        log.warn(`skipped ${skippedChunks.length} unreadable chunk(s) for ${fileName}`, {
          "specdriven.file": fileName,
          "automerge.skipped_chunks": skippedChunks.join(","),
        }),
      );
    }
    const docId = yield* docIdOf(dir, doc);
    // Heads are captured before the schema migration on purpose — see LoadOptions.
    const heads = A.getHeads(doc);
    const current = migrate
      ? yield* Effect.try({
          try: () => migrate(doc),
          catch: (cause) => new DocumentRejected({ fileName, cause }),
        })
      : doc;
    return { doc: current, heads, docId, skippedChunks };
  });

const loadRaw = (
  dataDir: string,
  dirRel: string,
): Effect.Effect<RawLoadedDoc | null, FileIoError | InvalidDocPath, FileSystem> =>
  Effect.gen(function* () {
    if (!isSafeDocDir(dirRel)) return yield* new InvalidDocPath({ dirRel });
    const rootDir = resolve(dataDir, AUTOMERGE_ROOT);
    const dir = resolve(rootDir, dirRel);
    if (!dir.startsWith(rootDir + sep)) return yield* new InvalidDocPath({ dirRel });
    const { snapshots, changes } = yield* chunkFiles(dir);
    if (snapshots.length === 0 && changes.length === 0) return null;

    const { doc, skippedChunks, chunks } = yield* mergeChunks<unknown>(dir, [...snapshots, ...changes]);
    if (doc === null) return null;
    const docId = yield* docIdOf(dir, doc);
    return { doc, heads: A.getHeads(doc), docId, skippedChunks, dirRel, chunks };
  });

const compact = (
  dataDir: string,
  kind: DocKind,
  fileName: string,
): Effect.Effect<void, FileIoError | DocumentRejected, FileSystem> =>
  Effect.gen(function* () {
    const dir = kindDir(dataDir, kind, fileName);
    const { snapshots, changes } = yield* chunkFiles(dir);
    if (changes.length < COMPACT_AT) return;
    yield* traced(
      "automerge.compact_doc",
      { "specdriven.file": fileName, "automerge.change_chunks": changes.length },
      () =>
        Effect.gen(function* () {
          const loaded = yield* load<unknown>(dataDir, kind, fileName);
          if (loaded === null) return;
          const bytes = A.save(loaded.doc);
          const name = `snapshot-${contentHash(bytes)}.bin`;
          yield* Files.writeBytes(join(dir, name), bytes);
          const skipped = new Set(loaded.skippedChunks);
          for (const file of [...snapshots, ...changes]) {
            // Only chunks that actually loaded are covered by the new snapshot.
            if (file !== name && !skipped.has(file)) yield* Files.removeFile(join(dir, file));
          }
          yield* logged(() =>
            log.debug(`compacted ${changes.length} change chunk(s) into a snapshot for ${fileName}`, {
              "automerge.snapshot_bytes": bytes.length,
            }),
          );
        }),
    );
  });

const remove = (dataDir: string, kind: DocKind, fileName: string): Files.FileEffect<void> =>
  Effect.andThen(
    Files.removeTree(kindDir(dataDir, kind, fileName)),
    logged(() => log.debug(`removed document for ${fileName}`)),
  );

/** The entries of a directory; one that cannot be listed has none. */
const entriesOf = (path: string): Effect.Effect<Files.Entry[], never, FileSystem> =>
  Files.listEntries(path).pipe(Effect.catch(() => Effect.succeed<Files.Entry[]>([])));

const list = (
  dataDir: string,
  kind: DocKind,
  folder: string,
  suffix: string,
): Effect.Effect<string[], never, FileSystem> =>
  Effect.gen(function* () {
    const rootDir = join(dataDir, AUTOMERGE_ROOT, storeFolderFor(folder));
    const found: string[] = [];
    const visit = (rel: string): Effect.Effect<void, never, FileSystem> =>
      Effect.gen(function* () {
        for (const entry of yield* entriesOf(join(rootDir, rel))) {
          if (!entry.isDirectory) continue;
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.name.endsWith(suffix)) {
            if (yield* has(dataDir, kind, `${folder}/${path}`)) found.push(`${folder}/${path}`);
          } else {
            yield* visit(path);
          }
        }
      });
    yield* visit("");
    return found.sort();
  });

const listDirs = (dataDir: string): Effect.Effect<string[], never, FileSystem> =>
  Effect.gen(function* () {
    const rootDir = join(dataDir, AUTOMERGE_ROOT);
    const found: string[] = [];
    const visit = (rel: string): Effect.Effect<void, never, FileSystem> =>
      Effect.gen(function* () {
        const entries = yield* entriesOf(join(rootDir, rel));
        // A directory is a document when it holds a `docid` or a chunk; the
        // walk never descends into one.
        if (rel && entries.some((e) => e.isFile && (e.name === "docid" || isChunkName(e.name)))) {
          found.push(rel);
          return;
        }
        for (const entry of entries) {
          if (!entry.isDirectory) continue;
          yield* visit(rel ? `${rel}/${entry.name}` : entry.name);
        }
      });
    yield* visit("");
    return found.sort();
  });

const make = Effect.gen(function* () {
  const fs = yield* Effect.service(FileSystem);
  /** The programs above need a file system; the service has this one. */
  const onFs = <A, E>(effect: Effect.Effect<A, E, FileSystem>): Effect.Effect<A, E> =>
    Effect.provideService(effect, FileSystem, fs);

  const listeners = new Set<DocSavedListener>();
  const emitSaved = (dataDir: string, fileName: string): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const listener of listeners) listener(dataDir, fileName);
    });

  const create = <T extends { id: string }>(
    dataDir: string,
    kind: DocKind,
    fileName: string,
    doc: A.Doc<T>,
  ): Effect.Effect<LoadedDoc<T>, FileIoError, FileSystem> =>
    traced("automerge.create_doc", { "specdriven.file": fileName }, (span) =>
      Effect.gen(function* () {
        const dir = kindDir(dataDir, kind, fileName);
        yield* Files.makeDirectories(dir);
        const bytes = A.save(doc);
        yield* Files.writeBytes(join(dir, `snapshot-${contentHash(bytes)}.bin`), bytes);
        const docId = doc.id;
        yield* Files.writeString(join(dir, "docid"), `${docId}\n`);
        span.setAttributes({ "automerge.doc_id": docId, "automerge.snapshot_bytes": bytes.length });
        yield* logged(() => log.debug(`created document for ${fileName}`, { "automerge.doc_id": docId }));
        if (kind === "features") yield* emitSaved(dataDir, fileName);
        return { doc, heads: A.getHeads(doc), docId, skippedChunks: [] };
      }),
    );

  const save = <T>(
    dataDir: string,
    kind: DocKind,
    fileName: string,
    doc: A.Doc<T>,
    sinceHeads: A.Heads,
  ): Effect.Effect<void, FileIoError | DocumentRejected, FileSystem> =>
    Effect.suspend(() => {
      const dir = kindDir(dataDir, kind, fileName);
      const delta = A.saveSince(doc, sinceHeads);
      if (delta.length === 0) return Effect.void;
      return traced(
        "automerge.save_doc",
        { "specdriven.file": fileName, "automerge.delta_bytes": delta.length },
        () =>
          Effect.gen(function* () {
            yield* Files.makeDirectories(dir);
            yield* Files.writeBytes(join(dir, `changes-${contentHash(delta)}.bin`), delta);
            yield* logged(() =>
              log.debug(`saved incremental chunk for ${fileName}`, {
                "automerge.delta_bytes": delta.length,
              }),
            );
            yield* compact(dataDir, kind, fileName);
            if (kind === "features") yield* emitSaved(dataDir, fileName);
          }),
      );
    });

  return DocStore.of({
    has: (dataDir, kind, fileName) => onFs(has(dataDir, kind, fileName)),
    load: (dataDir, kind, fileName, options) => onFs(load(dataDir, kind, fileName, options)),
    loadRaw: (dataDir, dirRel) => onFs(loadRaw(dataDir, dirRel)),
    create: (dataDir, kind, fileName, doc) => onFs(create(dataDir, kind, fileName, doc)),
    save: (dataDir, kind, fileName, doc, sinceHeads) => onFs(save(dataDir, kind, fileName, doc, sinceHeads)),
    compact: (dataDir, kind, fileName) => onFs(compact(dataDir, kind, fileName)),
    remove: (dataDir, kind, fileName) => onFs(remove(dataDir, kind, fileName)),
    list: (dataDir, kind, folder, suffix) => onFs(list(dataDir, kind, folder, suffix)),
    listDirs: (dataDir) => onFs(listDirs(dataDir)),
    dirMtime: (dataDir, dirRel) => onFs(Files.modifiedMs(join(dataDir, AUTOMERGE_ROOT, dirRel))),
    onSaved: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
  });
});

/** The document store of the data repos this process has open. */
export class DocStore extends Context.Service<DocStore, DocStoreShape>()("specdriven/persistence/DocStore") {
  /** The store on whatever file system the context provides. */
  static readonly layer = Layer.effect(this, make);
}
