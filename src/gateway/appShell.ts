// The app's own frontend (src/index.html), served by the gateway for every
// user instead of by each user's worker. Bundling the frontend costs a Bun
// server some 200 MB that it keeps, and every user's worker would pay that
// again for the same files; built once here, the workers serve only the API.
//
// The image builds it ahead (Dockerfile.hosted: `bun build src/index.html
// --outdir dist/app --production --public-path /_app/`); without that build
// the gateway bundles it in memory at start, as `bun run dev:hosted` does.

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

export const APP_ASSET_PREFIX = "/_app/";

export interface AppShell {
  /** The shell or one of its assets for this request, or null when it is the worker's. */
  serve(req: Request, url: URL): Promise<Response | null>;
}

/** Paths the worker answers: its API and the plugins' client bundles. */
export function isWorkerPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || /^\/plugins\/[^/]+\/client\.js$/.test(pathname);
}

interface Files {
  get(name: string): Promise<{ body: BodyInit; type: string } | null>;
}

function fromDisk(dir: string): Files {
  return {
    async get(name) {
      const path = normalize(join(dir, name));
      if (!path.startsWith(dir + "/")) return null;
      const file = Bun.file(path);
      return (await file.exists()) ? { body: file, type: file.type } : null;
    },
  };
}

async function inMemory(production: boolean): Promise<Files> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "index.html")],
    publicPath: APP_ASSET_PREFIX,
    minify: production,
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  });
  if (!result.success) throw new Error(`Building the app failed:\n${result.logs.map(String).join("\n")}`);
  const files = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  for (const output of result.outputs) {
    files.set(output.path.replace(/^\.\//, ""), {
      body: new Uint8Array(await output.arrayBuffer()),
      type: output.type,
    });
  }
  return { get: async (name) => files.get(name) ?? null };
}

export async function loadAppShell(opts: { production: boolean; distDir?: string | null }): Promise<AppShell> {
  const dist = opts.distDir ?? join(import.meta.dir, "..", "..", "dist", "app");
  const files = existsSync(join(dist, "index.html")) ? fromDisk(dist) : await inMemory(opts.production);
  const shell = await files.get("index.html");
  if (!shell) throw new Error("The app build has no index.html");
  const shellBody = shell.body instanceof Blob ? new Uint8Array(await shell.body.arrayBuffer()) : shell.body;

  return {
    async serve(req, url) {
      if (req.method !== "GET" && req.method !== "HEAD") return null;
      if (url.pathname.startsWith(APP_ASSET_PREFIX)) {
        const name = url.pathname.slice(APP_ASSET_PREFIX.length);
        const asset = name && !name.includes("..") ? await files.get(name) : null;
        if (!asset) return new Response("Not Found", { status: 404 });
        return new Response(asset.body, {
          headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" },
        });
      }
      if (isWorkerPath(url.pathname)) return null;
      // Every other path is a page of the app: the client routes it
      // (specs/navigation.spec.md), as the worker's own shell routes did.
      return new Response(shellBody as BodyInit, {
        headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
      });
    },
  };
}
