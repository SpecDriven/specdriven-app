// The Cloudflare side: a Worker in front, and one Durable Object per data
// repository behind it. Everything it decides is in src/routes.ts; this file
// only joins that to Cloudflare's own objects.

import { DurableObject } from "cloudflare:workers";
import type { PeerId, PeerMetadata } from "@automerge/automerge-repo/slim";
import { sweep } from "./expiry";
import type { RoomSocket } from "./network";
import { createRoom, type Room } from "./room";
import { handle } from "./routes";

interface Env {
  SYNC_ROOM: DurableObjectNamespace<SyncRoom>;
  /** Signs the passes. Set with `wrangler secret put TICKET_SECRET`. */
  TICKET_SECRET?: string;
  /** The GitHub host whose repositories this server serves. Default github.com. */
  GITHUB_HOST?: string;
  /** That host's REST API. Default https://api.github.com. */
  GITHUB_API_URL?: string;
  /** How long a pass lasts, in seconds. Default one hour. */
  TICKET_SECONDS?: string;
}

const REPO_HEADER = "x-sync-repo";
const EXPIRES_HEADER = "x-sync-expires";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const seconds = Number(env.TICKET_SECONDS);
    return handle(request, {
      secret: env.TICKET_SECRET || undefined,
      githubHost: (env.GITHUB_HOST || "github.com").toLowerCase(),
      githubApi: env.GITHUB_API_URL || "https://api.github.com",
      ticketSeconds: Number.isFinite(seconds) && seconds >= 60 ? Math.floor(seconds) : 3600,
      now: () => Date.now(),
      fetch: (input, init) => fetch(input, init),
      connect: (repoKey, upgrade, expiresAt) => {
        const headers = new Headers(upgrade.headers);
        headers.set(REPO_HEADER, repoKey);
        headers.set(EXPIRES_HEADER, String(expiresAt));
        // The same name always reaches the same object: that repository's.
        const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(repoKey));
        return room.fetch(new Request(upgrade.url, { headers }));
      },
    });
  },
} satisfies ExportedHandler<Env>;

/** What the room notes on each connection, where it survives the room's sleep. */
interface Connection {
  /** This connection, whichever object the runtime hands it over as. */
  id: string;
  /** The repository the room serves: `<host>/<owner>/<name>`. */
  repo: string;
  /** When the pass that opened it runs out, in seconds since the epoch. */
  expiresAt: number;
  /** Who is at the other end, once it has joined. */
  peerId?: PeerId;
  peerMetadata?: PeerMetadata;
}

/** A connection as the room's network adapter holds it. */
interface HeldSocket extends RoomSocket {
  ws: WebSocket;
}

function connectionOf(ws: WebSocket): Connection | null {
  const noted = ws.deserializeAttachment() as Partial<Connection> | null;
  if (!noted || typeof noted.id !== "string" || typeof noted.repo !== "string") return null;
  if (typeof noted.expiresAt !== "number") return null;
  return noted as Connection;
}

/**
 * One data repository's sync server. Its documents are in its own storage.
 * Its Automerge repo is in memory only while there is something to do: with
 * nobody editing, the object sleeps — the peers stay connected to
 * Cloudflare, and nothing is billed for the time — and the next frame from
 * any of them wakes it. Awake again it knows nothing but what is in storage
 * and what it noted on each connection, so it tells its new repo who is
 * connected, and carries on from the documents as stored.
 */
export class SyncRoom extends DurableObject<Env> {
  #room: Room | null = null;
  readonly #held = new Map<string, HeldSocket>();

  override async fetch(request: Request): Promise<Response> {
    const repo = request.headers.get(REPO_HEADER);
    const expiresAt = Number(request.headers.get(EXPIRES_HEADER));
    if (!repo || !Number.isFinite(expiresAt)) return new Response("Not found", { status: 404 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // A hibernating socket: its frames come to webSocketMessage below, and
    // it stays open while this object is out of memory.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), repo, expiresAt } satisfies Connection);

    // The pass that opened the socket is also how long it may stay open: a
    // peer whose write access was taken away is gone when its pass runs out.
    // An alarm, not a timer: a pending timer would keep the object awake.
    const alarmAt = await this.ctx.storage.getAlarm();
    if (alarmAt === null || alarmAt > expiresAt * 1000) await this.ctx.storage.setAlarm(expiresAt * 1000);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connection = connectionOf(ws);
    if (!connection) {
      ws.close(1011, "the connection is not known to the sync server");
      return;
    }
    const room = this.#awake(connection.repo);
    // Frames of one peer are handed over in the order they came: each waits
    // on the same promise, and those waiting are let go in turn.
    await room.network.connected;
    room.network.receive(this.#hold(ws, connection), message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#gone(ws);
    // Complete the closing handshake, with the peer's own code where it may be sent back.
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
      else ws.close();
    } catch {
      // Already closed from this side.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#gone(ws);
  }

  override async alarm(): Promise<void> {
    const open = this.ctx.getWebSockets().flatMap((ws) => {
      const connection = connectionOf(ws);
      return connection ? [{ ws, expiresAt: connection.expiresAt }] : [];
    });
    const { expired, nextAt } = sweep(open, Date.now());
    for (const { ws } of expired) {
      this.#gone(ws);
      ws.close(4401, "the pass has run out");
    }
    if (nextAt !== null) await this.ctx.storage.setAlarm(nextAt);
  }

  /** The room, made anew when this object was out of memory. */
  #awake(repo: string): Room {
    if (this.#room) return this.#room;
    const room = createRoom({
      name: repo,
      store: {
        exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...(bindings as never[])),
        transactionSync: (work) => this.ctx.storage.transactionSync(work),
      },
    });
    // Who joins is noted on the connection, to be found there after a sleep.
    room.network.onJoin = (socket, peerId, peerMetadata) => {
      const ws = (socket as HeldSocket).ws;
      const connection = connectionOf(ws);
      if (connection) ws.serializeAttachment({ ...connection, peerId, peerMetadata } satisfies Connection);
    };
    // Whoever joined before the sleep is still connected, and does not know
    // the server was away: the new repo is told they are there.
    for (const ws of this.ctx.getWebSockets()) {
      const connection = connectionOf(ws);
      if (!connection?.peerId || ws.readyState !== WebSocket.OPEN) continue;
      room.network.adopt(this.#hold(ws, connection), connection.peerId, connection.peerMetadata ?? {});
    }
    this.#room = room;
    return room;
  }

  /** One object per connection for the network adapter, which tells sockets apart by identity. */
  #hold(ws: WebSocket, connection: Connection): HeldSocket {
    let held = this.#held.get(connection.id);
    if (!held) {
      held = {
        ws,
        get readyState() {
          return ws.readyState;
        },
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      };
      this.#held.set(connection.id, held);
    }
    return held;
  }

  #gone(ws: WebSocket): void {
    const connection = connectionOf(ws);
    if (!connection) return;
    const held = this.#held.get(connection.id);
    this.#held.delete(connection.id);
    // Asleep, there is no repo to tell: who is connected is read off the
    // connections themselves on waking.
    if (held) this.#room?.network.closed(held);
  }
}
