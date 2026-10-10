// Keeps the spec repo's `[test: <name> : <url>#L<n> ]` links to this repo's
// tests honest (specs/external-links/test-traceability.feature.md). A link
// is right when the anchored line declares the named test — read the way
// the app reads it, through testNameAt. When a test only moved, the link is
// re-anchored (or re-pointed at the file it moved to); when no test of
// that name is left, the link is reported as broken. Tests added on this
// branch that no scenario links to are reported too.
//
//   bun scripts/test-links.ts               report every link into this repo
//   bun scripts/test-links.ts --fix         …and re-anchor the ones that drifted
//   bun scripts/test-links.ts --changed     only links to tests changed on this branch
//   bun scripts/test-links.ts --hook post-tool-use | stop
//                                           Claude Code hooks (.claude/settings.json)
//
// The spec repo is found at $SPECDRIVEN_SPECS_DIR, else the checkout's
// specs/ symlink, else ../specs-specdriven/specs beside the main checkout
// (the symlink dangles inside .claude/worktrees).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isTestName } from "../src/server/parser";
import { declaredTest, languageOf, testNameAt } from "../src/server/testName";

/** A link url into this repo: `…/specdriven-app/blob/<ref>/<path>#L<n>`. */
const OWN_URL = /^(https:\/\/github\.com\/SpecDriven\/specdriven[-_]app\/blob\/[^/]+\/)(tests\/[^#?\s]+)#L(\d+)(?:-L\d+)?$/;
/** A `[test: … ]` token; group 1 is its text. */
const TOKEN = /\[test:\s*([^\]\n]*?)\s*\]/g;

export interface Link {
  /** The spec file, absolute. */
  spec: string;
  /** 1-based line in the spec file. */
  specLine: number;
  name: string | null;
  url: string;
  /** Repo-relative path of the test file. */
  path: string;
  line: number;
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "fix"; name: string; path: string; line: number; why: string }
  | { kind: "broken"; why: string };

/** A test declaration: its name and the 1-based lines its head spans. */
interface Declared {
  name: string;
  start: number;
  end: number;
}

/** How far a multi-line `test.each([` table may run before its `])("title"`. */
const EACH_SPAN = 80;

/**
 * The tests `source` declares. Beyond what declaredTest reads off one line,
 * a JS/TS `test.each([` whose rows run over several lines is named by the
 * `])("title"` that closes it — testNameAt does not see those.
 */
function declared(source: string, language: NonNullable<ReturnType<typeof languageOf>>): Declared[] {
  const lines = source.split("\n");
  const out: Declared[] = [];
  lines.forEach((text, i) => {
    const name = declaredTest(text, language);
    if (name) {
      out.push({ name, start: i + 1, end: i + 1 });
      return;
    }
    if (language !== "javascript" || !/^\s*(?:test|it)(?:\.\w+)*\.each\s*\(/.test(text)) return;
    for (let j = i + 1; j < lines.length && j <= i + EACH_SPAN; j++) {
      const close = lines[j]!.match(/^\s*\]?\s*\)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
      if (close) {
        out.push({ name: close[2]!.trim(), start: i + 1, end: j + 1 });
        return;
      }
    }
  });
  return out;
}

/**
 * Whether a link's name names a declared title. A template title stands for
 * every title it can produce — `… removed (${engine} engine)` — so a name
 * matches its pattern, or its fixed text up to the first `${`.
 */
export function sameTest(name: string, title: string): boolean {
  if (name === title) return true;
  if (!title.includes("${")) return false;
  const pattern = title
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+?");
  if (new RegExp(`^${pattern}$`).test(name)) return true;
  const head = title.slice(0, title.indexOf("${")).replace(/[\s(\[{,:—-]+$/, "");
  return head.length > 0 && name === head;
}

/** The test the anchored line names: inside a multi-line `test.each` head, else testNameAt's answer. */
function nameAt(source: string, line: number, language: NonNullable<ReturnType<typeof languageOf>>): string | null {
  const each = declared(source, language).find((d) => d.end > d.start && line >= d.start && line <= d.end);
  return each ? each.name : testNameAt(source, line, language);
}

/** The test titles (`test(…)`/`it(…)`, `.each` tables included) a JS/TS source declares. */
export function testTitles(source: string): { name: string; line: number }[] {
  const lines = source.split("\n");
  return declared(source, "javascript")
    .filter((d) => /^\s*(?:test|it|Deno\.test)\b/.test(lines[d.start - 1]!))
    .map((d) => ({ name: d.name, line: d.start }));
}

/** The declarations of a test named `name` in `source`. */
function declarations(source: string, path: string, name: string): Declared[] {
  const language = languageOf(path);
  if (!language) return [];
  return declared(source, language).filter((d) => sameTest(name, d.name));
}

/** Whether index `at` of `line` falls inside an inline code span. */
function inCode(line: string, at: number): boolean {
  return (line.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1;
}

/** The links into this repo's tests that a spec file carries, outside code. */
export function linksIn(spec: string, text: string): Link[] {
  const links: Link[] = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(TOKEN)) {
      if (inCode(line, m.index!)) continue;
      const ref = m[1]!.match(/^(?:([^:]*?)\s*:\s*)?(https?:\/\/\S+)$/);
      const own = ref?.[2]!.match(OWN_URL);
      if (!ref || !own) continue;
      links.push({
        spec,
        specLine: i + 1,
        name: ref[1]?.trim() || null,
        url: ref[2]!,
        path: own[2]!,
        line: Number(own[3]),
      });
    }
  });
  return links;
}

/**
 * What to do about one link, given a reader for the repo's files (null for
 * a missing one) and the list of test files to search when one moved.
 */
export function judge(link: Link, read: (path: string) => string | null, testFiles: string[]): Verdict {
  const source = read(link.path);
  const language = languageOf(link.path);
  if (source !== null && !language) return { kind: "ok" };
  const at = source !== null ? nameAt(source, link.line, language!) : null;

  const name = link.name ?? at;
  if (!name || !isTestName(name)) {
    return { kind: "broken", why: at ? `the test at the anchor, "${at}", has a name a link cannot carry (no ":" or "]")` : "a bare url with no test at its anchor" };
  }
  if (source !== null) {
    const found = declarations(source, link.path, name);
    // Right when it sits on the declaration itself; an anchor the app still
    // reads as this test (a blank line above it, a line in its body) is
    // drift all the same, and moved onto the declaration.
    if (link.name && found.some((d) => link.line >= d.start && link.line <= d.end)) return { kind: "ok" };
    if (found.length) {
      const nearest = found
        .map((d) => d.start)
        .reduce((a, b) => (Math.abs(b - link.line) < Math.abs(a - link.line) ? b : a));
      const why = !link.name ? "named the test" : nearest === link.line ? "" : `moved from line ${link.line}`;
      return { kind: "fix", name, path: link.path, line: nearest, why };
    }
  }
  const elsewhere = testFiles.flatMap((path) => {
    if (path === link.path) return [];
    const text = read(path);
    return text === null ? [] : declarations(text, path, name).map((d) => ({ path, line: d.start }));
  });
  if (elsewhere.length === 1) {
    return { kind: "fix", name, path: elsewhere[0]!.path, line: elsewhere[0]!.line, why: `moved from ${link.path}` };
  }
  if (source === null) return { kind: "broken", why: `${link.path} no longer exists` };
  return {
    kind: "broken",
    why: elsewhere.length
      ? `no test "${name}" in ${link.path}, and ${elsewhere.length} other files declare one`
      : `no test "${name}" in ${link.path} (renamed or deleted?)${at ? `; the anchor now sits in "${at}"` : ""}`,
  };
}

/** The url a fixed link points at, keeping its `…/blob/<ref>/` prefix. */
export function fixedUrl(url: string, path: string, line: number): string {
  return url.replace(OWN_URL, (_, prefix: string) => `${prefix}${path}#L${line}`);
}

/** `text` with every token whose text is a key in `rewrites` rewritten, code left alone. */
export function rewrite(text: string, rewrites: Map<string, string>): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(TOKEN, (token, inner: string, at: number) => {
        const to = rewrites.get(inner);
        return to && !inCode(line, at) ? `[test: ${to} ]` : token;
      });
    })
    .join("\n");
}

// --- Running against the real repos ---------------------------------------

function git(cwd: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function specsDir(root: string): string | null {
  const candidates = [process.env.SPECDRIVEN_SPECS_DIR, join(root, "specs")];
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common) candidates.push(join(dirname(common), "..", "specs-specdriven", "specs"));
  for (const c of candidates) {
    if (c && existsSync(c) && statSync(c).isDirectory()) return realpathSync(c);
  }
  return null;
}

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, keep, out);
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

/** The branch's base: where it left origin/main, else HEAD. */
function baseOf(root: string): string {
  return git(root, "merge-base", "HEAD", "origin/main") ?? "HEAD";
}

/** Test files changed on this branch, committed or not, repo-relative. */
function changedTests(root: string, base: string): string[] {
  const tracked = git(root, "diff", "--name-only", base, "--", "tests") ?? "";
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "--", "tests") ?? "";
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter((p) => p && languageOf(p)))];
}

export interface Report {
  fixed: string[];
  broken: string[];
  unlinked: string[];
  checked: number;
}

/**
 * Check (and with `fix`, re-anchor) the links into `root`'s tests. `only`
 * limits it to links into those test files; `newSince` also lists tests
 * added since that commit, in those files, that no scenario links to.
 */
export function run(root: string, opts: { fix: boolean; only?: string[]; newSince?: string }): Report | null {
  const specs = specsDir(root);
  if (!specs) return null;
  const testFiles = walk(join(root, "tests"), (n) => languageOf(n) !== null).map((p) => relative(root, p));
  const cache = new Map<string, string | null>();
  const read = (path: string) => {
    if (!cache.has(path)) {
      const abs = join(root, path);
      cache.set(path, existsSync(abs) ? readFileSync(abs, "utf8") : null);
    }
    return cache.get(path)!;
  };
  const show = (spec: string) => relative(dirname(specs), spec);

  const report: Report = { fixed: [], broken: [], unlinked: [], checked: 0 };
  const all: Link[] = [];
  for (const spec of walk(specs, (n) => n.endsWith(".md"))) {
    const text = readFileSync(spec, "utf8");
    const links = linksIn(spec, text);
    all.push(...links);
    const rewrites = new Map<string, string>();
    for (const link of links) {
      if (opts.only && !opts.only.includes(link.path)) continue;
      report.checked++;
      const verdict = judge(link, read, testFiles);
      const where = `${show(spec)}:${link.specLine}`;
      if (verdict.kind === "broken") {
        report.broken.push(`${where} [test: ${link.name ?? "(no name)"} : ${link.path}#L${link.line} ] — ${verdict.why}`);
      } else if (verdict.kind === "fix") {
        const from = link.name ? `${link.name} : ${link.url}` : link.url;
        const to = `${verdict.name} : ${fixedUrl(link.url, verdict.path, verdict.line)}`;
        rewrites.set(from, to);
        report.fixed.push(`${where} "${verdict.name}" → ${verdict.path}#L${verdict.line} (${verdict.why})`);
      }
    }
    if (opts.fix && rewrites.size) {
      const next = rewrite(text, rewrites);
      if (next !== text) writeFileSync(spec, next);
    }
  }

  if (opts.newSince && opts.only) {
    const linked = new Set(all.map((l) => `${l.path}\0${l.name}`));
    for (const path of opts.only) {
      const now = read(path);
      if (now === null || languageOf(path) !== "javascript") continue;
      const before = new Set(testTitles(git(root, "show", `${opts.newSince}:${path}`) ?? "").map((t) => t.name));
      for (const t of testTitles(now)) {
        if (before.has(t.name) || linked.has(`${path}\0${t.name}`)) continue;
        report.unlinked.push(
          `${path}#L${t.line} "${t.name}"${isTestName(t.name) ? "" : " — its title has \":\" or \"]\", which a link cannot carry; reword it first"}`,
        );
      }
    }
  }
  return report;
}

function list(title: string, items: string[]): string {
  return items.length ? `${title}\n${items.map((i) => `  - ${i}`).join("\n")}\n` : "";
}

const HOW =
  `Links are \`[test: <test title> : https://github.com/SpecDriven/specdriven-app/blob/main/<path>#L<line> ]\` lines at the end of a scenario ` +
  `in the spec repo (../specs-specdriven/specs/<area>/<name>.feature.md); the title is the test("…") title, without ":" or "]". ` +
  `Rerun \`bun scripts/test-links.ts --changed --fix\` after fixing.`;

async function hook(kind: string): Promise<void> {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  const cwd: string = input.cwd ?? process.cwd();

  if (kind === "post-tool-use") {
    const file: string | undefined = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!file) return;
    const abs = resolve(cwd, file);
    if (!existsSync(dirname(abs))) return;
    const root = git(dirname(abs), "rev-parse", "--show-toplevel");
    if (!root || !existsSync(join(root, "scripts", "test-links.ts"))) return;
    const path = relative(realpathSync(root), existsSync(abs) ? realpathSync(abs) : abs);
    if (!path.startsWith("tests/") || !languageOf(path)) return;
    const report = run(root, { fix: true, only: [path] });
    if (!report || (!report.fixed.length && !report.broken.length)) return;
    const context =
      list(`Spec test links re-anchored after the edit to ${path}:`, report.fixed) +
      list(`Spec test links into ${path} that are now broken — fix the link (or the test) before finishing:`, report.broken) +
      (report.broken.length ? HOW : "");
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
    return;
  }

  if (kind === "stop") {
    const root = git(cwd, "rev-parse", "--show-toplevel");
    if (!root || !existsSync(join(root, "scripts", "test-links.ts"))) return;
    const base = baseOf(root);
    const changed = changedTests(root, base);
    if (!changed.length) return;
    const report = run(root, { fix: true, only: changed, newSince: base });
    if (!report) return;
    const fixedNote = report.fixed.length ? `Re-anchored ${report.fixed.length} spec test link(s) to moved tests.` : "";
    if (!report.broken.length && !report.unlinked.length) {
      if (fixedNote) console.log(JSON.stringify({ systemMessage: fixedNote }));
      return;
    }
    const reason =
      list("Spec test links that no longer name the test at their anchor:", report.broken) +
      list(
        "Tests added on this branch that no scenario links to — add a link under the scenario each one verifies (or say why it has none):",
        report.unlinked,
      ) +
      HOW;
    // One nudge per stop: when Claude already continued for this, let it stop.
    if (input.stop_hook_active) {
      console.log(JSON.stringify({ systemMessage: `Spec test links still need attention:\n${reason}` }));
      return;
    }
    console.log(JSON.stringify({ decision: "block", reason, ...(fixedNote ? { systemMessage: fixedNote } : {}) }));
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const hookKind = args.includes("--hook") ? args[args.indexOf("--hook") + 1] : null;
  if (hookKind) {
    // A hook must never get in the way of the edit or the stop it follows.
    try {
      await hook(hookKind);
    } catch (e) {
      console.error(`test-links hook: ${e instanceof Error ? e.message : e}`);
    }
    process.exit(0);
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const base = baseOf(root);
  const changed = args.includes("--changed") ? changedTests(root, base) : undefined;
  const report = run(root, { fix: args.includes("--fix"), only: changed, newSince: changed ? base : undefined });
  if (!report) {
    console.error("No spec repo found: set SPECDRIVEN_SPECS_DIR or check out ../specs-specdriven.");
    process.exit(1);
  }
  process.stdout.write(
    `${report.checked} links checked.\n` +
      list(args.includes("--fix") ? "Re-anchored:" : "Drifted (rerun with --fix):", report.fixed) +
      list("Broken:", report.broken) +
      list("New tests no scenario links to:", report.unlinked),
  );
  process.exit(report.broken.length || report.unlinked.length || (!args.includes("--fix") && report.fixed.length) ? 1 : 0);
}
