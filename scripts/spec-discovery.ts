// Ends a coding session with the specs caught up with the code. The
// behaviour this branch added — new source files, newly exported functions,
// new `/api` routes — is traced through the tests into the spec repo, and
// whatever no scenario describes is handed back as specs to write
// (../specs-specdriven, see its AGENTS.md).
//
// Behaviour is traced the way this repo already traces it: a scenario's
// `[test: … ]` link names a test file, and a test file that names a new
// export, or calls a new route, exercises it. So new behaviour is described
// when a scenario links a test that names it; it is a gap when no test
// names it at all, or when the only tests that do are linked from no
// scenario — there may be no scenario to link them to yet.
//
// Nothing here writes a spec: finding the gap is mechanical, wording the
// scenario is not. The stop hook hands the list to the agent that just
// wrote the code, while it still knows what the code does.
//
//   bun scripts/spec-discovery.ts           report the behaviour this branch added that no spec describes
//   bun scripts/spec-discovery.ts --base <ref>   compare against <ref> instead of the branch base
//   bun scripts/spec-discovery.ts --json    the same report as JSON
//   bun scripts/spec-discovery.ts --hook stop
//                                           Claude Code hook (.claude/settings.json)
//
// Set SPECDRIVEN_SPEC_DISCOVERY=off to silence the hook for a session.
//
// The spec repo is found the way test-links.ts finds it: $SPECDRIVEN_SPECS_DIR,
// else the checkout's specs/ symlink, else ../specs-specdriven/specs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { baseOf, git, linksIn, specsDir, walk } from "./test-links";

/** Source files whose behaviour a scenario could describe. */
const SOURCE = /^src\/.+\.tsx?$/;
/** Declaration files declare no behaviour. */
const NOT_SOURCE = /\.d\.ts$/;

/** A name this branch exported. Types and interfaces are shapes, not behaviour. */
const EXPORTED = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const)\s+([A-Za-z_$][\w$]*)/;
/** A route this branch served: `["GET", "/api/widgets", getWidgets],`. */
const ROUTE = /\[\s*"(GET|PUT|POST|PATCH|DELETE)"\s*,\s*"(\/api\/[^"]*)"/;

/** A new file below this, exporting nothing, is plumbing rather than behaviour. */
const MIN_NEW = 15;
/** How many files the report names before it counts the rest. */
const LIMIT = 12;
/** How many features it offers as the place a new scenario might belong. */
const RELATED = 3;
/** How many gaps it spells out for one file before it counts the rest. */
const GAPS = 8;

/** New behaviour nothing in the spec repo describes. */
export interface Gap {
  /** `export`, `route`, or `file` for a new file nothing reaches at all. */
  kind: "export" | "route" | "file";
  /** The exported name, the route, or the file. */
  name: string;
  /** Test files that exercise it, none of them linked from a scenario. */
  tests: string[];
}

/** What a branch did to one source file, and what of it is unspecified. */
export interface Change {
  /** Repo-relative path of the source file. */
  path: string;
  /** Whether the branch added the file. */
  isNew: boolean;
  /** Lines the branch added to it. */
  added: number;
  /** The new behaviour in it that no scenario describes. */
  gaps: Gap[];
  /** Features that already describe this file, most closely first. */
  related: string[];
}

export interface Discovery {
  /** Changed files carrying behaviour no scenario describes. */
  changes: Change[];
  /** Spec files this branch has already written. */
  written: string[];
}

// --- Reading the diff -----------------------------------------------------

/** One source file in a diff, with the lines it gained. */
export interface Hunk {
  path: string;
  isNew: boolean;
  added: string[];
}

/**
 * The source files a `git diff -U0` touched, with the lines added to each.
 * `untracked("")` lists the files git does not track yet; `untracked(path)`
 * reads one, whose every line counts as added.
 */
export function hunks(diff: string, untracked: (path: string) => string[]): Hunk[] {
  const out: Hunk[] = [];
  let current: Hunk | null = null;
  let isNew = false;
  let minus = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      isNew = false;
      minus = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      isNew = true;
      continue;
    }
    // `+++ b/<path>` heads a file only right after the `--- ` it pairs with.
    // Anywhere else it is a line of the file.
    if (minus) {
      minus = false;
      const head = line.match(/^\+\+\+ b\/(.+)$/);
      if (head) {
        current = { path: head[1]!, isNew, added: [] };
        if (SOURCE.test(current.path) && !NOT_SOURCE.test(current.path)) out.push(current);
        else current = null;
        continue;
      }
    }
    if (line.startsWith("--- ")) {
      minus = true;
      continue;
    }
    if (current && line.startsWith("+")) current.added.push(line.slice(1));
  }
  for (const path of untracked("")) {
    if (!SOURCE.test(path) || NOT_SOURCE.test(path)) continue;
    out.push({ path, isNew: true, added: untracked(path) });
  }
  return out;
}

/** The behaviour the added lines put on offer. */
export function surface(added: string[]): { exports: string[]; routes: string[] } {
  const exports: string[] = [];
  const routes: string[] = [];
  for (const line of added) {
    const name = line.match(EXPORTED);
    if (name) exports.push(name[1]!);
    const route = line.match(ROUTE);
    if (route) routes.push(`${route[1]} ${route[2]}`);
  }
  return { exports: [...new Set(exports)], routes: [...new Set(routes)] };
}

// --- What the tests, and so the scenarios, already reach ------------------

/** The relative paths a source file imports. */
export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'`]([^"'`]+)["'`]/g)) {
    if (m[1]!.startsWith(".")) out.push(m[1]!);
  }
  return out;
}

/** The source file an import of `spec` from `from` names, if it is one. */
export function resolveImport(from: string, spec: string, exists: (path: string) => boolean): string | null {
  const base = join(dirname(from), spec);
  for (const path of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (SOURCE.test(path) && !NOT_SOURCE.test(path) && exists(path)) return path;
  }
  return null;
}

/**
 * Whether a test file exercises a piece of surface. An export is named as a
 * whole word; a route is called by its path, up to its first parameter, so
 * `POST /api/widgets/:id/archive` is reached by `/api/widgets/abc/archive`.
 */
export function exercises(test: string, kind: Gap["kind"], name: string): boolean {
  if (kind === "route") {
    const path = name.slice(name.indexOf(" ") + 1).split("/:")[0]!;
    return path.length > "/api/".length && test.includes(path);
  }
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(test);
}

interface Traced {
  /** Test file → its text. */
  text: Map<string, string>;
  /** Test file → the features whose scenarios link into it. */
  linkedBy: Map<string, string[]>;
  /** Source file → the test files that import it, closest first. */
  importers: Map<string, string[]>;
}

/** Reads the tests and the specs once, and maps out what reaches what. */
function trace(root: string, specs: string): Traced {
  const text = new Map<string, string>();
  for (const abs of walk(join(root, "tests"), (n) => /\.(ts|tsx|js|jsx|py|rb|go|java|cs)$/.test(n))) {
    text.set(relative(root, abs), readFileSync(abs, "utf8"));
  }

  const links = new Map<string, Map<string, number>>();
  for (const spec of walk(specs, (n) => n.endsWith(".md"))) {
    for (const link of linksIn(spec, readFileSync(spec, "utf8"))) {
      const counts = links.get(link.path) ?? new Map<string, number>();
      const feature = relative(dirname(specs), spec);
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
      links.set(link.path, counts);
    }
  }
  const linkedBy = new Map<string, string[]>();
  for (const [path, counts] of links) {
    linkedBy.set(
      path,
      [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([feature]) => feature),
    );
  }

  const importers = new Map<string, string[]>();
  for (const [path, source] of text) {
    for (const imported of importsOf(source)) {
      const target = resolveImport(path, imported, (p) => existsSync(join(root, p)));
      if (!target) continue;
      importers.set(target, [...(importers.get(target) ?? []), path]);
    }
  }
  return { text, linkedBy, importers };
}

// --- Running against the real repos ---------------------------------------

/** The behaviour `root` gained since `base` that the spec repo does not describe. */
export function discover(root: string, base: string): Discovery | null {
  const specs = specsDir(root);
  if (!specs) return null;
  const diff = git(root, "diff", "-U0", base, "--", "src") ?? "";
  const others = (git(root, "ls-files", "--others", "--exclude-standard", "--", "src") ?? "")
    .split("\n")
    .filter(Boolean);
  const untracked = (path: string) => (path === "" ? others : readFileSync(join(root, path), "utf8").split("\n"));
  const t = trace(root, specs);

  /** The gap a piece of surface leaves, or null when a scenario already reaches it. */
  const gapOf = (kind: Gap["kind"], name: string): Gap | null => {
    const tests: string[] = [];
    for (const [path, source] of t.text) {
      if (!exercises(source, kind, name)) continue;
      if (t.linkedBy.has(path)) return null;
      tests.push(path);
    }
    return { kind, name, tests: tests.sort() };
  };

  const changes: Change[] = [];
  for (const h of hunks(diff, untracked)) {
    const { exports, routes } = surface(h.added);
    const gaps = [
      ...routes.map((r) => gapOf("route", r)),
      ...exports.map((e) => gapOf("export", e)),
    ].filter((g): g is Gap => g !== null);
    // A new file of any substance that exports nothing still holds
    // behaviour, unless a scenario's test already reaches it.
    if (!exports.length && !routes.length) {
      if (!h.isNew || h.added.length < MIN_NEW) continue;
      const tests = (t.importers.get(h.path) ?? []).filter((p) => !t.linkedBy.has(p));
      if (tests.length !== (t.importers.get(h.path) ?? []).length) continue;
      gaps.push({ kind: "file", name: h.path, tests: tests.sort() });
    }
    if (!gaps.length) continue;
    // The features most of this file's tests are linked from, most first.
    const votes = new Map<string, number>();
    for (const test of t.importers.get(h.path) ?? []) {
      for (const feature of t.linkedBy.get(test) ?? []) votes.set(feature, (votes.get(feature) ?? 0) + 1);
    }
    const related = [...votes]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, RELATED)
      .map(([feature]) => feature);
    changes.push({ path: h.path, isNew: h.isNew, added: h.added.length, gaps, related });
  }

  const weight = (c: Change) => -(c.gaps.length + (c.isNew ? 3 : 0));
  changes.sort((a, b) => weight(a) - weight(b) || a.path.localeCompare(b.path));
  return { changes, written: written(specs) };
}

/** The spec files this session has already written. */
function written(specs: string): string[] {
  const root = git(specs, "rev-parse", "--show-toplevel");
  if (!root) return [];
  const changed = [
    git(root, "diff", "--name-only", baseOf(root)) ?? "",
    git(root, "ls-files", "--others", "--exclude-standard") ?? "",
  ].join("\n");
  return [...new Set(changed.split("\n").filter((p) => p.endsWith(".feature.md")))].sort();
}

// --- Saying it ------------------------------------------------------------

function sayGap(g: Gap): string {
  const what = g.kind === "file" ? "the file itself" : g.kind === "route" ? `route ${g.name}` : g.name;
  const by = g.tests.length
    ? `exercised by ${g.tests.slice(0, 3).join(", ")}${g.tests.length > 3 ? ", …" : ""}, which no scenario links`
    : "no test exercises it";
  return `      ${what} — ${by}`;
}

export function report(found: Discovery): string {
  if (!found.changes.length) return "";
  const shown = found.changes.slice(0, LIMIT).map((c) => {
    const head = `  - ${c.path} (${c.isNew ? `new file, ${c.added} lines` : `+${c.added} lines`})`;
    const related = c.related.length ? `\n      perhaps belongs in: ${c.related.join(", ")}` : "";
    const gaps = c.gaps.slice(0, GAPS).map(sayGap);
    if (c.gaps.length > gaps.length) gaps.push(`      …and ${c.gaps.length - gaps.length} more export(s)`);
    return `${head}\n${gaps.join("\n")}${related}`;
  });
  const rest = found.changes.length - shown.length;
  return (
    `New behaviour on this branch that no scenario in the spec repo describes:\n${shown.join("\n")}` +
    `${rest > 0 ? `\n  - …and ${rest} more file(s)` : ""}\n` +
    (found.written.length ? `\nSpec files already written on this branch: ${found.written.join(", ")}\n` : "")
  );
}

const HOW =
  "Specs live in the spec repo beside this one (the checkout's specs/ symlink). Write them the way its " +
  "AGENTS.md says: one feature per `specs/<area>/<slug>.feature.md`, a `# <name>` heading, then scenarios " +
  "`## S<n>: <name> @v1 [proposed]` numbered in file order, with `- **Given** / **When** / **Then**` steps. " +
  "Put the behaviour in a feature that already covers the area; start a new file only for a new one. Never " +
  "write `[published]` — publishing is a human act. End each scenario with a `[test: <test title> : " +
  "https://github.com/SpecDriven/specdriven-app/blob/main/<path>#L<line> ]` line for every test that " +
  "automates it, then run `bun scripts/test-links.ts --changed` to check them. Describe the behaviour a " +
  "user would notice, not the code: one scenario per behaviour. Anything on the list that a user could " +
  "never notice — a refactor, an internal helper, a build detail — needs no spec: say which, and why, " +
  "and stop.";

// --- The hook -------------------------------------------------------------

async function hook(): Promise<void> {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  if (process.env.SPECDRIVEN_SPEC_DISCOVERY === "off") return;
  const root = git(input.cwd ?? process.cwd(), "rev-parse", "--show-toplevel");
  if (!root || !existsSync(join(root, "scripts", "spec-discovery.ts"))) return;
  const found = discover(root, baseOf(root));
  if (!found || !found.changes.length) return;

  // One nudge per stop: when Claude already carried on for this, let it stop.
  if (input.stop_hook_active) {
    console.log(JSON.stringify({ systemMessage: "Some of this branch's new behaviour is still unspecified." }));
    return;
  }
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `This session added behaviour the specs do not describe yet. Write the specs into the spec folder before finishing.\n\n${report(found)}\n${HOW}`,
    }),
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--hook")) {
    // A hook must never get in the way of the stop it follows.
    try {
      await hook();
    } catch (e) {
      console.error(`spec-discovery hook: ${e instanceof Error ? e.message : e}`);
    }
    process.exit(0);
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : baseOf(root);
  const found = discover(root, base);
  if (!found) {
    console.error("spec-discovery: no spec folder found (set SPECDRIVEN_SPECS_DIR)");
    process.exit(1);
  }
  if (args.includes("--json")) console.log(JSON.stringify(found, null, 2));
  else console.log(report(found) || `Nothing new since ${base} that the specs do not describe.`);
}
