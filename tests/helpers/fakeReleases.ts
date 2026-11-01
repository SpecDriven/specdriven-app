// A stand-in for github.com/SpecDriven/specdriven-app/releases, and
// the source zips it serves — what install.sh and install.ps1 install from.
// It answers the two URL shapes GitHub uses: /latest redirecting to
// /tag/v<version>, and /download/v<version>/<asset>. The zips are cut with
// `git archive`, exactly as .github/workflows/release.yml cuts the real one.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `git archive --format=zip --prefix=specdriven-<version>/`, as the workflow does.
    The buffer is spelled out because `Response` takes an ArrayBuffer-backed
    view, not the `ArrayBufferLike` default that also admits SharedArrayBuffer. */
export async function sourceZip(version: string): Promise<Uint8Array<ArrayBuffer>> {
  const repo = mkdtempSync(join(tmpdir(), "specdriven-src-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "specdriven", version }) + "\n");
  writeFileSync(join(repo, "README.md"), `# SpecDriven ${version}\n`);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  };
  await run("init", "-q");
  await run("add", ".");
  await run("commit", "-q", "-m", `v${version}`);
  const out = join(repo, "src.zip");
  await run("archive", "--format=zip", `--prefix=specdriven-${version}/`, "-o", out, "HEAD");
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The `sha256sum` line the workflow writes: two spaces between hash and name. */
export function shasums(entries: Record<string, Uint8Array>): string {
  return Object.entries(entries).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join("");
}

export interface Release {
  /** Asset name -> bytes, served under /download/v<version>/. */
  assets: Record<string, Uint8Array<ArrayBuffer> | string>;
}

/** Stands in for github.com/<owner>/<repo>/releases. */
export function fakeReleases(latest: string, releases: Record<string, Release>) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      if (url.pathname === "/latest") {
        return Response.redirect(`${url.origin}/tag/v${latest}`, 302);
      }
      const tag = url.pathname.match(/^\/tag\/v(.+)$/);
      if (tag) {
        return releases[tag[1]!] ? new Response("<html>release</html>") : new Response("Not Found", { status: 404 });
      }
      const dl = url.pathname.match(/^\/download\/v([^/]+)\/(.+)$/);
      if (dl) {
        const asset = releases[dl[1]!]?.assets[dl[2]!];
        return asset ? new Response(asset) : new Response("Not Found", { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits,
    stop: () => server.stop(true),
  };
}
