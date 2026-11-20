// The Cloudflare side: a Worker in front, and one Durable Object per data
// repository behind it. Everything it decides is in src/routes.ts; this file
// only joins that to Cloudflare's own objects.

import { DurableObject } from "cloudflare:workers";
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
/** The longest a timer may be set for; a pass never lasts this long anyway. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

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

/**
 * One data repository's sync server. It runs while a peer is connected and
 * sleeps when the last one leaves; its documents stay in its own storage
 * meanwhile, and the next peer to connect finds them there.
 */
export class SyncRoom extends DurableObject<Env> {
  #room: Room | null = null;

  override async fetch(request: Request): Promise<Response> {
    const name = request.headers.get(REPO_HEADER);
    const expiresAt = Number(request.headers.get(EXPIRES_HEADER));
    if (!name || !Number.isFinite(expiresAt)) return new Response("Not found", { status: 404 });
    this.#room ??= createRoom({
      name,
      store: {
        exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...(bindings as never[])),
        transactionSync: (work) => this.ctx.storage.transactionSync(work),
      },
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Frames as bytes, not Blobs (the default from a recent compatibility
    // date on): a Blob is read asynchronously, which would let two frames of
    // one peer be handled out of order.
    server.binaryType = "arraybuffer";
    server.accept();
    this.#room.network.accept(server);

    // The pass that opened the socket is also how long it may stay open: a
    // peer whose write access was taken away is gone when its pass runs out.
    const left = Math.min(Math.max(expiresAt * 1000 - Date.now(), 0), MAX_TIMER_MS);
    const timer = setTimeout(() => server.close(4401, "the pass has run out"), left);
    server.addEventListener("close", () => clearTimeout(timer));

    return new Response(null, { status: 101, webSocket: client });
  }
}
