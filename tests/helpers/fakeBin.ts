// Stand-in executables (a fake gh, bun, uname, …) that cost nothing to run.
//
// macOS scans every newly written executable the first time it is exec'd —
// 100–400 ms for a two-line shell script, against ~8 ms for every run after.
// A test that writes its fakes afresh pays that per fake per test, which made
// the installer and gh-engine tests the slowest in the suite while doing
// almost nothing. So a fake is written once, named by a hash of its body, in
// a directory that outlives the test process, and tests link to it; a link
// (symbolic or hard) to an already-scanned file runs at full speed.
//
// That only works if a fake's body is the same every time, so anything that
// varies per test — a log path, what a build step does — goes in through the
// environment the fake inherits, never into the script text.

import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = join(tmpdir(), "specdriven-test-bin");

/**
 * The path of an executable holding exactly `body`, written on first use and
 * reused by every later caller, in this process or any other.
 */
export function cachedExecutable(body: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
  const path = join(CACHE, hash);
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  // Written aside and renamed into place, so a concurrent test process never
  // execs half a script.
  const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(partial, body);
  chmodSync(partial, 0o755);
  renameSync(partial, path);
  return path;
}

/** Put an executable named `name` with this body into `dir`, as a link to the cached copy. */
export function linkExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  symlinkSync(cachedExecutable(body), path);
  return path;
}
