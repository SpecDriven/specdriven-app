// Minimal git smart-HTTP server for tests: fixtures serve their bare origin
// repos over a loopback port, so pushes and pulls exercise the transport a
// real remote uses instead of a local path. Test-only — the server side
// shells out to git, which dev machines and CI have.

import { join, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

export interface GitHttpServer {
  /** Base url; a repo directory <root>/<name> is served at <url>/<name>. */
  url: string;
  stop(): void;
}

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** One pkt-line: 4 hex length digits followed by the payload. */
function pktLine(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

/** Repo path under root for a url path segment; rejects traversal. */
function repoDir(rootDir: string, repo: string): string | null {
  const dir = normalize(join(rootDir, repo));
  return dir.startsWith(normalize(rootDir)) ? dir : null;
}

export function serveRepos(rootDir: string): GitHttpServer {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Ref advertisement: GET /<repo>/info/refs?service=git-…-pack
      const refs = url.pathname.match(/^\/(.+)\/info\/refs$/);
      if (req.method === "GET" && refs) {
        const service = url.searchParams.get("service") ?? "";
        const dir = repoDir(rootDir, refs[1]!);
        if (!SERVICES.has(service) || !dir) return new Response("bad request", { status: 400 });
        const proc = Bun.spawn(
          ["git", service.slice(4), "--stateless-rpc", "--advertise-refs", dir],
          { stdout: "pipe", stderr: "ignore" },
        );
        const advertised = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
        if ((await proc.exited) !== 0) return new Response("no repo", { status: 404 });
        const head = new TextEncoder().encode(pktLine(`# service=${service}\n`) + "0000");
        const body = new Uint8Array(head.length + advertised.length);
        body.set(head, 0);
        body.set(advertised, head.length);
        return new Response(body, {
          headers: {
            "content-type": `application/x-${service}-advertisement`,
            "cache-control": "no-cache",
          },
        });
      }

      // RPC: POST /<repo>/git-…-pack with the raw (possibly gzipped) body
      const rpc = url.pathname.match(/^\/(.+)\/(git-upload-pack|git-receive-pack)$/);
      if (req.method === "POST" && rpc) {
        const dir = repoDir(rootDir, rpc[1]!);
        const service = rpc[2]!;
        if (!dir) return new Response("bad request", { status: 400 });
        let body = new Uint8Array(await req.arrayBuffer());
        if (req.headers.get("content-encoding") === "gzip") {
          body = new Uint8Array(gunzipSync(body));
        }
        const proc = Bun.spawn(["git", service.slice(4), "--stateless-rpc", dir], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        proc.stdin.write(body);
        await proc.stdin.end();
        const out = await new Response(proc.stdout).arrayBuffer();
        return new Response(out, {
          headers: { "content-type": `application/x-${service}-result` },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
