// Times the two halves of an on-demand code search over a repository: listing
// its files (git ls-files, ignore rules applied) and scanning their bytes for
// a literal. Read-only. Runs under Bun and under Node (the engine Electron's
// main process uses), so the numbers stand for both runtimes:
//
//   bun scripts/bench-code-search.ts <repo> [needle]
//   node --experimental-strip-types scripts/bench-code-search.ts <repo> [needle]

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const CONCURRENCY = 64;

const root = resolve(process.argv[2] ?? ".");
const needle = Buffer.from(process.argv[3] ?? "function");

function gitFiles(dir: string): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => (error ? fail(error) : done(String(stdout).split("\0").filter(Boolean))),
    );
  });
}

interface Pass {
  listMs: number;
  scanMs: number;
  firstHitMs: number | null;
  files: number;
  scannedMB: number;
  skipped: number;
  hits: number;
  hitFiles: number;
}

async function pass(): Promise<Pass> {
  let t0 = performance.now();
  const files = await gitFiles(root);
  const listMs = performance.now() - t0;

  t0 = performance.now();
  let next = 0;
  let bytes = 0;
  let skipped = 0;
  let hits = 0;
  let hitFiles = 0;
  let firstHitMs: number | null = null;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const abs = join(root, files[next++]!);
      let buf: Buffer;
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        buf = await readFile(abs);
      } catch {
        skipped++;
        continue;
      }
      if (buf.subarray(0, SNIFF_BYTES).includes(0)) {
        skipped++;
        continue;
      }
      bytes += buf.length;
      let n = 0;
      for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) n++;
      if (n > 0) {
        firstHitMs ??= performance.now() - t0;
        hits += n;
        hitFiles++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return {
    listMs,
    scanMs: performance.now() - t0,
    firstHitMs,
    files: files.length,
    scannedMB: bytes / 1e6,
    skipped,
    hits,
    hitFiles,
  };
}

const runtime = "Bun" in globalThis ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
console.log(`${runtime}  repo=${root}  needle=${JSON.stringify(needle.toString())}`);
for (const label of ["first", "second", "third"]) {
  const p = await pass();
  console.log(
    `${label.padEnd(6)} list=${p.listMs.toFixed(0)}ms scan=${p.scanMs.toFixed(0)}ms ` +
      `firstHit=${p.firstHitMs === null ? "-" : `${p.firstHitMs.toFixed(0)}ms`} ` +
      `files=${p.files} text=${p.scannedMB.toFixed(1)}MB skipped=${p.skipped} ` +
      `hits=${p.hits} in ${p.hitFiles} files`,
  );
}
