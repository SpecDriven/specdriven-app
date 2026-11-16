// How a worker's git asks the gateway for a GitHub token
// (docs/hosted-tenant-isolation.md "Step 3", specs/app/hosted-app.feature.md
// "A worker gets a GitHub token for one repository, for an hour"): a unix
// socket of its own for each worker, in a folder the spawner made that only
// that worker's uid and the gateway can enter (spawner.ts). The gateway
// listens; the worker connects, says which repository, and gets one line
// back.
//
// Which person is asking is never something the request says. It is the
// socket the request came in on — and, where workers have uids, the uid of
// the process on the other end, which the kernel reports and a worker
// cannot choose. Anyone else is hung up on before a byte is read.
//
// One JSON line each way, then the connection ends:
//
//   {"repo":"owner/name"}
//   {"token":"…","expiresAt":1731700000000}   or   {"error":"why not"}

import { dlopen, FFIType } from "bun:ffi";
import { rmSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoToken } from "./githubApp";

/** Nothing longer is a request: a repository's name is at most some 200 characters. */
const MAX_REQUEST = 1024;
/** A connection that has not asked by now is closed. */
const ASK_SECONDS = 10;
/** One worker's git asks a few at a time at most. */
const MAX_CONNECTIONS = 16;

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

let getsockopt: ((fd: number, level: number, name: number, value: Int32Array, length: Uint32Array) => number) | null | undefined;

/**
 * The uid of the process at the other end of a unix socket, as the kernel
 * recorded it when the connection was made (SO_PEERCRED); null where that
 * cannot be asked, which is everywhere but Linux.
 */
export function peerUid(fd: number): number | null {
  if (process.platform !== "linux") return null;
  if (getsockopt === undefined) {
    try {
      const lib = dlopen("libc.so.6", {
        getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      getsockopt = (...args) => Number(lib.symbols.getsockopt(...args));
    } catch {
      getsockopt = null;
    }
  }
  if (!getsockopt) return null;
  // struct ucred: the pid, the uid, the gid.
  const cred = new Int32Array(3);
  const length = new Uint32Array([cred.byteLength]);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, cred, length) !== 0 || length[0] !== cred.byteLength) return null;
  return cred[1]! >>> 0;
}

export interface TokenServer {
  /** Stop listening, at once: the next worker of the same person listens at the same place. */
  close(): void;
}

export interface TokenServerOptions {
  /** Where to listen: `gate/github.sock` in the person's folder (spawner.ts). */
  path: string;
  /** The worker's uid: the only one answered. Null where workers share the gateway's user. */
  uid: number | null;
  /** The token for a repository, or a thrown reason the worker is told. */
  answer(repo: string): Promise<RepoToken>;
  /** The uid on the other end of a connection; the kernel's by default. */
  peer?: (fd: number) => number | null;
}

interface Asking {
  text: string;
  /** The request has been read: nothing more is. */
  done: boolean;
  /** Not this worker: nothing is read at all. */
  refused: boolean;
}

/** Listen for one worker's requests. */
export async function serveTokens(opts: TokenServerOptions): Promise<TokenServer> {
  const peer = opts.peer ?? peerUid;
  // The spawner made the folder; where the pool is its own spawner's only
  // user (tests with a stand-in) it may not be there yet.
  await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
  // Nothing but the gateway can put a name in that folder: unlinking follows no link.
  await rm(opts.path, { force: true });

  let open = 0;
  const listener = Bun.listen<Asking>({
    unix: opts.path,
    socket: {
      open(socket) {
        socket.data = { text: "", done: false, refused: false };
        open++;
        // The worker and nobody else: not another worker, and not the
        // gateway's own uid, which has no reason to ask itself.
        const fd = (socket as unknown as { fd?: unknown }).fd;
        const from = typeof fd === "number" ? peer(fd) : null;
        if (open > MAX_CONNECTIONS || (opts.uid !== null && from !== opts.uid)) {
          socket.data.refused = true;
          // Hanging up from inside this call does not take; a moment later
          // does, and so does the first byte that arrives (below).
          setTimeout(() => socket.end(), 0);
          return;
        }
        socket.timeout(ASK_SECONDS);
      },
      data(socket, chunk) {
        const asking = socket.data;
        if (asking.refused) socket.end();
        if (asking.refused || asking.done) return;
        asking.text += chunk.toString("utf8");
        const end = asking.text.indexOf("\n");
        if (end < 0) {
          if (asking.text.length > MAX_REQUEST) {
            asking.done = true;
            socket.end();
          }
          return;
        }
        // One request a connection: whatever follows the first line is not read.
        asking.done = true;
        socket.timeout(0);
        const reply = (message: unknown) => {
          try {
            socket.end(JSON.stringify(message) + "\n");
          } catch {
            // It hung up before the answer was ready.
          }
        };
        let repo: unknown;
        try {
          repo = (JSON.parse(asking.text.slice(0, end)) as { repo?: unknown } | null)?.repo;
        } catch {
          repo = undefined;
        }
        if (typeof repo !== "string" || end > MAX_REQUEST) return reply({ error: "Not a request" });
        opts.answer(repo).then(
          ({ token, expiresAt }) => reply({ token, expiresAt }),
          (e: unknown) => reply({ error: String((e as Error)?.message ?? e).slice(0, 500) }),
        );
      },
      timeout(socket) {
        socket.data.done = true;
        socket.end();
      },
      close() {
        open--;
      },
      error(socket) {
        socket.data.done = true;
        socket.end();
      },
    },
  });
  // The folder's group is the worker's (it is set-group-id), and so is the
  // socket's: the worker may connect, as may the gateway, and no one else.
  await chmod(opts.path, opts.uid === null ? 0o600 : 0o660);

  return {
    close() {
      listener.stop(true);
      rmSync(opts.path, { force: true });
    },
  };
}
