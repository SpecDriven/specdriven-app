// How the gateway, which is not root, asks the spawner, which is
// (spawner.ts, docs/hosted-tenant-isolation.md "Step 2"): a unix socket in
// a folder only root and the gateway's group can enter, carrying one JSON
// message a line. No HTTP — the spawner never parses any.
//
// The gateway connects once and keeps the connection: its requests go out
// numbered, the answers come back by number, and the spawner tells it on
// the same connection when a worker has ended.
//
// The socket is reachable by whatever the gateway can be made to connect
// to it — and the gateway connects to sockets in folders workers own. So a
// connection must first say the key the spawner made at start and handed
// only to the gateway, and a line that is not a message of this protocol
// ends the connection.

import { timingSafeEqual } from "node:crypto";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import {
  checkReport,
  checkStart,
  checkStop,
  type ReportRequest,
  type SpawnerApi,
  type StartRequest,
  type StopRequest,
  type WorkerExit,
  type WorkerReport,
} from "./spawner";

/**
 * Nothing longer is a message. A settings file is at most 1 MB of text, and
 * JSON writes a control character as six: the longest honest answer is a
 * little over 6 MB. The file is a worker's to fill, so the spawner also
 * checks before it sends (sendLine): a line the gateway would have to hang
 * up over is never put on the wire.
 */
export const MAX_LINE = 8 * 1024 * 1024;

export const SPAWNER_SOCKET_ENV = "SPECDRIVEN_SPAWNER_SOCKET";
export const SPAWNER_KEY_ENV = "SPECDRIVEN_SPAWNER_KEY";

function sameKey(given: unknown, key: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Call `onLine` for each line a socket receives; `onTooLong` when one never ends. */
function readLines(socket: net.Socket, onLine: (line: string) => void, onTooLong: () => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    // A connection ended over one line gets none of the lines after it read:
    // they arrive together, and may be exactly what the first was hiding.
    for (let end = pending.indexOf("\n"); end >= 0 && !socket.destroyed; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      onLine(line);
    }
    if (socket.destroyed) pending = "";
    else if (pending.length > MAX_LINE) onTooLong();
  });
}

export interface SpawnerServer {
  close(): Promise<void>;
}

/**
 * Listen for the gateway on `path`. With a `gid`, the socket and its folder
 * belong to that group and to nobody else but root.
 */
export async function serveSpawner(
  spawner: SpawnerApi,
  opts: { path: string; key: string; gid?: number | null },
): Promise<SpawnerServer> {
  const dir = dirname(opts.path);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  if (opts.gid != null) {
    await chown(dir, 0, opts.gid);
    await chmod(dir, 0o750);
  }
  await rm(opts.path, { force: true });

  /** The gateway's connection: the one told when a worker ends. */
  let gateway: net.Socket | null = null;
  spawner.onExit((exit) => gateway?.write(JSON.stringify({ event: "exit", exit }) + "\n"));

  const requireUid = opts.gid != null;
  const handle = (op: string, req: unknown): Promise<unknown> => {
    if (op === "start") return spawner.start(checkStart(req, { requireUid }));
    if (op === "stop") return spawner.stop(checkStop(req, { requireUid }));
    if (op === "report") return spawner.report(checkReport(req, { requireUid }));
    throw new Error("No such request");
  };

  const server = net.createServer((socket) => {
    let known = false;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (gateway === socket) gateway = null;
    });
    readLines(
      socket,
      (line) => {
        let message: { hello?: unknown; id?: unknown; op?: unknown; req?: unknown };
        try {
          message = JSON.parse(line);
          if (typeof message !== "object" || message === null) throw new Error("not a message");
        } catch {
          socket.destroy();
          return;
        }
        if (!known) {
          if (!sameKey(message.hello, opts.key)) {
            socket.destroy();
            return;
          }
          known = true;
          gateway = socket;
          socket.write('{"hello":"ok"}\n');
          return;
        }
        const { id, op } = message;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof op !== "string") {
          socket.destroy();
          return;
        }
        // Not awaited: a slow start for one person holds up nobody else's.
        void (async () => handle(op, message.req))().then(
          (result) => {
            const line = JSON.stringify({ id, ok: true, result: result ?? null });
            // What a worker left for the spawner to read must not cost the
            // gateway its connection: too long an answer is that request's failure.
            socket.write((line.length < MAX_LINE ? line : JSON.stringify({ id, ok: false, error: "The answer is too long to send" })) + "\n");
          },
          (e: Error) => socket.write(JSON.stringify({ id, ok: false, error: String(e?.message ?? e).slice(0, 2000) }) + "\n"),
        );
      },
      () => socket.destroy(),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  if (opts.gid != null) await chown(opts.path, 0, opts.gid);
  await chmod(opts.path, opts.gid != null ? 0o660 : 0o600);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        gateway?.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface SpawnerClient extends SpawnerApi {
  /** Settles when the connection is gone: without the spawner the gateway can start nothing. */
  closed: Promise<void>;
  close(): void;
}

/** The spawner as the gateway sees it, over its socket. */
export async function connectSpawner(path: string, key: string): Promise<SpawnerClient> {
  const socket = net.connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const waiting = new Map<number, { resolve(value: unknown): void; reject(e: Error): void }>();
  const listeners: ((exit: WorkerExit) => void)[] = [];
  let next = 1;
  let greeted: (() => void) | null = null;
  let refuseGreeting: ((e: Error) => void) | null = null;
  let over = false;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));

  const end = () => {
    if (over) return;
    over = true;
    const gone = new Error("The spawner is gone");
    refuseGreeting?.(gone);
    for (const call of waiting.values()) call.reject(gone);
    waiting.clear();
    socket.destroy();
    markClosed();
  };
  socket.on("error", end);
  socket.on("close", end);

  readLines(
    socket,
    (line) => {
      let message: { hello?: unknown; id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; exit?: WorkerExit };
      try {
        message = JSON.parse(line);
      } catch {
        end();
        return;
      }
      if (message.hello === "ok") {
        greeted?.();
        return;
      }
      if (message.event === "exit" && message.exit) {
        for (const listener of listeners) listener(message.exit);
        return;
      }
      const call = typeof message.id === "number" ? waiting.get(message.id) : undefined;
      if (!call) return;
      waiting.delete(message.id!);
      if (message.ok) call.resolve(message.result);
      else call.reject(new Error(message.error ?? "The spawner refused"));
    },
    end,
  );

  await new Promise<void>((resolve, reject) => {
    greeted = resolve;
    refuseGreeting = reject;
    socket.write(JSON.stringify({ hello: key }) + "\n");
  });
  refuseGreeting = null;

  const ask = <T>(op: string, req: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (over) return reject(new Error("The spawner is gone"));
      const id = next++;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.write(JSON.stringify({ id, op, req }) + "\n");
    });

  return {
    start: (req: StartRequest) => ask<void>("start", req),
    stop: (req: StopRequest) => ask<void>("stop", req),
    report: (req: ReportRequest) => ask<WorkerReport>("report", req),
    onExit: (listener) => void listeners.push(listener),
    closed,
    close: end,
  };
}
