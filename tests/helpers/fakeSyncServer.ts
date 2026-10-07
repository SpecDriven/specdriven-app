// A test double for the websocket sync server netsync talks to
// (src/server/automerge/netsync.ts). The real transport, an automerge-repo
// Repo, throttles its sync messages on a 100ms timer, so a test on it can
// only poll for an edit to arrive. This fake keeps one shared copy per
// document, merges every push into it and fans the result out to the other
// peers on microtasks, and records each push. settle() resolves once nothing
// is left to deliver or absorb: no timers, no deadlines, no polling.

import * as A from "@automerge/automerge";
import type { DocumentId } from "@automerge/automerge-repo";
import type { NetSync, SharedDoc, SyncTransport } from "../../src/server/automerge/netsync";
import type { FeatureDoc } from "../../src/server/automerge/schema";

type Doc = A.Doc<FeatureDoc>;

interface PeerCopy {
  peer: string;
  doc: Doc;
  onChange: (doc: Doc) => Promise<void>;
}

export interface Push {
  peer: string;
  docId: DocumentId;
  doc: Doc;
}

const sameHeads = (x: Doc, y: Doc) => A.getHeads(x).join() === A.getHeads(y).join();

export class FakeSyncServer {
  /** What the server holds for each document. */
  readonly #docs = new Map<DocumentId, Doc>();
  readonly #copies = new Map<DocumentId, PeerCopy[]>();
  readonly #deliveries = new Set<Promise<void>>();
  #peerCount = 0;
  /** Every push a peer made, in order — a spy for assertions. */
  readonly pushes: Push[] = [];

  /** A transport for one peer, named for the pushes it records. */
  transport(peer = `peer-${++this.#peerCount}`): SyncTransport {
    return {
      share: (docId, doc, onChange): SharedDoc => {
        const copy: PeerCopy = { peer, doc: A.clone(doc), onChange };
        this.#copies.set(docId, [...(this.#copies.get(docId) ?? []), copy]);
        // Like a handle joining the server: the server learns what the peer
        // has, and the peer gets what the server had.
        this.#receive(peer, docId, copy.doc);
        this.#apply(copy, this.#docs.get(docId)!);
        return {
          push: (local) => {
            this.pushes.push({ peer, docId, doc: A.clone(local) });
            if (this.#apply(copy, local)) this.#receive(peer, docId, copy.doc);
          },
        };
      },
      shutdown: async () => {
        for (const [docId, copies] of this.#copies) {
          this.#copies.set(docId, copies.filter((c) => c.peer !== peer));
        }
      },
    };
  }

  /**
   * Wait until every delivery is absorbed and every bridge is idle — the
   * point where a real sync server would have converged all peers.
   */
  async settle(...bridges: NetSync[]): Promise<void> {
    for (;;) {
      await Promise.all(bridges.map((b) => b.idle()));
      if (this.#deliveries.size === 0) return;
      await Promise.all(this.#deliveries);
    }
  }

  /** A peer's change reaches the server, which fans it out to the others. */
  #receive(from: string, docId: DocumentId, doc: Doc): void {
    const held = this.#docs.get(docId);
    const merged = held === undefined ? A.clone(doc) : A.merge(A.clone(held), A.clone(doc));
    this.#docs.set(docId, merged);
    for (const copy of this.#copies.get(docId) ?? []) {
      if (copy.peer !== from) this.#apply(copy, merged);
    }
  }

  /** Merge into a peer's copy; a change is delivered like a handle's change event. */
  #apply(copy: PeerCopy, incoming: Doc): boolean {
    const merged = A.merge(A.clone(copy.doc), A.clone(incoming));
    if (sameHeads(merged, copy.doc)) return false;
    copy.doc = merged;
    const delivery = Promise.resolve().then(() => copy.onChange(A.clone(merged)));
    this.#deliveries.add(delivery);
    void delivery.finally(() => this.#deliveries.delete(delivery));
    return true;
  }
}
