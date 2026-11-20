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
    // Every peer in the room is offered every document the room has open —
    // the library's default. They are all writers of the one repository the
    // room serves, and it is what lets the room forget who asked for what:
    // after it slept (src/worker.ts) the peers are still connected, and an
    // edit from one must still reach the rest.
  });
  return { repo, network };
}
