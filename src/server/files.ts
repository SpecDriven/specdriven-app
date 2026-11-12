// A code repository's files (specs/app/code-repo-mode.feature.md): the tree
// the navigation pane lists, and the text the editor pane shows and saves —
// all under the open code repository and nowhere else. The only git command
// is a read-only `git check-ignore`, so the tree leaves out what the
// repository ignores. Node APIs only: this module also runs under Electron
// (src/server/run.ts).

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { run, which } from "./run";

/** A refusal with the status the route answers with, worded for the editor's notice. */
export class FilesError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Files larger than this are not opened as text (specs "A file opens in a plain text editor"). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How much of a file is looked at for a NUL byte, the sign of a binary file. */
export const SNIFF_BYTES = 8192;

/** The folder git keeps its own data in: never listed, read or written. */
const GIT_DIR = ".git";

/**
 * The absolute path of `rel` — a path relative to the repository, `/`
 * separated, "" for the repository itself. Refused: `..` and `.` segments,
 * empty segments, backslashes, NUL, an absolute path, anything inside
 * `.git`, and — belt and braces — any path that resolves outside `root`.
 */
export function repoPath(root: string, rel: string): string {
  const base = resolve(root);
  const trimmed = rel.replace(/\/+$/, "");
  if (trimmed === "") return base;
  if (trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/")) {
    throw new FilesError(400, `Not a path in the repository: ${rel}`);
  }
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FilesError(400, `Not a path in the repository: ${rel}`);
  }
  if (segments.includes(GIT_DIR)) throw new FilesError(400, "Git's own folder is not shown");
  const abs = resolve(base, ...segments);
  const inside = relative(base, abs);
  if (!inside || inside.startsWith("..") || inside.startsWith(sep) || resolve(base, inside) !== abs) {
    throw new FilesError(400, `Not a path in the repository: ${rel}`);
  }
  return abs;
}

/** One row of a folder's listing. */
export interface DirEntry {
  name: string;
  /** Relative to the repository, `/` separated. */
  path: string;
  kind: "dir" | "file";
  /** A symbolic link (followed for its kind). */
  link?: boolean;
}

/** Which of `paths` (relative to `root`) the repository ignores. */
export type IgnoreCheck = (root: string, paths: string[]) => Promise<Set<string>>;

/**
 * `git check-ignore`, read-only: the paths the repository's ignore rules
 * exclude. Tracked files are never reported, so a committed file under an
 * ignored folder still shows. Without git, or outside a git repository
 * (exit 128), nothing is ignored — everything but `.git` is listed.
 */
export const gitIgnored: IgnoreCheck = async (root, paths) => {
  if (paths.length === 0 || which("git") === null) return new Set();
  const res = await run("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
    input: paths.map((p) => `${p}\0`).join(""),
  });
  // 0: some are ignored; 1: none are; anything else: git could not tell.
  if (res.exitCode !== 0) return new Set();
  return new Set(res.stdout.split("\0").filter(Boolean));
};

// Injection seam: tests decide what is ignored without a git repository.
let ignoreCheck: IgnoreCheck | null = null;

export function setIgnoreCheck(fn: IgnoreCheck | null): IgnoreCheck | null {
  const previous = ignoreCheck;
  ignoreCheck = fn;
  return previous;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * One folder of the repository, folders first, each group in natural name
 * order, without `.git` and without what the repository ignores. A link is
 * listed as what it points to; a broken one as a file.
 */
export async function listDir(root: string, rel: string): Promise<DirEntry[]> {
  const abs = repoPath(root, rel);
  const where = await stat(abs).catch(() => null);
  if (!where) throw new FilesError(404, `No folder at ${rel || "the repository's top"}`);
  if (!where.isDirectory()) throw new FilesError(400, `Not a folder: ${rel}`);
  const prefix = rel.replace(/\/+$/, "");
  const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => d.name !== GIT_DIR);
  const entries: DirEntry[] = await Promise.all(
    dirents.map(async (d) => {
      const path = prefix ? `${prefix}/${d.name}` : d.name;
      if (!d.isSymbolicLink()) return { name: d.name, path, kind: d.isDirectory() ? "dir" : "file" } as DirEntry;
      const target = await stat(resolve(abs, d.name)).catch(() => null);
      return { name: d.name, path, kind: target?.isDirectory() ? "dir" : "file", link: true } as DirEntry;
    }),
  );
  const ignored = await (ignoreCheck ?? gitIgnored)(
    resolve(root),
    entries.map((e) => e.path),
  );
  return entries
    .filter((e) => !ignored.has(e.path))
    .sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1));
}

/** A file's text as the editor opens it. */
export interface FileText {
  path: string;
  content: string;
  /** The file's modification time, which a save hands back to detect a change on disk. */
  mtimeMs: number;
  size: number;
  /** The file's line endings, which a save keeps. */
  eol: "lf" | "crlf";
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A file's text, or why the editor cannot show it: missing (404), a folder
 * (400), larger than MAX_FILE_BYTES (413), or binary — a NUL byte near the
 * start, or bytes that are not UTF-8 (415). A byte order mark is kept, so
 * a save writes it back.
 */
export async function readFileText(root: string, rel: string): Promise<FileText> {
  const abs = repoPath(root, rel);
  if (abs === resolve(root)) throw new FilesError(400, "Pick a file, not the repository");
  const info = await stat(abs).catch(() => null);
  if (!info) throw new FilesError(404, `No file at ${rel}`);
  if (info.isDirectory()) throw new FilesError(400, `${rel} is a folder`);
  if (info.size > MAX_FILE_BYTES) {
    throw new FilesError(413, `${rel} is too large to edit here (${info.size} bytes)`, { size: info.size });
  }
  const bytes = await readFile(abs);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) throw new FilesError(415, `${rel} is a binary file`);
  let content: string;
  try {
    content = utf8.decode(bytes);
  } catch {
    throw new FilesError(415, `${rel} is not a UTF-8 text file`);
  }
  return { path: rel, content, mtimeMs: info.mtimeMs, size: info.size, eol: content.includes("\r\n") ? "crlf" : "lf" };
}

/** What a save reports: the file as it now stands on disk. */
export interface SavedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Save the editor's text over a file. With `ifMtimeMs`, a file changed on
 * disk since it was opened (by the IDE, by an agent) is not overwritten:
 * 409 with the file's new time. Without it the save goes ahead — "save
 * over it". The file is written in place, so its permissions (an
 * executable script) and a link stay as they were; `eol: "crlf"` writes
 * Windows line endings back.
 */
export async function writeFileText(
  root: string,
  rel: string,
  content: string,
  opts: { ifMtimeMs?: number; eol?: "lf" | "crlf" } = {},
): Promise<SavedFile> {
  const abs = repoPath(root, rel);
  if (abs === resolve(root)) throw new FilesError(400, "Pick a file, not the repository");
  const text = opts.eol === "crlf" ? content.replace(/\r?\n/g, "\r\n") : content;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new FilesError(413, `${rel} is too large to save here`);
  const info = await stat(abs).catch(() => null);
  if (info?.isDirectory()) throw new FilesError(400, `${rel} is a folder`);
  if (opts.ifMtimeMs !== undefined) {
    if (!info) throw new FilesError(409, `${rel} was deleted on disk`, { mtimeMs: null });
    if (info.mtimeMs !== opts.ifMtimeMs) {
      throw new FilesError(409, `${rel} changed on disk`, { mtimeMs: info.mtimeMs });
    }
  }
  try {
    await writeFile(abs, text);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FilesError(404, `No folder for ${rel}`);
    throw new FilesError(500, `Could not save ${rel}: ${(e as Error).message}`);
  }
  const saved = await stat(abs);
  return { path: rel, mtimeMs: saved.mtimeMs, size: saved.size };
}
