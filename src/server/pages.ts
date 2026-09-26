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

import { mkdir, readdir, stat } from "node:fs/promises";
import { threeWayPage } from "./automerge/merge";
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
import { getLogger, withSpan } from "./telemetry";

const log = getLogger("pages");

/** One special folder: where its pages live, and what one of them is called. */
export interface PageFolder {
  /** The folder's name, at the root of the data repo. */
  folder: string;
  /** What one page is called in messages — "roadmap page", "task". */
  label: string;
  /**
   * Whether the folder is flat: a `/` in a new page's name nests it in a
   * subfolder unless this says otherwise. The notebook is flat and
   * chronological (specs/app/engineering-notebook.feature.md); existing
   * nested files are still listed and still open, since the markdown is the
   * interchange format and a hand-made subfolder must not disappear.
   */
  flat?: boolean;
}

export const ROADMAP_FOLDER = "roadmap";
export const TASKS_FOLDER = "tasks";
export const NOTEBOOK_FOLDER = "notebook";

/** The roadmap folder: markdown pages, one sidebar tab (roadmap.feature.md). */
export const ROADMAP: PageFolder = { folder: ROADMAP_FOLDER, label: "roadmap page" };

/** The tasks folder: the same pages, called tasks (tasks.feature.md). */
export const TASKS: PageFolder = { folder: TASKS_FOLDER, label: "task" };

/**
 * The notebook folder: the same pages again, called entries and kept flat
 * (specs/app/engineering-notebook.feature.md). What makes an entry an entry
 * — its date-prefixed file name, its author and its kind — lives in
 * notebook.ts; everything a page already does it does here.
 */
export const NOTEBOOK: PageFolder = {
  folder: NOTEBOOK_FOLDER,
  label: "notebook entry",
  flat: true,
};

/** Every special folder, in sidebar order. */
export const PAGE_FOLDERS: PageFolder[] = [ROADMAP, TASKS, NOTEBOOK];

/** The folder a name stands for, or null — how a route picks its descriptor. */
export function pageFolderNamed(folder: string): PageFolder | null {
  return PAGE_FOLDERS.find((kind) => kind.folder === folder) ?? null;
}

/** True for a special folder itself and anything beneath it. */
export function isPageFolderPath(path: string): boolean {
  return PAGE_FOLDERS.some(
    ({ folder }) => path === folder || path.startsWith(`${folder}/`),
  );
}

/** A markdown page — a feature file living there by accident is not one. */
export function isPageFile(fileName: string): boolean {
  return fileName.endsWith(".md") && !fileName.endsWith(".feature.md");
}

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

/** Every markdown page in the folder, nested ones included. */
export async function listPages(dataDir: string, kind: PageFolder): Promise<PageListing[]> {
  const files = await pageFiles(dataDir, kind.folder);
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
 * on disk is the document's projection.
 */
export async function savePage(
  dataDir: string,
  kind: PageFolder,
  fileName: string,
  content: string,
): Promise<PageView> {
  const file = safe(kind, fileName);
  const projection = await absorb(dataDir, file, content);
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
  const segments = kind.flat ? [name.trim()] : name.split("/").map((s) => s.trim());
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
  const segments = kind.flat ? [newName.trim()] : newName.split("/").map((s) => s.trim());
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
    await savePage(dataDir, kind, from, serializePage({ ...page, name: title }));
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
  const sync = await moveAndPush(
    dataDir,
    from,
    to,
    `Rename ${kind.label}: ${from} -> ${to}`,
    moves,
  );
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
  return { message: sync.message };
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
 * first and the text folded in on top of it (threeWayPage) — otherwise the
 * write would drop it from the file, the document and git without a trace,
 * the same hole absorbIntoDoc closes for `.feature.md` files.
 */
async function absorb(dataDir: string, fileName: string, text: string): Promise<string> {
  let page = parsePage(text);
  const loaded = await loadPageDoc(dataDir, fileName);
  if (loaded === null) {
    const created = await createPageDoc(dataDir, fileName, importPageDoc(page));
    return projectPage(created.doc);
  }
  let doc = loaded.doc;
  const disk = await readTextFile(`${dataDir}/${fileName}`);
  if (disk !== null && !isPageProjectionOf(disk, doc)) {
    const absorbed = reconcilePage(doc, parsePage(disk));
    page = threeWayPage(docToPage(doc), page, docToPage(absorbed));
    doc = absorbed;
    log.info(`absorbed drifted ${fileName} into its document before writing over it`);
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
