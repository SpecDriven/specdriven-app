// Search in the open code repository (specs/app/code-search.feature.md):
// every file the repository does not ignore, found by name, and their text
// found by a string or a pattern. There is no index: the file list is read
// again every few seconds and the text is read from disk on every search,
// so a result is never older than the files. Node APIs only: this module
// also runs under Electron (src/server/run.ts).

import fuzzysort from "fuzzysort";
import ignore, { type Ignore } from "ignore";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FilesError, MAX_FILE_BYTES, SNIFF_BYTES } from "./files";
import { run, which } from "./run";

// --- Which files there are ----------------------------------------------------

/**
 * `git ls-files`, read-only: the tracked files and the untracked ones the
 * repository's ignore rules let through, relative to `root`. Null without
 * git, or when `root` is not in a git repository.
 */
export async function gitRepoFiles(root: string): Promise<string[] | null> {
  if (which("git") === null) return null;
  const res = await run("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (res.exitCode !== 0) return null;
  // A file in a merge conflict is listed once per stage.
  return [...new Set(res.stdout.split("\0").filter(Boolean))].sort();
}

/**
 * The same list without git: the tree walked from `root`, leaving out `.git`
 * and what the `.gitignore` files on the way down exclude. A deeper file's
 * rule wins over a shallower one, as in git.
 */
export async function walkRepoFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  type Rules = { base: string; rules: Ignore }[];
  async function visit(rel: string, above: Rules): Promise<void> {
    const dirents = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }).catch(() => null);
    if (!dirents) return;
    let here = above;
    if (dirents.some((d) => d.name === ".gitignore" && d.isFile())) {
      const text = await readFile(join(root, rel, ".gitignore"), "utf8").catch(() => "");
      if (text.trim()) here = [...above, { base: rel, rules: ignore().add(text) }];
    }
    const ignored = (path: string, dir: boolean): boolean => {
      for (let i = here.length - 1; i >= 0; i--) {
        const { base, rules } = here[i]!;
        const verdict = rules.test((base ? path.slice(base.length + 1) : path) + (dir ? "/" : ""));
        if (verdict.ignored) return true;
        if (verdict.unignored) return false;
      }
      return false;
    };
    const folders: Promise<void>[] = [];
    for (const d of dirents) {
      if (d.name === ".git") continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!ignored(path, true)) folders.push(visit(path, here));
      } else if ((d.isFile() || d.isSymbolicLink()) && !ignored(path, false)) {
        out.push(path);
      }
    }
    await Promise.all(folders);
  }
  await visit("", []);
  return out.sort();
}

/** One file of the list, as the name search sees it. */
interface NamedFile {
  path: string;
  name: string;
}

interface RepoFiles {
  files: string[];
  /** The list prepared for the name search, made on its first use. */
  names?: ReturnType<typeof snapshotNames>;
}

function snapshotNames(files: string[]) {
  const named: NamedFile[] = files.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
  return fuzzysort.snapshot(named, { keys: ["name", "path"] });
}

/** How long a file list is good for: a new file shows in a search this soon. */
const LIST_TTL_MS = 3000;

let listed: { root: string; at: number; files: Promise<RepoFiles> } | null = null;

/** The repository's files — git's list, or the walk's — kept for LIST_TTL_MS. */
function listRepoFiles(root: string): Promise<RepoFiles> {
  const key = resolve(root);
  if (listed && listed.root === key && Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  const files = (async (): Promise<RepoFiles> => ({ files: (await gitRepoFiles(key)) ?? (await walkRepoFiles(key)) }))();
  const entry = { root: key, at: Date.now(), files };
  listed = entry;
  // The time runs from when the list was read; a failed read is not kept.
  files.then(
    () => {
      entry.at = Date.now();
    },
    () => {
      if (listed === entry) listed = null;
    },
  );
  return files;
}

/** Drop the kept list: the next search reads the files again. */
export function forgetRepoFiles(): void {
  listed = null;
}

// --- Find a file by name ------------------------------------------------------

/** A file whose name or path matches what was typed. */
export interface FileHit {
  path: string;
  name: string;
  /** The matched characters, as indexes into `path`. */
  indexes: number[];
}

/**
 * The files whose name or path holds the typed characters in order, best
 * first: a hit in the name counts for more than one in the folders, and
 * the start of a word for more than its middle. `total` is how many
 * matched before the limit.
 */
export async function findFiles(root: string, query: string, limit = 50): Promise<{ results: FileHit[]; total: number }> {
  const search = query.trim();
  if (!search) return { results: [], total: 0 };
  const repo = await listRepoFiles(root);
  repo.names ??= snapshotNames(repo.files);
  const found = fuzzysort.go(search, repo.names, {
    limit,
    threshold: 0.3,
    scoreFn: (r) => Math.max(r[0]!.score, r[1]!.score * 0.9),
  });
  const results = found.map((r): FileHit => {
    const { path, name } = r.obj;
    const [inName, inPath] = [r[0]!, r[1]!];
    const offset = path.length - name.length;
    const indexes =
      inName.score > 0 && inName.score >= inPath.score * 0.9
        ? inName.indexes.map((i) => i + offset)
        : [...inPath.indexes];
    return { path, name, indexes: indexes.sort((a, b) => a - b) };
  });
  return { results, total: found.total };
}

// --- Find text ----------------------------------------------------------------

export interface SearchOptions {
  query: string;
  /** Upper and lower case are told apart. */
  caseSensitive?: boolean;
  /** Only whole words match. */
  wholeWord?: boolean;
  /** The query is a regular expression (JavaScript's), not the text itself. */
  regex?: boolean;
  /** Stop after this many files with a match. */
  maxFiles?: number;
  /** Stop after this many matches. */
  maxMatches?: number;
}

/** One match, with the line it is on for the result list. */
export interface LineMatch {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 units like the editor's. */
  col: number;
  /** How many units of the line matched. */
  length: number;
  /** The line, without its indent and shortened around the match. */
  text: string;
  /** Where the match is in `text`. */
  start: number;
  end: number;
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
  /** The file has more matches than are listed. */
  more?: boolean;
}

export interface SearchSummary {
  /** Files with a match. */
  files: number;
  matches: number;
  /** Files looked at. */
  scanned: number;
  /** The search stopped at its limit: there may be more. */
  truncated: boolean;
  ms: number;
}

const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_MATCHES = 2000;
const MAX_FILE_MATCHES = 100;
const PREVIEW_CHARS = 200;
/** How much of a line is kept before a match that sits further in: the
    sidebar is narrow, and the match has to show. */
const PREVIEW_LEAD = 16;
const READS_AT_ONCE = 32;

/** A search ready to run: the pattern, and the bytes a file must hold to be worth decoding. */
export interface CompiledSearch {
  pattern: RegExp;
  literal: Buffer | null;
}

/** Turn the options into a pattern; a regular expression that does not parse is refused (400). */
export function compileSearch(options: SearchOptions): CompiledSearch {
  if (!options.query) throw new FilesError(400, "Nothing to search for");
  let source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  let pattern: RegExp;
  try {
    // `m`: ^ and $ are a line's, since a result is a line.
    pattern = new RegExp(source, options.caseSensitive ? "gm" : "gim");
  } catch (e) {
    // The engine's own words, without its preamble and the pattern said back.
    const why = (e as Error).message.replace(/^Invalid regular expression:\s*(\/.*\/[a-z]*:\s*)?/, "");
    throw new FilesError(400, `Not a regular expression: ${why}`);
  }
  // Plain text in its own case is looked for in the bytes first, which
  // spares decoding the files that do not hold it — most of them.
  const literal = !options.regex && options.caseSensitive ? Buffer.from(options.query, "utf8") : null;
  return { pattern, literal };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The matches in one text, line by line. */
export function matchLines(text: string, pattern: RegExp): { matches: LineMatch[]; more: boolean } {
  const matches: LineMatch[] = [];
  let line = 1;
  let lineStart = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    if (matches.length === MAX_FILE_MATCHES) return { matches, more: true };
    for (let nl = text.indexOf("\n", lineStart); nl !== -1 && nl < m.index; nl = text.indexOf("\n", lineStart)) {
      line++;
      lineStart = nl + 1;
    }
    let lineEnd = text.indexOf("\n", m.index);
    if (lineEnd === -1) lineEnd = text.length;
    if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd--;
    // A match that runs over the line's end is shown as far as the line goes.
    const matchEnd = Math.min(m.index + m[0].length, lineEnd);
    if (matchEnd <= m.index) continue;
    const raw = text.slice(lineStart, lineEnd);
    const at = m.index - lineStart;
    const indent = Math.min(raw.length - raw.trimStart().length, at);
    const from = at - indent > PREVIEW_LEAD + 8 ? at - PREVIEW_LEAD : indent;
    const to = Math.min(raw.length, from + PREVIEW_CHARS);
    const lead = from > indent ? "…" : "";
    matches.push({
      line,
      col: at + 1,
      length: matchEnd - m.index,
      text: lead + raw.slice(from, to) + (to < raw.length ? "…" : ""),
      start: at - from + lead.length,
      end: Math.min(matchEnd - lineStart, to) - from + lead.length,
    });
  }
  return { matches, more: false };
}

/**
 * One file's matches, or null: it has none, or it is not text the editor
 * would open — a link, larger than MAX_FILE_BYTES, binary, not UTF-8.
 */
async function searchFile(abs: string, path: string, search: CompiledSearch): Promise<FileMatches | null> {
  const info = await lstat(abs).catch(() => null);
  if (!info || !info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
  const bytes = await readFile(abs).catch(() => null);
  if (!bytes || bytes.subarray(0, SNIFF_BYTES).includes(0)) return null;
  if (search.literal && bytes.indexOf(search.literal) === -1) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  const { matches, more } = matchLines(text, search.pattern);
  if (matches.length === 0) return null;
  return more ? { path, matches, more } : { path, matches };
}

/**
 * Search the repository's text. Files are read several at a time but
 * reported in path order, each as soon as the ones before it are done, so
 * the first results show while the rest is still being read. Stops at the
 * limits, or when `signal` aborts.
 */
export async function searchRepo(
  root: string,
  options: SearchOptions,
  onFile: (file: FileMatches) => void,
  signal?: AbortSignal,
): Promise<SearchSummary> {
  const started = performance.now();
  const search = compileSearch(options);
  const maxFiles = options.maxFiles ?? MAX_SEARCH_FILES;
  const maxMatches = options.maxMatches ?? MAX_SEARCH_MATCHES;
  const { files } = await listRepoFiles(root);
  const base = resolve(root);
  const done = new Map<number, FileMatches | null>();
  let next = 0;
  let reported = 0;
  let hitFiles = 0;
  let matches = 0;
  let truncated = false;
  const stopped = () => truncated || signal?.aborted === true;

  const report = () => {
    while (!stopped() && done.has(reported)) {
      const file = done.get(reported)!;
      done.delete(reported++);
      if (!file) continue;
      const room = maxMatches - matches;
      const shown = file.matches.length > room ? { ...file, matches: file.matches.slice(0, room), more: true } : file;
      hitFiles++;
      matches += shown.matches.length;
      onFile(shown);
      if (hitFiles >= maxFiles || matches >= maxMatches) truncated = reported < files.length || shown.more === true;
      if (hitFiles >= maxFiles || matches >= maxMatches) break;
    }
  };
  const reader = async () => {
    while (!stopped() && next < files.length && hitFiles < maxFiles && matches < maxMatches) {
      const i = next++;
      const path = files[i]!;
      done.set(i, await searchFile(join(base, path), path, search));
      report();
    }
  };
  await Promise.all(Array.from({ length: READS_AT_ONCE }, reader));
  return { files: hitFiles, matches, scanned: reported, truncated, ms: Math.round(performance.now() - started) };
}
