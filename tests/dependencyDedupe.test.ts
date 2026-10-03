// package.json `overrides` pin packages that must load as a single copy: two
// Automerge instances make netsync throw "expected instance of Automerge" (so
// every websocket test in tests/automerge/automergeNetsync.test.ts times out),
// and two CodeMirror state/view copies split EditorView for tsc. bun.lock
// keeps them deduped, but `bun install` never deletes a nested copy an older
// lockfile left in node_modules, so a stale checkout fails here, by name,
// instead of as a pile of unrelated timeouts.

import { test, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const nodeModules = join(import.meta.dir, "..", "node_modules");

// Every installed package directory one level down: `name` and `@scope/name`.
function installedPackages(): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith(".")) continue;
    if (!entry.startsWith("@")) {
      dirs.push(join(nodeModules, entry));
      continue;
    }
    for (const scoped of readdirSync(join(nodeModules, entry))) {
      dirs.push(join(nodeModules, entry, scoped));
    }
  }
  return dirs;
}

test("overridden packages have no stale nested copies in node_modules", () => {
  const pinned = Object.keys(pkg.overrides);
  const nested = installedPackages().flatMap((dir) =>
    pinned
      .map((name) => join(dir, "node_modules", name))
      .filter((copy) => existsSync(join(copy, "package.json"))),
  );
  const hint = "stale nested copies; run `rm -rf node_modules && bun install`";
  expect(nested.map((copy) => copy.slice(nodeModules.length + 1)), hint).toEqual([]);
});
