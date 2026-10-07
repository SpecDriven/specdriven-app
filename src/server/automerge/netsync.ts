// Optional near-real-time sync of the feature documents over websocket —
// an accelerator on top of the git transport, never a replacement for it.
// When a sync server url is set in Settings (e.g. wss://sync.automerge.org),
// every feature document is announced under an identity all peers derive
// from its docid, local saves stream out as CRDT operations, and remote
// operations merge into the chunk store and rewrite the markdown projection.
// The next cron tick commits what arrived, so git remains the source of
// record and double delivery (websocket and git) is harmless — merging the
// same operations twice is a no-op.
//
// Privacy: a public sync server can hand any document to anyone who has its
// id, and the docid files are visible to everyone with read access to the
// data repo. The setting is off by default and opt-in per user.

import * as A from "@automerge/automerge";
import {
  Repo,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo";
import type {
  BinaryDocumentId,
  DocHandle,
  DocumentId,
  NetworkAdapterInterface,
} from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "../fsx";
import { featureTextError } from "../parser";
import { absorbDrift } from "./driftSync";
import { isProjectionOf, projectFeature } from "./project";
import type { FeatureDoc } from "./schema";
import { docDir, listFeatureDocs, loadFeatureDoc, onDocSaved, saveFeatureDoc } from "./store";
import { errorAttributes, getLogger, withSpan } from "../telemetry";

const log = getLogger("netsync");

/**
 * The automerge-repo DocumentId every peer derives from a feature document's
 * uuid (the docid file): the uuid's 16 bytes, bs58check-encoded. Derived, not
 * minted, so peers agree without coordination.
 */
export function documentIdForDoc(uuid: string): DocumentId {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Not a document uuid: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const url = stringifyAutomergeUrl(bytes as BinaryDocumentId);
  return parseAutomergeUrl(url).documentId;
}

export interface NetSync {
  /** Resolves once no announce or absorb is in flight. */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/** One feature document as shared on a {@link SyncTransport}. */
export interface SharedDoc {
  /** Merge local state into the shared copy; peers receive the new operations. */
  push(doc: A.Doc<FeatureDoc>): void;
}

/**
 * Where the bridge shares documents. Production wraps an automerge-repo Repo
 * ({@link repoTransport}); tests can pass a double whose delivery they
 * control (tests/helpers/fakeSyncServer.ts), since the Repo throttles its
 * sync messages on a timer.
 */
export interface SyncTransport {
  /**
   * Share a document. `onChange` gets the shared copy after every change to
   * it, local pushes included, and resolves once the bridge has absorbed it.
   */
  share(
    docId: DocumentId,
    doc: A.Doc<FeatureDoc>,
    onChange: (doc: A.Doc<FeatureDoc>) => Promise<void>,
  ): SharedDoc;
  shutdown(): Promise<void>;
}

/** The automerge-repo transport, over the given network adapters. */
export function repoTransport(adapters: NetworkAdapterInterface[]): SyncTransport {
  const repo = new Repo({ network: adapters });
  const handles: DocHandle<FeatureDoc>[] = [];
  return {
    share(docId, doc, onChange) {
      const handle = repo.import<FeatureDoc>(A.save(doc), { docId });
      handles.push(handle);
      handle.on("change", ({ doc }) => {
        if (doc !== undefined) void onChange(doc);
      });
      return { push: (local) => handle.update((d) => A.merge(d, A.clone(local))) };
    },
    async shutdown() {
      for (const handle of handles) handle.removeAllListeners("change");
      await repo.shutdown();
    },
  };
}

/** Start the bridge against wss://… — the production entry point. */
export async function startNetSyncClient(dataDir: string, serverUrl: string): Promise<NetSync> {
  return startNetSync(dataDir, repoTransport([new WebSocketClientAdapter(serverUrl)]));
}

/** Start the bridge over an explicit transport (tests use a loopback or a double). */
export async function startNetSync(
  dataDir: string,
  transport: SyncTransport,
): Promise<NetSync> {
  const shared = new Map<DocumentId, SharedDoc>();
  const fileNames = new Map<DocumentId, string>();
  /** Files the bridge itself is writing, so its own saves don't loop. */
  const writing = new Set<string>();
  /** Announces and absorbs not yet finished — what idle() waits for. */
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  /** Track work that never rejects, so idle() and stop() can wait for it. */
  function track(work: Promise<void>): Promise<void> {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  }

  async function idle(): Promise<void> {
    while (inFlight.size > 0) await Promise.all(inFlight);
  }

  /** The feature currently owning a document, resilient to moves/renames. */
  async function fileNameFor(docId: DocumentId): Promise<string | null> {
    const known = fileNames.get(docId);
    if (known) {
      const uuid = await uuidOf(known);
      if (uuid && documentIdForDoc(uuid) === docId) return known;
    }
    for (const fileName of await listFeatureDocs(dataDir)) {
      const uuid = await uuidOf(fileName);
      if (uuid && documentIdForDoc(uuid) === docId) {
        fileNames.set(docId, fileName);
        return fileName;
      }
    }
    return null;
  }

  async function uuidOf(fileName: string): Promise<string | null> {
    const text = await readTextFile(join(docDir(dataDir, fileName), "docid"));
    const uuid = text?.trim();
    return uuid && /^[0-9a-fA-F-]{36}$/.test(uuid) ? uuid : null;
  }

  /** Remote operations land in the chunk store and the markdown projection. */
  async function absorbRemote(docId: DocumentId, networkDoc: A.Doc<FeatureDoc>): Promise<void> {
    const fileName = await fileNameFor(docId);
    if (fileName === null || writing.has(fileName)) return;
    const disk = await loadFeatureDoc(dataDir, fileName);
    if (disk === null) return;
    // The projection is about to be written over the file, so a local disk
    // edit the sync tick has not absorbed yet is folded in first — the same
    // rule absorbIntoDoc uses. Without it a peer's save would drop the edit
    // from the file, the document and git, and importDrift would then skip
    // the file (it is a projection again) so the loss is permanent.
    let localDoc = disk.doc;
    let absorbedLocal = false;
    const fileText = await readTextFile(join(dataDir, fileName));
    if (fileText !== null) {
      const problem = featureTextError(fileText);
      if (problem !== null) {
        log.warn(
          `not absorbing remote operations into ${fileName}: it no longer parses (${problem})`,
        );
        return;
      }
      if (!isProjectionOf(fileText, localDoc)) {
        const drifted = absorbDrift(localDoc, fileText);
        if (drifted.refused === undefined) {
          localDoc = drifted.doc;
          absorbedLocal = true;
          log.info(`absorbed a local disk edit of ${fileName} before applying remote operations`);
        } else {
          log.warn(
            `refused local drift on ${fileName}; remote operations will repair it`,
            errorAttributes(drifted.refused),
          );
        }
      }
    }
    const merged = A.merge(A.clone(localDoc), A.clone(networkDoc));
    if (A.getHeads(merged).join() === disk.heads.join()) return; // nothing new
    await withSpan("netsync.absorb_remote", { "specdriven.file": fileName }, async () => {
      writing.add(fileName);
      try {
        await saveFeatureDoc(dataDir, fileName, merged, disk.heads);
        await writeTextFile(join(dataDir, fileName), projectFeature(merged));
        log.info(`absorbed remote operations into ${fileName}`);
      } finally {
        writing.delete(fileName);
      }
    });
    // The save above is muted (writing), so the local disk edit it absorbed
    // would otherwise reach peers only through git: hand it to the network.
    // The change this fires here finds nothing new.
    if (absorbedLocal) shared.get(docId)?.push(merged);
  }

  /** Announce a feature's document, or push its latest disk state. */
  async function attach(fileName: string): Promise<void> {
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) return;
    let docId: DocumentId;
    try {
      // The docid *file* is the identity peers share via git; the doc's own
      // id field only differs transiently during a lineage race, which the
      // drift pass resolves.
      docId = documentIdForDoc(loaded.docId);
    } catch {
      // Corrupt docid file — git sync still works, network sync waits.
      log.warn(`not announcing ${fileName}: its docid file is not a document uuid`);
      return;
    }
    fileNames.set(docId, fileName);
    const existing = shared.get(docId);
    if (existing) {
      log.debug(`pushed local state of ${fileName} to the sync server`);
      existing.push(loaded.doc);
      return;
    }
    log.debug(`announced ${fileName} to the sync server`, { "automerge.doc_id": loaded.docId });
    const doc = transport.share(docId, loaded.doc, (networkDoc) => {
      if (stopped) return Promise.resolve();
      return track(
        absorbRemote(docId, networkDoc).catch((e) => {
          // A failed absorb is not fatal: git delivers the same operations.
          log.warn(`failed to absorb remote operations`, errorAttributes(e));
        }),
      );
    });
    shared.set(docId, doc);
  }

  const unsubscribe = onDocSaved((dir, fileName) => {
    if (dir !== dataDir || writing.has(fileName)) return;
    void track(
      attach(fileName).catch((e) => {
        log.warn(`failed to announce ${fileName} after a save`, errorAttributes(e));
      }),
    );
  });

  return withSpan("netsync.start", { "specdriven.dir": dataDir }, async (span) => {
    const fileList = await listFeatureDocs(dataDir);
    for (const fileName of fileList) {
      await attach(fileName);
    }
    span.setAttribute("netsync.documents", fileList.length);
    log.info(`bridging ${fileList.length} feature document(s)`);

    return {
      idle,
      async stop() {
        stopped = true;
        unsubscribe();
        // Let a running absorb finish its write rather than land after stop.
        await idle();
        shared.clear();
        await transport.shutdown();
        log.info("stopped");
      },
    };
  });
}
