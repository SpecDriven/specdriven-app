// What an agent is shown of a folder's code when it drafts the folder's
// specs (specs/app/extract-specs-from-code.feature.md "A folder's code is
// read within a budget"). The agent answers in one turn and opens no file
// itself, so the app chooses: documents and API contracts first, then
// tests — the best evidence of what the code is meant to do — then the
// files a module is entered through, then the rest; each file cut at a
// limit, and the whole kept within what one turn takes. A folder too large
// for one turn is split by its subfolders into several batches, each
// drafted as a feature of its own; past a cap of batches the remainder is
// left unread and named.
//
// planBatches is pure — it plans from paths and sizes. renderBatch reads
// the files, with Node APIs only (this module also runs under Electron).

import { readFile } from "node:fs/promises";
import { repoPath } from "./files";
import { isTestPath, languageOf, type ModuleFiles } from "./intentModules";

/** A file is shown up to this many characters. */
export const FILE_CHARS = 12_000;
/** One batch — one agent turn — holds this many characters of files. */
export const BATCH_CHARS = 90_000;
/** A folder is drafted from at most this many batches. */
export const MAX_BATCHES = 6;
/** The share of a batch documents and API contracts may take when it is one of several. */
const SHARED_SHARE = 0.25;
/** The share of a batch its code may take when it is one of several: the rest is for its tests. */
const CODE_SHARE = 0.8;
/** A file larger than this is not shown at all: it is data or generated, not something written. */
const MAX_FILE_BYTES = 400 * 1024;
/** What each file's header line costs. */
const HEADER_CHARS = 40;
/** How much of a file is looked at to tell that it is binary, generated or minified. */
const SNIFF_CHARS = 8192;
/** A line longer than this near the top marks a minified or data file. */
const MAX_LINE_CHARS = 2000;

export type DigestKind = "doc" | "contract" | "test" | "entry" | "source";

export interface DigestFile {
  path: string;
  size: number;
  kind: DigestKind;
}

/** One agent turn's worth of a folder. */
export interface Batch {
  /** What part of the folder it is: a subfolder's path, or "" for all of it. */
  label: string;
  /** The files shown, in the order they are shown. */
  files: DigestFile[];
}

export interface DigestPlan {
  batches: Batch[];
  /** Files that could have been shown but did not fit. */
  notRead: string[];
}

const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const stemOf = (path: string): string => baseOf(path).replace(/\.[A-Za-z0-9]+$/, "");

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "poetry.lock", "uv.lock", "Pipfile.lock", "gradle.lockfile"]);
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const CONTRACT_EXT = /\.(proto|graphql|gql|feature)$/i;
const CONTRACT_NAME = /(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i;
const ENTRY_NAME =
  /^(index|main|app|server|routes?|router|api|cli|urls|views|models|__init__|__main__|handler|handlers|controller|package-info)\.[A-Za-z]+$|(Controller|Resource|Application|Endpoint|Handler|Facade|Api)\.java$/;

/**
 * What a file is to a draft, by its path: a document, an API contract, a
 * test, a way in, plain source — or null for a file that is not shown
 * (lockfiles, minified and generated output, anything in another language).
 */
export function digestKind(path: string, size: number): DigestKind | null {
  const name = baseOf(path);
  if (size > MAX_FILE_BYTES || size === 0 || LOCKFILES.has(name)) return null;
  if (/\.min\.[a-z]+$|\.map$|\.snap$|\.d\.[mc]?ts$|_pb2(_grpc)?\.py$|\.pb\.[a-z]+$|\.generated\.[a-z]+$/i.test(name)) return null;
  if (CONTRACT_EXT.test(name) || CONTRACT_NAME.test(name)) return "contract";
  if (DOC_EXT.test(name)) return "doc";
  if (languageOf(path) === null) return null;
  if (isTestPath(path)) return "test";
  return ENTRY_NAME.test(name) ? "entry" : "source";
}

const KIND_ORDER: Record<DigestKind, number> = { doc: 0, contract: 1, test: 2, entry: 3, source: 4 };
const cost = (f: DigestFile): number => Math.min(f.size, FILE_CHARS) + HEADER_CHARS;
const total = (files: readonly DigestFile[]): number => files.reduce((n, f) => n + cost(f), 0);
const ordered = (files: readonly DigestFile[]): DigestFile[] =>
  [...files].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      // A README before any other document.
      Number(!/^readme/i.test(baseOf(a.path))) - Number(!/^readme/i.test(baseOf(b.path))) ||
      a.path.localeCompare(b.path),
  );

/** The directory every one of the paths is in. */
function commonDir(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let prefix = dirOf(paths[0]!).split("/").filter(Boolean);
  for (const p of paths.slice(1)) {
    const segments = dirOf(p).split("/").filter(Boolean);
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join("/");
}

/**
 * Code split into chunks of at most `room`, keeping a subfolder together
 * where it fits: neighbours in path order share a chunk until it is full, a
 * subfolder too large for one is split by its own subfolders, and files
 * directly in a folder too large for one chunk are cut in path order.
 */
function pack(files: readonly DigestFile[], dir: string, room: number): DigestFile[][] {
  if (files.length === 0) return [];
  if (total(files) <= room) return [[...files]];
  const prefix = dir ? `${dir}/` : "";
  const groups = new Map<string, DigestFile[]>();
  for (const f of files) {
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const key = slash === -1 ? "" : rest.slice(0, slash);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const chunks: DigestFile[][] = [];
  let open: DigestFile[] = [];
  const close = () => {
    if (open.length > 0) chunks.push(open);
    open = [];
  };
  const add = (group: DigestFile[]) => {
    if (total(open) + total(group) > room) close();
    open.push(...group);
  };
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    if (total(group) <= room) {
      add(group);
      continue;
    }
    close();
    if (key !== "") {
      // A subfolder of its own: split by what is inside it.
      chunks.push(...pack(group, `${prefix}${key}`, room));
      continue;
    }
    // Files directly in the folder, with nothing left to split by: in order.
    for (const f of group) add([f]);
    close();
  }
  close();
  return chunks;
}

/** What a test's file name says it tests, as in the module analysis: `billing` for `test_billing.py`. */
function testedStem(path: string): string {
  return stemOf(path)
    .replace(/\.(test|spec|e2e|cy)$/i, "")
    .replace(/^test_/i, "")
    .replace(/_test$/i, "")
    .replace(/(Tests?|IT|TestCase)$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The batches a folder is drafted from. Everything in one when it fits.
 * Otherwise the code is split by subfolder, each batch also carrying the
 * leading documents and contracts and the tests that go with its code — by
 * a folder of the same name on the test's path, or a file name that starts
 * with one of its files' names.
 */
export function planBatches(owned: ModuleFiles, sizes: ReadonlyMap<string, number>, budget: number = BATCH_CHARS): DigestPlan {
  const files: DigestFile[] = [];
  for (const path of [...owned.source, ...owned.tests, ...owned.rest]) {
    const size = sizes.get(path) ?? 0;
    const kind = digestKind(path, size);
    if (kind) files.push({ path, size, kind });
  }
  const code = ordered(files.filter((f) => f.kind === "entry" || f.kind === "source"));
  if (code.length === 0 && !files.some((f) => f.kind === "test" || f.kind === "contract")) return { batches: [], notRead: [] };
  if (total(files) <= budget) return { batches: [{ label: "", files: ordered(files) }], notRead: [] };

  const notRead: string[] = [];
  // Documents and contracts ride along with every batch, as far as their share goes.
  const shared: DigestFile[] = [];
  for (const f of ordered(files.filter((f) => f.kind === "doc" || f.kind === "contract"))) {
    if (total(shared) + cost(f) <= budget * SHARED_SHARE) shared.push(f);
    else notRead.push(f.path);
  }
  const room = budget - total(shared);
  const byPath = [...code].sort((a, b) => a.path.localeCompare(b.path));
  const base = commonDir(byPath.map((f) => f.path));
  const chunks = pack(byPath, base, Math.floor(room * CODE_SHARE));
  for (const dropped of chunks.splice(MAX_BATCHES)) notRead.push(...dropped.map((f) => f.path));
  if (chunks.length === 0) chunks.push([]);

  // Each test to the chunk whose code it mirrors; the rest where there is room.
  const tests = files.filter((f) => f.kind === "test").sort((a, b) => a.path.localeCompare(b.path));
  const withTests = chunks.map((chunk) => ({ code: chunk, tests: [] as DigestFile[] }));
  const fits = (c: (typeof withTests)[number], f: DigestFile) => total(c.code) + total(c.tests) + cost(f) <= room;
  const loose: DigestFile[] = [];
  for (const t of tests) {
    const name = testedStem(t.path);
    const segments = new Set(dirOf(t.path).toLowerCase().split("/"));
    const home = withTests.find((c) =>
      c.code.some((f) => {
        const stem = stemOf(f.path).toLowerCase().replace(/[^a-z0-9]/g, "");
        const folder = baseOf(dirOf(f.path)).toLowerCase();
        return (stem.length >= 3 && name.startsWith(stem)) || (folder !== "" && folder !== baseOf(base).toLowerCase() && segments.has(folder));
      }),
    );
    if (home && fits(home, t)) home.tests.push(t);
    else loose.push(t);
  }
  for (const t of loose) {
    const home = withTests.find((c) => fits(c, t));
    if (home) home.tests.push(t);
    else notRead.push(t.path);
  }

  const baseLen = base ? base.length + 1 : 0;
  return {
    batches: withTests.map((c) => ({
      label: commonDir(c.code.map((f) => f.path)).slice(baseLen),
      files: [...shared, ...ordered([...c.tests, ...c.code])],
    })),
    notRead: notRead.sort(),
  };
}

/** A batch as the agent reads it, and what turned out not to be showable. */
export interface RenderedBatch {
  text: string;
  /** The files shown, by path: the only ones a drafted scenario may name. */
  shown: string[];
  /** Files left out on a look inside: binary, generated or minified. */
  skipped: string[];
}

/** Why a file's text is not shown, or null: a binary file, generated code, or one very long line. */
export function unreadable(text: string): string | null {
  const head = text.slice(0, SNIFF_CHARS);
  if (head.includes("\0")) return "binary";
  if (/@generated|Code generated by|DO NOT EDIT|This file was automatically generated|auto-generated by/i.test(head.slice(0, 600))) return "generated";
  if (head.split("\n").some((line) => line.length > MAX_LINE_CHARS)) return "minified";
  return null;
}

/**
 * Read a batch's files from the project and lay them out for the agent:
 * each under a `=== path ===` line, as written, cut at FILE_CHARS with a
 * note of how much was left out. No fences and no line numbers — the text
 * is data to read, not something to quote back.
 */
export async function renderBatch(root: string, batch: Batch): Promise<RenderedBatch> {
  const parts: string[] = [];
  const shown: string[] = [];
  const skipped: string[] = [];
  for (const file of batch.files) {
    let text: string;
    try {
      text = await readFile(repoPath(root, file.path), "utf8");
    } catch {
      skipped.push(file.path);
      continue;
    }
    if (unreadable(text) !== null || text.trim() === "") {
      skipped.push(file.path);
      continue;
    }
    const body =
      text.length > FILE_CHARS
        ? `${text.slice(0, FILE_CHARS).trimEnd()}\n… (${text.length - FILE_CHARS} more characters not shown)`
        : text.trimEnd();
    parts.push(`=== ${file.path} ===\n${body}\n`);
    shown.push(file.path);
  }
  return { text: parts.join("\n"), shown, skipped };
}
