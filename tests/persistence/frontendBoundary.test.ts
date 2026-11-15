// Effect and the services built on it stay on the server. The browser
// bundle is built from src/index.html's entry; nothing it imports for its
// value — directly or through another module — may be `effect`, an
// `@effect/*` package, or a file under src/server/persistence,
// src/server/sync or src/server/effect. A type-only import is erased before
// bundling and does not count.
//
// The Promise facades (fsx.ts, automerge/store.ts, state.ts, tokenStore.ts,
// secrets.ts, run.ts, git/index.ts, reload.ts) run on Effect, so one of them
// reaching the frontend would carry the whole runtime into the page; this
// walk names the chain if it ever happens.

import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const ENTRY = join(ROOT, "src/frontend/main.tsx");
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function fileFor(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  for (const suffix of SUFFIXES) {
    const path = resolve(dirname(from), specifier + suffix);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/** Every module the entry reaches through value imports, with the module that led to it. */
function reachable(): { cameFrom: Map<string, string | null>; packages: Map<string, string> } {
  const cameFrom = new Map<string, string | null>([[ENTRY, null]]);
  const packages = new Map<string, string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!/\.[jt]sx?$/.test(file)) continue;
    const transpiler = new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" });
    for (const { path } of transpiler.scan(readFileSync(file, "utf8")).imports) {
      const next = fileFor(file, path);
      if (next === null) {
        if (!path.startsWith(".") && !packages.has(path)) packages.set(path, file);
      } else if (!cameFrom.has(next)) {
        cameFrom.set(next, file);
        queue.push(next);
      }
    }
  }
  return { cameFrom, packages };
}

function chain(cameFrom: Map<string, string | null>, file: string): string {
  const steps: string[] = [];
  for (let at: string | null | undefined = file; at; at = cameFrom.get(at)) steps.push(relative(ROOT, at));
  return steps.join(" <- ");
}

test("the browser bundle reaches neither Effect nor the storage core", () => {
  const { cameFrom, packages } = reachable();
  // The walk really followed the app: the entry leads to shared server modules.
  expect(cameFrom.size).toBeGreaterThan(100);
  expect(cameFrom.has(join(ROOT, "src/server/parser.ts"))).toBe(true);
  expect(packages.has("react")).toBe(true);

  const effectImports = [...packages]
    .filter(([name]) => name === "effect" || name.startsWith("effect/") || name.startsWith("@effect/"))
    .map(([name, from]) => `${name} <- ${chain(cameFrom, from)}`);
  expect(effectImports).toEqual([]);

  const services = [...cameFrom.keys()]
    .filter((file) => /^src\/server\/(persistence|sync|effect)\//.test(relative(ROOT, file)))
    .map((file) => chain(cameFrom, file));
  expect(services).toEqual([]);

  const facades = [
    "fsx.ts",
    "state.ts",
    "automerge/store.ts",
    "tokenStore.ts",
    "secrets.ts",
    "run.ts",
    "git/index.ts",
    "reload.ts",
  ]
    .map((name) => join(ROOT, "src/server", name))
    .filter((file) => cameFrom.has(file))
    .map((file) => chain(cameFrom, file));
  expect(facades).toEqual([]);
});
