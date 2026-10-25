// The data repo's special folders: `roadmap/` (specs/app/roadmap.feature.md)
// and `tasks/` (specs/app/tasks.feature.md). Both hold regular markdown files
// rather than `.feature.md` specs, and both work the same way — shown as
// their own sidebar tab beside the Specs tree, and only while the user
// setting for that folder is on. With the setting on, the folder is created
// if it is not there yet, and the sync tick commits everything in it like any
// other saved change (src/server/reload.ts).
//
// A page is more than a file, though: like a feature it has an Automerge
// document behind it (src/server/automerge/page.ts) — so concurrent edits
// merge instead of conflicting — and it can be assigned to a project member,
// written into the file as the same `**Assigned:** <name>` line a feature
// carries (src/server/members.ts). A task is that and no more: a markdown
// page in the tasks folder with somebody's name on it and a Done marker to
// tick off, which is why the two folders share every line below and differ
// only in their descriptor.

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { threeWayPage, threeWayPageStrict } from "./automerge/merge";
import {
  docToPage,
  importPageDoc,
  isPageProjectionOf,
  projectPage,
  reconcilePage,
} from "./automerge/page";
import {
  createPageDoc,
  hasPageDoc,
  listPageDocs,
  loadPageDoc,
  pageDocDirRel,
  removePageDoc,
  savePageDoc,
} from "./automerge/store";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { commitAndPush, moveAndPush, removeAndPush } from "./git";
import {
  parsePage,
  serializePage,
  slugify,
  titleFromFileName,
  type EntryKind,
  type MarkdownPage,
  type Supersedes,
} from "./parser";
import { PAGE_ORDER_FILE, formatOrder, inOrder, parseOrder } from "./pageOrder";
import { getLogger, withSpan } from "./telemetry";
import { cleanLine } from "./text";

const log = getLogger("pages");

import {
  NOTEBOOK,
  NOTEBOOK_FOLDER,
  PAGE_FOLDERS,
  ROADMAP,
  TASKS,
  isPageFile,
  isPageFolderPath,
  pageFolderNamed,
} from "./pageFolders";
import type { PageFolder } from "./pageFolders";

export {
  NOTEBOOK,
  NOTEBOOK_FOLDER,
  PAGE_FOLDERS,
  ROADMAP,
  ROADMAP_FOLDER,
  TASKS,
  TASKS_FOLDER,
  isPageFile,
  isPageFolderPath,
  pageFolderNamed,
} from "./pageFolders";
export type { PageFolder } from "./pageFolders";

/** What the sidebar lists for one page. */
export interface PageListing {
  /** Path relative to the data repo root, e.g. `roadmap/pricing.md`. */
  fileName: string;
  /** Display name: the file's `# <name>` heading, or derived from the stem. */
  name: string;
  /** The project member the page is assigned to, if any. */
  assigned?: string;
  /** How long a task is estimated to take, in minutes — what its Add to
      calendar button writes (specs/app/tasks.feature.md). */
  estimate?: number;
  /** Whether the page is done — what a task's Done button sets. */
  done?: boolean;
  /** A notebook entry's author (specs/app/engineering-notebook.feature.md). */
  author?: string;
  /** A notebook entry's day, `yyyy-mm-dd` — from the file name when the
      entry carries no `**Date:**` line. */
  date?: string;
  /** Whether a notebook entry is an observation or a decision; an entry
      that says neither reads as an observation. */
  kind?: EntryKind;
  /** The earlier decision this entry replaces, if any. */
  supersedes?: Supersedes;
}

/** A page as the editor sees it: its listing, plus the markdown itself. */
export interface PageView extends PageListing {
  content: string;
}

/**
 * Scenario "Create roadmap folder if necessary" (and its twin for tasks):
 * with the setting on, the folder exists — created here when it does not. Git
 * does not track empty directories, so a fresh one holds nothing to commit
 * until a page lands in it. Returns whether this call created it.
 */
export async function ensurePageFolder(dataDir: string, kind: PageFolder): Promise<boolean> {
  const path = `${dataDir}/${kind.folder}`;
  if (await isDirectory(path)) return false;
  await mkdir(path, { recursive: true });
  log.info(`created the ${kind.folder} folder`, { "specdriven.dir": dataDir });
  return true;
}

/**
 * Every markdown page in the folder, nested ones included — an ordered
 * folder's in each subfolder's own order (src/server/pageOrder.ts), every
 * other's in name order.
 */
export async function listPages(dataDir: string, kind: PageFolder): Promise<PageListing[]> {
  const sorted = await pageFiles(dataDir, kind.folder);
  const files = kind.ordered ? await inFolderOrder(dataDir, sorted) : sorted;
  return Promise.all(
    files.map(async (fileName) => {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      const page = text === null ? null : parsePage(text);
      return listing(fileName, page);
    }),
  );
}

export async function readPage(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
): Promise<PageView | null> {
  const file = safe(kind, fileName);
  const content = await readTextFile(`${dataDir}/${file}`);
  if (content === null) return null;
  return { ...listing(file, parsePage(content)), content };
}

/**
 * Save a page as the editor holds it. Local like a saved scenario — the
 * reload cron commits and pushes it — and through the document, so what lands
 * on disk is the document's projection. `base` is the text the content was
 * edited from, so what the page gained meanwhile is merged in, not dropped
 * (absorb).
 */
export async function savePage(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
  content: string,
  base?: string,
): Promise<PageView> {
  const file = safe(kind, fileName);
  const projection = await absorb(dataDir, file, content, base);
  await writeTextFile(`${dataDir}/${file}`, projection);
  return { ...listing(file, parsePage(projection)), content: projection };
}

/** What a caller may say about the page it is creating. */
export interface CreatePageOptions {
  /**
   * Put in front of the slug in the file name, with a `-` between: the
   * notebook's `yyyy-mm-dd` (specs/app/engineering-notebook.feature.md), so
   * the folder reads in order and the list sorts without opening a file.
   */
  prefix?: string;
  /** The page's metadata and starting body — its heading is the name. */
  page?: Omit<MarkdownPage, "name" | "body"> & { body?: string };
}

/**
 * Create a page: `<folder>/<slug>.md` holding its heading, committed and
 * pushed like a new feature. A `/` in the name nests it in a subfolder,
 * unless the folder is flat.
 */
export async function createPage(
  dataDir: string,
  kind: PageFolder,
  name: string,
  options: CreatePageOptions = {},
): Promise<string> {
  // A flat folder takes the name whole: a `/` in it is part of the title,
  // not a subfolder to make (specs/app/engineering-notebook.feature.md).
  const segments = kind.flat ? [cleanLine(name)] : name.split("/").map(cleanLine);
  const pageName = segments.pop() ?? "";
  if (!pageName) throw new Error(`${capitalize(kind.label)} name is required`);
  const slug = slugify(pageName);
  if (!slug) throw new Error(`${capitalize(kind.label)} name is required`);
  const stem = options.prefix ? `${options.prefix}-${slug}` : slug;
  const folder = [kind.folder, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(kind, `${folder}/${stem}.md`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`${capitalize(kind.label)} already exists: ${fileName}`);
  }
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const { body = "", ...meta } = options.page ?? {};
  const projection = await absorb(
    dataDir,
    fileName,
    serializePage({ name: pageName, body, ...meta }),
  );
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(
    dataDir,
    await pagePaths(dataDir, fileName),
    `Create ${kind.label}: ${pageName}`,
  );
  return fileName;
}

/** What a caller may say about the page it is renaming. */
export interface RenamePageOptions {
  /**
   * Rewrite the links that name the page, after its heading is saved and
   * before its file moves. The notebook passes notebook.ts's relinkEntries so
   * a `**Supersedes:**` line follows the entry it points at; pages with no
   * links of their own pass nothing. A callback rather than an import, since
   * notebook.ts already imports this module.
   */
  relink?: (dataDir: string, from: string, to: string) => Promise<unknown>;
}

/**
 * Rename a page: its `# heading` and its file both, so the two can never
 * drift apart and the url follows the title (issue #122 — an entry renamed
 * in the app kept its old file name, and the retired slug then refused the
 * original title forever). A `git mv` committed and pushed, like a renamed
 * feature file (features.ts renameFeatureFile).
 *
 * The heading is saved through the document first, so the chunks land in the
 * directory the move then carries along; `git mv` stages the file as it
 * stands, so that edit rides the rename commit.
 */
export async function renamePageFile(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
  newName: string,
  options: RenamePageOptions = {},
): Promise<{ fileName: string; name: string; message: string }> {
  const from = safe(kind, fileName);
  const current = await readTextFile(`${dataDir}/${from}`);
  if (current === null) throw new Error(`${capitalize(kind.label)} not found: ${from}`);
  // A flat folder takes the name whole, as createPage does; a nested page
  // keeps the folder it is in — a rename never re-nests.
  const segments = kind.flat ? [cleanLine(newName)] : newName.split("/").map(cleanLine);
  const title = segments.pop() ?? "";
  const slug = slugify(title);
  if (!slug) throw new Error(`${capitalize(kind.label)} name is required`);
  const folder = from.split("/").slice(0, -1).join("/");
  const to = safe(kind, `${folder}/${datePrefixed(kind, from, slug)}.md`);

  // The heading is repaired whether or not the file moves: an entry that
  // already drifted — a new title over the old file name — is renamed back to
  // the title it displays, which slugifies to the name it already has.
  const page = parsePage(current);
  if (page.name !== title) {
    await savePage(dataDir, kind, from, serializePage({ ...page, name: title }), current);
  }
  if (to === from) return { fileName: from, name: title, message: "file name unchanged" };
  if (await fileExists(`${dataDir}/${to}`)) {
    throw new Error(`${capitalize(kind.label)} already exists: ${to}`);
  }

  // Before the move, so no failure leaves a link pointing at a file that is
  // no longer there. Nothing resolves a link to a file as it is written, so
  // naming the new url a moment early costs nothing.
  await options.relink?.(dataDir, from, to);
  // The document moves with the markdown or its lineage is lost: the drift
  // pass mints a fresh document for a page that has none, and drops the one
  // whose page is gone.
  const moves = (await hasPageDoc(dataDir, from))
    ? [{ from: pageDocDirRel(from), to: pageDocDirRel(to) }]
    : [];
  // A renamed task keeps its place: the order names it by its new file.
  const order = kind.ordered ? await folderOrder(dataDir, folder) : null;
  const sync = await moveAndPush(
    dataDir,
    from,
    to,
    `Rename ${kind.label}: ${from} -> ${to}`,
    moves,
  );
  if (order) {
    const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    await writeOrder(dataDir, folder, order.map((name) => (name === base(from) ? base(to) : name)));
  }
  return { fileName: to, name: title, message: sync.message };
}

/**
 * The renamed file's stem: a notebook entry keeps the `yyyy-mm-dd` its name
 * begins with, so the folder still reads in order, and every other page is
 * its slug alone — a roadmap page named `2026-plan.md` claims no date. A
 * title that carries the date itself is not given it twice.
 */
function datePrefixed(kind: PageFolder, from: string, slug: string): string {
  if (kind.folder !== NOTEBOOK_FOLDER) return slug;
  const base = from.slice(from.lastIndexOf("/") + 1);
  const date = base.match(/^(\d{4}-\d{2}-\d{2})-/)?.[1];
  if (!date) return slug;
  return slug.startsWith(`${date}-`) ? slug : `${date}-${slug}`;
}

/**
 * Delete a page — the markdown and its document — committed and pushed like
 * a deleted feature (specs/app/roadmap.feature.md). The sidebar's ⋯ menu
 * offers it; Undo is not possible past the push, so the client confirms.
 */
export async function deletePage(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
): Promise<{ message: string }> {
  const file = safe(kind, fileName);
  if (!(await fileExists(`${dataDir}/${file}`))) {
    throw new Error(`${capitalize(kind.label)} not found: ${file}`);
  }
  const paths = await pagePaths(dataDir, file);
  const sync = await removeAndPush(dataDir, paths, `Delete ${kind.label}: ${file}`);
  await removePageDoc(dataDir, file);
  // The order forgets it, or a later task of the same name would take the
  // deleted one's place.
  if (kind.ordered) {
    const folder = parentOf(file);
    if ((await readTextFile(`${dataDir}/${folder}/${PAGE_ORDER_FILE}`)) !== null) {
      await writeOrder(dataDir, folder, await folderOrder(dataDir, folder));
    }
  }
  return { message: sync.message };
}

/**
 * Put a page in a folder, before another page of that folder or after its
 * last (specs/app/tasks.feature.md "Reorder tasks by dragging"): what a drag
 * in the sidebar and its Move up, Move down and Move to folder… do. Within
 * its own folder only the order changes — a local write the sync tick
 * commits, like a save. Into another folder it is a `git mv` of the page and
 * its document, committed and pushed like a rename, and both folders'
 * orders follow. Only an ordered folder's pages move.
 */
export async function movePage(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
  toFolder: string,
  before: string | null = null,
): Promise<{ fileName: string; message: string }> {
  if (!kind.ordered) throw new Error(`${capitalize(kind.label)}s keep their name order`);
  const from = safe(kind, fileName);
  const folder = safeFolder(kind, toFolder);
  if (!(await fileExists(`${dataDir}/${from}`))) {
    throw new Error(`${capitalize(kind.label)} not found: ${from}`);
  }
  if (!(await isDirectory(`${dataDir}/${folder}`))) throw new Error(`Folder not found: ${folder}`);
  const base = from.slice(from.lastIndexOf("/") + 1);
  const to = `${folder}/${base}`;
  const anchor = before === null ? null : safe(kind, before);
  if (anchor !== null && parentOf(anchor) !== folder) {
    throw new Error(`${anchor} is not in ${folder}`);
  }
  if (anchor === from) return { fileName: from, message: "already there" };

  let message = "reordered";
  if (to !== from) {
    if (await fileExists(`${dataDir}/${to}`)) {
      throw new Error(`${capitalize(kind.label)} already exists: ${to}`);
    }
    const left = parentOf(from);
    const moves = (await hasPageDoc(dataDir, from))
      ? [{ from: pageDocDirRel(from), to: pageDocDirRel(to) }]
      : [];
    const sync = await moveAndPush(dataDir, from, to, `Move ${kind.label}: ${from} -> ${to}`, moves);
    message = sync.message;
    if ((await readTextFile(`${dataDir}/${left}/${PAGE_ORDER_FILE}`)) !== null) {
      await writeOrder(dataDir, left, await folderOrder(dataDir, left));
    }
  }
  const order = (await folderOrder(dataDir, folder)).filter((name) => name !== base);
  const at = anchor === null ? -1 : order.indexOf(anchor.slice(anchor.lastIndexOf("/") + 1));
  order.splice(at === -1 ? order.length : at, 0, base);
  await writeOrder(dataDir, folder, order);
  return { fileName: to, message };
}

/**
 * The subfolders of a special folder, repo-relative and sorted — empty ones
 * included, so a folder just made shows in the sidebar before a page lands
 * in it.
 */
export async function listPageFolders(dataDir: string, kind: PageFolder): Promise<string[]> {
  const found: string[] = [];
  const walkDirs = async (rel: string) => {
    const entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = `${rel}/${entry.name}`;
      found.push(path);
      await walkDirs(path);
    }
  };
  await walkDirs(kind.folder);
  return found.sort();
}

/**
 * A subfolder for pages (the Specs tree's "New folder here", for tasks):
 * each segment slugified like a page's file name, a leading folder name
 * accepted rather than doubled. Git keeps no empty folder, so it starts with
 * an empty order file, which the sync tick commits.
 */
export async function createPageFolder(
  dataDir: string,
  kind: PageFolder,
  path: string,
): Promise<string> {
  if (kind.flat) throw new Error(`The ${kind.folder} folder has no subfolders`);
  const segments = path.split("/").map((s) => slugify(cleanLine(s))).filter(Boolean);
  if (segments[0] === kind.folder) segments.shift();
  if (segments.length === 0) throw new Error("Folder name is required");
  const folder = safeFolder(kind, [kind.folder, ...segments].join("/"));
  if (await isDirectory(`${dataDir}/${folder}`)) throw new Error(`Folder already exists: ${folder}`);
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  await writeTextFile(`${dataDir}/${folder}/${PAGE_ORDER_FILE}`, "");
  return folder;
}

/**
 * Rename a subfolder: it keeps its place and takes a new last segment,
 * slugified. With pages in it, a `git mv` of the folder and of its pages'
 * documents, committed and pushed like a renamed Specs folder; without,
 * renamed on disk for the sync tick to commit.
 */
export async function renamePageFolder(
  dataDir: string,
  kind: PageFolder,
  path: string,
  name: string,
): Promise<{ path: string; message: string }> {
  const from = safeFolder(kind, path);
  if (from === kind.folder) throw new Error("Folder name is required");
  if (!(await isDirectory(`${dataDir}/${from}`))) throw new Error(`Folder not found: ${from}`);
  const stem = slugify(cleanLine(name).split("/").pop() ?? "");
  if (!stem) throw new Error("Folder name is required");
  const to = safeFolder(kind, `${parentOf(from)}/${stem}`);
  if (to === from) return { path: from, message: "already named that" };
  if (await isDirectory(`${dataDir}/${to}`)) throw new Error(`Folder already exists: ${to}`);
  const docFrom = pageDocDirRel(from);
  const docMoves = (await isDirectory(`${dataDir}/${docFrom}`))
    ? [{ from: docFrom, to: pageDocDirRel(to) }]
    : [];
  if ((await pageFiles(dataDir, from)).length === 0) {
    for (const m of [{ from, to }, ...docMoves]) {
      await mkdir(`${dataDir}/${parentOf(m.to)}`, { recursive: true });
      await rename(`${dataDir}/${m.from}`, `${dataDir}/${m.to}`);
    }
    return { path: to, message: "renamed" };
  }
  const sync = await moveAndPush(dataDir, from, to, `Rename folder: ${from} -> ${to}`, docMoves);
  return { path: to, message: sync.message };
}

/**
 * Delete a subfolder and the pages in it, with their documents — a `git rm
 * -r`, committed and pushed; what git never tracked is swept off disk after.
 * The client confirms first, naming how many pages go.
 */
export async function deletePageFolder(
  dataDir: string,
  kind: PageFolder,
  path: string,
): Promise<{ message: string; pages: number }> {
  const folder = safeFolder(kind, path);
  if (folder === kind.folder) throw new Error("Folder name is required");
  if (!(await isDirectory(`${dataDir}/${folder}`))) throw new Error(`Folder not found: ${folder}`);
  const pages = (await pageFiles(dataDir, folder)).length;
  const docFolder = pageDocDirRel(folder);
  const paths = [folder, ...((await isDirectory(`${dataDir}/${docFolder}`)) ? [docFolder] : [])];
  let message = "folder deleted";
  if (pages > 0) {
    const label = `${kind.label}${pages === 1 ? "" : "s"}`;
    const sync = await removeAndPush(dataDir, paths, `Delete folder: ${folder} (${pages} ${label})`);
    message = sync.message;
  }
  for (const p of paths) await rm(`${dataDir}/${p}`, { recursive: true, force: true });
  return { message, pages };
}

/**
 * One special folder's side of the sync tick's drift pass
 * (automerge/driftSync.ts): markdown that changed without its document — an
 * external edit, a teammate's push, a page that predates its document — is
 * absorbed (or first imported), and the file rewritten to the document's
 * projection. A document whose page is gone is dropped: the markdown is the
 * interchange format.
 */
export async function importPageDrift(dataDir: string, kind: PageFolder): Promise<string> {
  return withSpan(
    "sync.import_page_drift",
    { "specdriven.dir": dataDir, "specdriven.folder": kind.folder },
    async (span) => {
      let imported = 0;
      let absorbed = 0;
      for (const fileName of await pageFiles(dataDir, kind.folder)) {
        const text = await readTextFile(`${dataDir}/${fileName}`);
        if (text === null) continue;
        const loaded = await loadPageDoc(dataDir, fileName);
        if (loaded === null) {
          const page = importPageDoc(parsePage(text));
          const created = await createPageDoc(dataDir, fileName, page);
          const projection = projectPage(created.doc);
          if (projection !== text) await writeTextFile(`${dataDir}/${fileName}`, projection);
          imported++;
          continue;
        }
        if (isPageProjectionOf(text, loaded.doc)) continue;
        const next = reconcilePage(loaded.doc, parsePage(text));
        await savePageDoc(dataDir, fileName, next, loaded.heads);
        await writeTextFile(`${dataDir}/${fileName}`, projectPage(next));
        absorbed++;
      }
      let removed = 0;
      for (const fileName of await listPageDocs(dataDir, kind.folder)) {
        if (!(await fileExists(`${dataDir}/${fileName}`))) {
          await removePageDoc(dataDir, fileName);
          removed++;
        }
      }
      span.setAttributes({
        "sync.pages_imported": imported,
        "sync.pages_absorbed": absorbed,
        "sync.pages_removed": removed,
      });
      const parts = [];
      if (imported > 0) parts.push(`imported ${imported} ${kind.label}(s) into documents`);
      if (absorbed > 0) parts.push(`absorbed ${absorbed} externally edited ${kind.label}(s)`);
      if (removed > 0) parts.push(`dropped ${removed} document(s) for deleted ${kind.label}(s)`);
      return parts.join("; ");
    },
  );
}

/**
 * Feed a page's markdown into its document — reconciled as CRDT operations,
 * or imported whole for a page that has none yet — and return the projection
 * the file must now hold (features.ts absorbIntoDoc).
 *
 * The file is about to be overwritten with the projection, so an external
 * edit the sync tick has not absorbed yet (importPageDrift) is absorbed here
 * first — otherwise the write would drop it from the file, the document and
 * git without a trace, the same hole absorbIntoDoc closes for `.feature.md`
 * files.
 *
 * `base` is the text the caller edited: what the editor loaded or last saved,
 * or what a server-side rewrite read. Whatever the document gained since —
 * that drift, a sync tick, another save — is kept by merging the text in
 * three-way against it (threeWayPage). With the true base a character merge
 * cannot write an edit twice. Without one the base is guessed as the
 * document before the drift, and a text both sides changed is refused
 * rather than merged (threeWayPageStrict), as for features.
 */
async function absorb(
  dataDir: string,
  fileName: string,
  text: string,
  base?: string,
): Promise<string> {
  let page = parsePage(text);
  const loaded = await loadPageDoc(dataDir, fileName);
  if (loaded === null) {
    const created = await createPageDoc(dataDir, fileName, importPageDoc(page));
    return projectPage(created.doc);
  }
  let doc = loaded.doc;
  const from = base === undefined ? docToPage(doc) : parsePage(base);
  const disk = await readTextFile(`${dataDir}/${fileName}`);
  if (disk !== null && !isPageProjectionOf(disk, doc)) {
    doc = reconcilePage(doc, parsePage(disk));
    log.info(`absorbed drifted ${fileName} into its document before writing over it`);
  }
  if (serializePage(from) !== projectPage(doc)) {
    if (base === undefined) {
      const merged = threeWayPageStrict(from, page, docToPage(doc));
      if (!merged.ok) {
        throw new Error(
          `${fileName} was edited on disk and here at the same time (${merged.conflict}) — ` +
            `the disk edit is kept; reopen the page to pick it up`,
        );
      }
      page = merged.page;
    } else {
      page = threeWayPage(from, page, docToPage(doc));
    }
  }
  const next = reconcilePage(doc, page);
  await savePageDoc(dataDir, fileName, next, loaded.heads);
  return projectPage(next);
}

/** What a mutation commits for a page: the markdown and its document. */
async function pagePaths(dataDir: string, fileName: string): Promise<string[]> {
  return (await hasPageDoc(dataDir, fileName))
    ? [fileName, pageDocDirRel(fileName)]
    : [fileName];
}

function listing(fileName: string, page: MarkdownPage | null): PageListing {
  return {
    fileName,
    name: page?.name || titleFromFileName(entryStem(fileName)),
    ...(page?.assigned ? { assigned: page.assigned } : {}),
    ...(page?.estimate ? { estimate: page.estimate } : {}),
    ...(page?.done ? { done: true } : {}),
    ...(page?.author ? { author: page.author } : {}),
    ...(entryDate(fileName, page) ? { date: entryDate(fileName, page)! } : {}),
    ...(page?.kind ? { kind: page.kind } : {}),
    ...(page?.supersedes ? { supersedes: page.supersedes } : {}),
  };
}

/** `2026-09-12-spec-first.md` -> `2026-09-12-spec-first`, folder stripped. */
function entryStem(fileName: string): string {
  return fileName.replace(/\.md$/, "");
}

/**
 * A notebook entry's day: what the file says, else the `yyyy-mm-dd` its name
 * begins with — an entry dropped into the folder by hand takes its date from
 * the file name (specs/app/engineering-notebook.feature.md). Only entries
 * have one, so a roadmap page named `2026-plan.md` is not given a date it
 * never claimed.
 */
function entryDate(fileName: string, page: MarkdownPage | null): string | null {
  if (page?.date) return page.date;
  if (!fileName.startsWith(`${NOTEBOOK_FOLDER}/`)) return null;
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  return base.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/** Markdown files under the folder, repo-relative and sorted. */
export async function pageFiles(dataDir: string, rel: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await pageFiles(dataDir, path)));
    else if (isPageFile(entry.name)) files.push(path);
  }
  return files.sort();
}

/**
 * The sorted page paths, each folder's in its order file's order — the
 * folders themselves where they first appear, so the listing still reads
 * top level first.
 */
async function inFolderOrder(dataDir: string, files: string[]): Promise<string[]> {
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    const folder = parentOf(file);
    const names = byFolder.get(folder) ?? [];
    names.push(file.slice(folder.length + 1));
    byFolder.set(folder, names);
  }
  const out: string[] = [];
  for (const [folder, names] of byFolder) {
    const order = parseOrder((await readTextFile(`${dataDir}/${folder}/${PAGE_ORDER_FILE}`)) ?? "");
    for (const name of inOrder(names, order)) out.push(`${folder}/${name}`);
  }
  return out;
}

/** A folder's pages' file names in its order — its own pages, not its subfolders'. */
async function folderOrder(dataDir: string, folder: string): Promise<string[]> {
  const names = (await pageFiles(dataDir, folder))
    .filter((file) => parentOf(file) === folder)
    .map((file) => file.slice(folder.length + 1));
  return inOrder(names, parseOrder((await readTextFile(`${dataDir}/${folder}/${PAGE_ORDER_FILE}`)) ?? ""));
}

/** Write a folder's order — local, for the sync tick to commit. */
async function writeOrder(dataDir: string, folder: string, names: string[]): Promise<void> {
  await writeTextFile(`${dataDir}/${folder}/${PAGE_ORDER_FILE}`, formatOrder(names));
}

/** `tasks/sub/a.md` -> `tasks/sub`. */
function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** A folder path: the special folder itself or one beneath it, of safe segments. */
function safeFolder(kind: PageFolder, path: string): string {
  const segments = path.split("/");
  if (segments[0] !== kind.folder || segments.some(badSegment)) {
    throw new Error(`Invalid folder: ${path}`);
  }
  return path;
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/** A page path: `<folder>/…/<name>.md`, of safe segments. */
function safe(kind: PageFolder, fileName: string): string {
  const segments = fileName.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== kind.folder ||
    segments.some(badSegment) ||
    !isPageFile(segments[segments.length - 1]!)
  ) {
    throw new Error(`Invalid ${kind.label} name: ${fileName}`);
  }
  return fileName;
}

/** "roadmap page" -> "Roadmap page", for a message that opens with it. */
function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
