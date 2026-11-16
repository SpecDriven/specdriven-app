// The workers' one way out (docs/hosted-tenant-isolation.md "Step 2",
// specs/app/hosted-app.feature.md "A worker is confined to its own folder
// and one way out"): a proxy on a local port that lets a connection through
// to GitHub and refuses every other. A hosted worker needs nothing else of
// the network — it fetches and pushes its person's repository and calls
// GitHub's API — and git and the app's own requests already go where
// HTTPS_PROXY points.
//
// By itself that is a convention a taken-over worker can ignore. What makes
// it hold is the launcher's rule that the worker may connect to this port
// and no other (sandbox.ts), where the kernel has such rules.
//
// It speaks just enough of HTTP's proxy side to do that, over plain TCP:
//
//   CONNECT host:port     a tunnel, which is what https uses;
//   GET http://host/...   one plain request passed on — a stand-in GitHub
//                         in development is served over http.
//
// Either way the host and port must be on the list, and what is refused
// gets a 403 and a line in the log.

import net from "node:net";
import { GITHUB_HOST } from "../server/github";

type Env = Record<string, string | undefined>;

const MAX_HEAD_BYTES = 16 * 1024;
const IDLE_MS = 5 * 60_000;
/** A connection says where it wants to go within this long, or is closed. */
const HEAD_MS = 15_000;
/**
 * Connections held at once, for all workers together. Every one costs the
 * gateway — which serves everybody — two file descriptors, and a worker can
 * open thousands.
 */
const MAX_CONNECTIONS = 256;

function target(host: string, port: number): string {
  return `${host.toLowerCase().replace(/\.$/, "")}:${port}`;
}

/** "host", "host:port" or a url, as the "host:port" it names; null when it names none. */
function parseTarget(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!url.hostname) return null;
    const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
    return target(url.hostname, port);
  } catch {
    return null;
  }
}

/**
 * Where a worker may connect: GitHub and its API, a stand-in for either
 * that the environment names (development), and whatever the operator adds
 * in SPECDRIVEN_WORKER_EGRESS_HOSTS (comma-separated, https unless a port
 * is given).
 */
export function egressTargets(env: Env = process.env): Set<string> {
  const allowed = new Set([target(GITHUB_HOST, 443), target(`api.${GITHUB_HOST}`, 443)]);
  const named = [
    env.SPECDRIVEN_GITHUB_URL,
    env.SPECDRIVEN_GITHUB_API_URL,
    ...(env.SPECDRIVEN_WORKER_EGRESS_HOSTS ?? "").split(","),
  ];
  for (const value of named) {
    const parsed = parseTarget(value ?? "");
    if (parsed) allowed.add(parsed);
  }
  return allowed;
}

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
}

/** What a refused name looks like in the log: it is the worker's to choose. */
function printable(text: string): string {
  return text.replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
}

function refuse(client: net.Socket, status: string, why: string): void {
  // Said, then closed for good: a refused connection holds nothing open.
  client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${why}\n`, () => client.destroy());
}

/** Start the proxy on a free local port. */
export function startEgressProxy(
  allowed: Set<string>,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<EgressProxy> {
  const open = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.setTimeout(IDLE_MS, () => socket.destroy());
  };

  let clients = 0;
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    if (clients >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    clients++;
    client.on("close", () => clients--);
    track(client);
    client.on("error", () => client.destroy());
    const headTimer = setTimeout(() => client.destroy(), HEAD_MS);
    client.on("close", () => clearTimeout(headTimer));
    // Hung up before saying where to: nothing to keep half of open.
    const goneEarly = () => client.destroy();
    client.on("end", goneEarly);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) refuse(client, "431 Request Header Fields Too Large", "The request's headers are too long");
        return;
      }
      clearTimeout(headTimer);
      client.off("end", goneEarly);
      client.off("data", onData);
      client.pause();
      const [requestLine = "", ...headers] = head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = head.subarray(end + 4);
      const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
      if (!match) return refuse(client, "400 Bad Request", "Not a proxy request");
      const [, method, where] = match as unknown as [string, string, string];

      let to: string | null;
      let firstBytes: Buffer;
      if (method === "CONNECT") {
        const [, host, port] = /^(.+):(\d+)$/.exec(where) ?? [];
        to = host && port ? target(host.replace(/^\[|\]$/g, ""), Number(port)) : null;
        firstBytes = rest;
      } else {
        let url: URL | null = null;
        try {
          url = new URL(where);
        } catch {
          // An origin-form path: a request for this proxy itself, which serves nothing.
        }
        if (url?.protocol !== "http:") return refuse(client, "400 Bad Request", "Not a proxy request");
        to = target(url.hostname, url.port ? Number(url.port) : 80);
        // One request a connection, so each is checked against the list.
        const passed = headers.filter((h) => !/^(proxy-[a-z-]+|connection)\s*:/i.test(h));
        const request = [`${method} ${url.pathname}${url.search} HTTP/1.1`, ...passed, "Connection: close", "", ""].join("\r\n");
        firstBytes = Buffer.concat([Buffer.from(request, "latin1"), rest]);
      }
      if (!to || !allowed.has(to)) {
        log(`a worker's connection to ${printable(to ?? where)} was refused: not on the outbound list`);
        return refuse(client, "403 Forbidden", "The hosted app's workers reach GitHub only");
      }

      const [host, port] = [to.slice(0, to.lastIndexOf(":")), Number(to.slice(to.lastIndexOf(":") + 1))];
      const upstream = net.connect({ port, host, allowHalfOpen: true });
      track(upstream);
      let connected = false;
      upstream.on("error", () => {
        if (!connected && !client.destroyed) refuse(client, "502 Bad Gateway", "The host did not answer");
        else client.destroy();
        upstream.destroy();
      });
      upstream.on("connect", () => {
        connected = true;
        if (method === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (firstBytes.length) upstream.write(firstBytes);
        // Each side's end is passed on; what was already sent still arrives.
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        if (!client.destroyed) client.end();
      });
    };
    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("The outbound proxy has no port"));
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
