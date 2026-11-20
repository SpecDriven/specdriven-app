// The server side of automerge-repo's WebSocket protocol
// (@automerge/automerge-repo-network-websocket, protocol version "1"), for
// sockets handed over one at a time rather than a Node `ws` server: a
// Durable Object has no server object to listen on, only the socket of each
// request it accepts. The stock client adapter — what the SpecDriven app
// dials out with — connects to it unchanged.
//
// A peer says `join`; the server answers `peer`; after that every message is
// the repo's, passed through. Frames are CBOR.

import { NetworkAdapter, cbor } from "@automerge/automerge-repo/slim";
import type { Message, PeerId, PeerMetadata } from "@automerge/automerge-repo/slim";

/** A peer's connection as this adapter uses it — a workerd socket or a `ws` one. */
export interface RoomSocket {
  readonly readyState: number;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** A socket that reports its own frames and its closing, for {@link RoomNetworkAdapter.accept}. */
export interface ListeningSocket extends RoomSocket {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

const PROTOCOL_V1 = "1";
const OPEN = 1;

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null; // a text frame, or a Blob, is not this protocol
}

export class RoomNetworkAdapter extends NetworkAdapter {
  readonly #sockets = new Map<PeerId, RoomSocket>();
  #connected: () => void = () => {};

  /**
   * Resolves once the repo has given this adapter its own peer id, which a
   * peer's `join` is answered with: frames are handed over after it.
   */
  readonly connected = new Promise<void>((resolve) => {
    this.#connected = resolve;
  });

  /**
   * Told of each peer as it joins, so the server can note on the connection
   * who is at the other end — what {@link adopt} needs after a sleep.
   */
  onJoin: ((socket: RoomSocket, peerId: PeerId, peerMetadata: PeerMetadata) => void) | undefined;

  /** How many peers have joined and are still connected. */
  get peerCount(): number {
    return this.#sockets.size;
  }

  // Nothing to wait for: sockets arrive whenever a peer connects.
  isReady(): boolean {
    return true;
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.#connected();
  }

  disconnect(): void {
    for (const [peerId, socket] of [...this.#sockets]) {
      this.#sockets.delete(peerId);
      this.emit("peer-disconnected", { peerId });
      socket.close(1001, "the sync server is stopping");
    }
  }

  /** Take over a socket that reports its own frames and its closing. */
  accept(socket: ListeningSocket): void {
    socket.addEventListener("message", (event) => this.receive(socket, event.data));
    const gone = () => this.closed(socket);
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }

  /**
   * Take a peer back after the server slept: it joined on this socket
   * before, the connection stayed open meanwhile, and it does not know the
   * server was away — so no handshake, the repo is simply told it is there.
   */
  adopt(socket: RoomSocket, peerId: PeerId, peerMetadata: PeerMetadata): void {
    this.#sockets.set(peerId, socket);
    this.emit("peer-candidate", { peerId, peerMetadata });
  }

  /** A socket closed, or failed: its peer is gone. */
  closed(socket: RoomSocket): void {
    this.#forget(socket);
  }

  send(message: Message): void {
    const socket = this.#sockets.get(message.targetId);
    // A peer that left, or is leaving: once it is back and has joined again,
    // sync picks up from what each side holds.
    if (!socket || socket.readyState !== OPEN) return;
    if ("data" in message && message.data?.byteLength === 0) {
      throw new Error("Tried to send a zero-length message");
    }
    socket.send(cbor.encode(message));
  }

  /** One frame from a peer. */
  receive(socket: RoomSocket, data: unknown): void {
    // What a peer sends is untrusted: anything this cannot read, or that
    // fails while being handled, costs that peer its connection and no more.
    try {
      const bytes = bytesOf(data);
      if (!bytes) throw new Error("not a binary frame");
      const message = cbor.decode(bytes) as Message & {
        peerMetadata?: PeerMetadata;
        supportedProtocolVersions?: string[];
      };
      const senderId = message.senderId;
      if (typeof senderId !== "string" || typeof message.type !== "string") throw new Error("not a message");
      if (message.type === "join") {
        this.#join(senderId, message.peerMetadata ?? {}, message.supportedProtocolVersions, socket);
        return;
      }
      // Only the socket that joined as a peer speaks for it.
      if (this.#sockets.get(senderId) !== socket) return;
      this.emit("message", message);
    } catch (e) {
      console.warn(`closing a peer's connection: ${(e as Error).message}`);
      this.#forget(socket);
      socket.close(1003, "not an automerge-repo message");
    }
  }

  #join(peerId: PeerId, peerMetadata: PeerMetadata, versions: string[] | undefined, socket: RoomSocket): void {
    const myPeerId = this.peerId;
    if (!myPeerId) throw new Error("the adapter has not been connected to a repo");
    // The same peer on a new socket (it reconnected): the old one is done.
    const earlier = this.#sockets.get(peerId);
    if (earlier) {
      this.#sockets.delete(peerId);
      this.emit("peer-disconnected", { peerId });
      if (earlier !== socket && earlier.readyState === OPEN) earlier.close(1000, "replaced by a newer connection");
    }
    if (versions !== undefined && !versions.includes(PROTOCOL_V1)) {
      socket.send(
        cbor.encode({
          type: "error",
          senderId: myPeerId,
          message: "unsupported protocol version",
          targetId: peerId,
        }),
      );
      socket.close(1002, "unsupported protocol version");
      return;
    }
    this.#sockets.set(peerId, socket);
    this.onJoin?.(socket, peerId, peerMetadata);
    this.emit("peer-candidate", { peerId, peerMetadata });
    socket.send(
      cbor.encode({
        type: "peer",
        senderId: myPeerId,
        peerMetadata: this.peerMetadata,
        selectedProtocolVersion: PROTOCOL_V1,
        targetId: peerId,
      }),
    );
  }

  #forget(socket: RoomSocket): void {
    for (const [peerId, known] of this.#sockets) {
      if (known !== socket) continue;
      this.#sockets.delete(peerId);
      this.emit("peer-disconnected", { peerId });
    }
  }
}
