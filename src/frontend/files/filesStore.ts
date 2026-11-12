// The Files tab's store (specs/app/code-repo-mode.feature.md): the open code
// repository's tree as far as it has been opened, the folders left open
// (remembered per repository), and the one file in the editor with its
// save state. One store for the app — the tab is mounted for one repository
// at a time — read through useSyncExternalStore.

import { createPromiseQueue } from "../promiseQueue";
import { parentFolders } from "./route";

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  link?: boolean;
}

/** One folder's listing, or why it could not be read. */
export type Listing = { entries: FileEntry[] } | { error: string };

/** The file in the editor. */
export interface OpenFile {
  path: string;
  /** "loading" until the text arrives; "error" when it cannot be shown as text. */
  status: "loading" | "ready" | "error";
  /** The editor's text. */
  content: string;
  /** The text as it was last read or saved: unsaved while `content` differs. */
  saved: string;
  /** The file's time when it was read or saved, handed back on a save. */
  mtimeMs: number | null;
  eol: "lf" | "crlf";
  saving: boolean;
  /** Why the file is not shown, or the last save failed. */
  error: string | null;
  /** The status of a load that failed: 413 too large, 415 binary, 404 gone. */
  errorStatus: number | null;
  /** The file changed on disk since it was read: saves wait for the user's choice. */
  conflict: boolean;
}

/** A place in a file the editor is asked to show: a search result's line. */
export interface GoTo {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based; the line's start when left out. */
  col: number;
  /** How much to select from there; 0 puts the caret. */
  length: number;
  /** Tells one request from the next for the same place. */
  seq: number;
}

export interface FilesState {
  root: string | null;
  /** Listings by folder path, "" for the repository's top. */
  dirs: Record<string, Listing>;
  /** The folders open in the tree. */
  expanded: string[];
  open: OpenFile | null;
  /** Where the editor should go once it shows the file; null once it has. */
  goto: GoTo | null;
}

/** Whether the editor holds text not yet on disk. */
export function isDirty(open: OpenFile | null): boolean {
  return open !== null && open.status === "ready" && open.content !== open.saved;
}

const EXPANDED_KEY = "sd-files-expanded:";

function readExpanded(root: string): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY + root);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeExpanded(root: string, expanded: string[]): void {
  try {
    localStorage.setItem(EXPANDED_KEY + root, JSON.stringify(expanded));
  } catch {
    // Storage unavailable: the folders just won't be remembered.
  }
}

const q = (path: string) => `?path=${encodeURIComponent(path)}`;

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText}`;
}

/** The one call the store makes: fetch, or a test's stand-in. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createFilesStore(fetchFn: Fetch = (input, init) => fetch(input, init)) {
  let state: FilesState = { root: null, dirs: {}, expanded: [], open: null, goto: null };
  let gotoSeq = 0;
  const listeners = new Set<() => void>();
  const saves = createPromiseQueue();
  /** Bumped on every reset, so an answer for the old repository is dropped. */
  let generation = 0;

  const set = (next: Partial<FilesState>) => {
    state = { ...state, ...next };
    for (const l of listeners) l();
  };
  const setOpen = (patch: Partial<OpenFile>, path: string) => {
    if (state.open?.path !== path) return;
    set({ open: { ...state.open, ...patch } });
  };

  async function loadDir(path: string): Promise<void> {
    const gen = generation;
    let listing: Listing;
    try {
      const res = await fetchFn(`/api/files/dir${q(path)}`);
      if (res.ok) {
        const body = (await res.json()) as { entries: FileEntry[] };
        listing = { entries: body.entries };
      } else {
        listing = { error: await errorOf(res) };
      }
    } catch (e) {
      listing = { error: (e as Error).message };
    }
    if (gen !== generation) return;
    set({ dirs: { ...state.dirs, [path]: listing } });
  }

  function setExpanded(expanded: string[]): void {
    set({ expanded });
    if (state.root) writeExpanded(state.root, expanded);
  }

  /** Read a file into the editor, dropping what it held. */
  async function read(path: string): Promise<void> {
    const gen = generation;
    try {
      const res = await fetchFn(`/api/files/file${q(path)}`);
      if (gen !== generation) return;
      if (!res.ok) {
        setOpen({ status: "error", error: await errorOf(res), errorStatus: res.status }, path);
        return;
      }
      const file = (await res.json()) as { content: string; mtimeMs: number; eol: "lf" | "crlf" };
      if (gen !== generation) return;
      // CodeMirror splits lines on any break and joins them with \n, so the
      // text is kept as the editor will hand it back; a save restores \r\n.
      const content = file.content.replace(/\r\n?/g, "\n");
      setOpen(
        {
          status: "ready",
          content,
          saved: content,
          mtimeMs: file.mtimeMs,
          eol: file.eol,
          error: null,
          errorStatus: null,
          conflict: false,
        },
        path,
      );
    } catch (e) {
      setOpen({ status: "error", error: (e as Error).message, errorStatus: null }, path);
    }
  }

  /** Save what the editor holds; `force` writes over a change on disk. */
  function save(opts: { force?: boolean } = {}): Promise<void> {
    return saves.run(async () => {
      const open = state.open;
      if (!open || open.status !== "ready") return;
      if (open.conflict && !opts.force) return;
      if (open.content === open.saved && !opts.force) return;
      const { path, content } = open;
      setOpen({ saving: true }, path);
      try {
        const res = await fetchFn(`/api/files/file${q(path)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            eol: open.eol,
            ...(opts.force || open.mtimeMs === null ? {} : { ifMtimeMs: open.mtimeMs }),
          }),
        });
        if (res.status === 409) {
          setOpen({ saving: false, conflict: true, error: await errorOf(res) }, path);
          return;
        }
        if (!res.ok) {
          setOpen({ saving: false, error: await errorOf(res) }, path);
          return;
        }
        const saved = (await res.json()) as { mtimeMs: number };
        setOpen({ saving: false, saved: content, mtimeMs: saved.mtimeMs, conflict: false, error: null }, path);
      } catch (e) {
        setOpen({ saving: false, error: (e as Error).message }, path);
      }
    });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: (): FilesState => state,

    /** Point the store at a repository and list its top folder and the folders left open. */
    async configure(root: string): Promise<void> {
      if (state.root === root) return;
      generation++;
      state = { root, dirs: {}, expanded: readExpanded(root), open: null, goto: null };
      for (const l of listeners) l();
      await Promise.all(["", ...state.expanded].map((p) => loadDir(p)));
    },

    /** Forget the repository: the tab is going away. */
    reset(): void {
      generation++;
      set({ root: null, dirs: {}, expanded: [], open: null, goto: null });
    },

    loadDir,

    /** Open or close a folder in the tree. */
    async toggle(path: string): Promise<void> {
      if (state.expanded.includes(path)) {
        setExpanded(state.expanded.filter((p) => p !== path));
        return;
      }
      setExpanded([...state.expanded, path]);
      if (!state.dirs[path]) await loadDir(path);
    },

    /** Open the folders a file sits in, so the tree shows its row. */
    async reveal(path: string): Promise<void> {
      const missing = parentFolders(path).filter((p) => !state.expanded.includes(p));
      if (missing.length === 0) return;
      setExpanded([...state.expanded, ...missing]);
      await Promise.all(missing.filter((p) => !state.dirs[p]).map((p) => loadDir(p)));
    },

    /** List the top folder and every open folder again — an agent or the IDE may have changed them. */
    async refresh(): Promise<void> {
      await Promise.all(["", ...state.expanded].map((p) => loadDir(p)));
    },

    /** Open a file in the editor; the file it replaces is saved first. */
    async open(path: string): Promise<void> {
      // A place asked for in a file that was never shown is forgotten.
      if (state.goto && state.goto.path !== path) set({ goto: null });
      if (state.open?.path === path && state.open.status !== "error") return;
      await save();
      await saves.idle();
      set({
        open: {
          path,
          status: "loading",
          content: "",
          saved: "",
          mtimeMs: null,
          eol: "lf",
          saving: false,
          error: null,
          errorStatus: null,
          conflict: false,
        },
      });
      await read(path);
    },

    /** Leave the file: save it, then show none — unless another file was opened meanwhile. */
    async close(path?: string): Promise<void> {
      const leaving = path ?? state.open?.path;
      await save();
      await saves.idle();
      if (state.open && state.open.path === leaving) set({ open: null });
    },

    /**
     * Ask the editor to show a place in a file — a search result — once the
     * file is open; opening the file is the caller's navigation.
     */
    goTo(path: string, line: number, col = 1, length = 0): void {
      set({ goto: { path, line, col, length, seq: ++gotoSeq } });
    },

    /** The editor went there: the request is done. */
    wentTo(seq: number): void {
      if (state.goto?.seq === seq) set({ goto: null });
    },

    /** The editor's text changed. */
    edit(content: string): void {
      const open = state.open;
      if (!open || open.status !== "ready" || open.content === content) return;
      set({ open: { ...open, content } });
    },

    save,

    /** Drop the editor's text for the file as it now is on disk. */
    async reload(): Promise<void> {
      const open = state.open;
      if (!open) return;
      await saves.idle();
      await read(open.path);
    },

    /**
     * Coming back to the window: a file with nothing unsaved is read again
     * when it changed on disk, so the IDE's edits show.
     */
    async recheck(): Promise<void> {
      const open = state.open;
      if (!open || open.status !== "ready" || isDirty(open) || open.saving) return;
      await read(open.path);
    },

    /** Land what the editor holds, and wait for it. */
    async flush(): Promise<void> {
      await save();
      await saves.idle();
    },

    /**
     * Git Pull (specs/app/code-repo-mode.feature.md "Git Pull from the
     * navigation pane"): land the editor's text first, so the pull sees it
     * (and refuses a dirty tree rather than losing it), then pull, then list
     * the tree and read the open file again as the pull left them.
     */
    async pull(): Promise<PullResult> {
      await save();
      await saves.idle();
      let result: PullResult;
      try {
        const res = await fetchFn("/api/files/pull", { method: "POST" });
        result = res.ok
          ? ((await res.json()) as PullResult)
          : { ok: false, conflicted: false, message: await errorOf(res) };
      } catch (e) {
        result = { ok: false, conflicted: false, message: (e as Error).message };
      }
      // A failed merge may still have changed files (conflict markers).
      await Promise.all(["", ...state.expanded].map((p) => loadDir(p)));
      const open = state.open;
      if (open && open.status === "ready" && !isDirty(open) && !open.saving) await read(open.path);
      return result;
    },
  };
}

/** What POST /api/files/pull answers (src/server/agentSource.ts RefreshResult). */
export interface PullResult {
  ok: boolean;
  message: string;
  conflicted: boolean;
  /** Commits the branch gained; 0 when it was already up to date. */
  pulled?: number;
  branch?: string;
}

/** The toast after a pull that went through. */
export function pulledMessage(result: PullResult): string {
  const n = result.pulled;
  if (n === 0) return "Already up to date";
  const into = result.branch ? ` into ${result.branch}` : "";
  if (n === undefined) return `Pulled${into}`;
  return `Pulled ${n} commit${n === 1 ? "" : "s"}${into}`;
}

export type FilesStore = ReturnType<typeof createFilesStore>;

/** The app's one store. */
export const files = createFilesStore();
