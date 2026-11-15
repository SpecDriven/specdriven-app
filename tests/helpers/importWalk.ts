// Which modules an entry point pulls in, read from the source: every file
// reached through value imports (a type-only import is erased before
// bundling and does not count) and every package named along the way, each
// with the module that led to it. The guards that keep Effect out of a
// bundle — the browser's, the Confluence MCP server's — are built on it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = join(import.meta.dir, "../..");

const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function fileFor(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  for (const suffix of SUFFIXES) {
    const path = resolve(dirname(from), specifier + suffix);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

export interface Reached {
  /** Every file reached, with the file that imported it (null for the entry). */
  cameFrom: Map<string, string | null>;
  /** Every package named, with the first file that named it. */
  packages: Map<string, string>;
}

/** Every module `entry` reaches through value imports. */
export function reachableFrom(entry: string): Reached {
  const cameFrom = new Map<string, string | null>([[entry, null]]);
  const packages = new Map<string, string>();
  const queue = [entry];
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

/** How the entry got to `file`, as "file <- importer <- … <- entry". */
export function chain(cameFrom: Map<string, string | null>, file: string): string {
  const steps: string[] = [];
  for (let at: string | null | undefined = file; at; at = cameFrom.get(at)) steps.push(relative(ROOT, at));
  return steps.join(" <- ");
}

/** `effect` itself, one of its entry points, or an `@effect/*` package. */
export function isEffectPackage(name: string): boolean {
  return name === "effect" || name.startsWith("effect/") || name.startsWith("@effect/");
}

/** A file of the services built on Effect. */
export function isEffectService(file: string): boolean {
  return /^src\/server\/(persistence|sync|effect)\//.test(relative(ROOT, file));
}

/** What a walk reached that is Effect or built on it, each with its chain; empty when nothing. */
export function effectReached({ cameFrom, packages }: Reached): string[] {
  return [
    ...[...packages]
      .filter(([name]) => isEffectPackage(name))
      .map(([name, from]) => `${name} <- ${chain(cameFrom, from)}`),
    ...[...cameFrom.keys()].filter(isEffectService).map((file) => chain(cameFrom, file)),
  ];
}
