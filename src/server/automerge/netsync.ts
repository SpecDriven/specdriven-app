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
import { projectFeature } from "./project";
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
  stop(): Promise<void>;
}

/** Start the bridge against wss://… — the production entry point. */
export async function startNetSyncClient(dataDir: string, serverUrl: string): Promise<NetSync> {
  return startNetSync(dataDir, [new WebSocketClientAdapter(serverUrl)]);
}

/** Start the bridge with explicit network adapters (tests use a loopback). */
export async function startNetSync(
  dataDir: string,
  adapters: NetworkAdapterInterface[],
): Promise<NetSync> {
  const repo = new Repo({ network: adapters });
  const handles = new Map<DocumentId, DocHandle<FeatureDoc>>();
  const fileNames = new Map<DocumentId, string>();
  /** Files the bridge itself is writing, so its own saves don't loop. */
  const writing = new Set<string>();

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
    const merged = A.merge(A.clone(disk.doc), A.clone(networkDoc));
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
    const existing = handles.get(docId);
    if (existing) {
      log.debug(`pushed local state of ${fileName} to the sync server`);
      existing.update((d) => A.merge(d, A.clone(loaded.doc)));
      return;
    }
    log.debug(`announced ${fileName} to the sync server`, { "automerge.doc_id": loaded.docId });
    const handle = repo.import<FeatureDoc>(A.save(loaded.doc), { docId });
    handles.set(docId, handle);
    handle.on("change", ({ doc }) => {
      if (doc === undefined) return;
      void absorbRemote(docId, doc).catch((e) => {
        // A failed absorb is not fatal: git delivers the same operations.
        log.warn(`failed to absorb remote operations`, errorAttributes(e));
      });
    });
  }

  const unsubscribe = onDocSaved((dir, fileName) => {
    if (dir !== dataDir || writing.has(fileName)) return;
    void attach(fileName).catch((e) => {
      log.warn(`failed to announce ${fileName} after a save`, errorAttributes(e));
    });
  });

  return withSpan("netsync.start", { "specdriven.dir": dataDir }, async (span) => {
    const fileList = await listFeatureDocs(dataDir);
    for (const fileName of fileList) {
      await attach(fileName);
    }
    span.setAttribute("netsync.documents", fileList.length);
    log.info(`bridging ${fileList.length} feature document(s)`);

    return {
      async stop() {
        unsubscribe();
        for (const handle of handles.values()) handle.removeAllListeners("change");
        handles.clear();
        await repo.shutdown();
        log.info("stopped");
      },
    };
  });
}
