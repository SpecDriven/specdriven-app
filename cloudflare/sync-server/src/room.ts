// One repository's sync server: an Automerge repo of its own, the sockets of
// the peers connected to it, and the store its documents are kept in. The
// Durable Object (src/worker.ts) holds exactly one, so two data repositories
// never share a process, a document or a byte of storage.

import { Repo } from "@automerge/automerge-repo";
import type { PeerId } from "@automerge/automerge-repo";
import { RoomNetworkAdapter } from "./network";
import { SqlStorageAdapter, type SqlStore } from "./storage";

export interface Room {
  repo: Repo;
  network: RoomNetworkAdapter;
}

export function createRoom(options: { name: string; store: SqlStore }): Room {
  const network = new RoomNetworkAdapter();
  const repo = new Repo({
    network: [network],
    storage: new SqlStorageAdapter(options.store),
    peerId: `sync-server:${options.name}` as PeerId,
    // A relay and a store, like the reference sync server: it gives a peer
    // the documents that peer asks about and never offers the rest.
    sharePolicy: async () => false,
  });
  return { repo, network };
}
