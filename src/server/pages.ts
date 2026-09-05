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
// page in the tasks folder with somebody's name on it, which is why the two
// folders share every line below and differ only in their descriptor.

import { mkdir, readdir, stat } from "node:fs/promises";
import {
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
import { commitAndPush, removeAndPush } from "./git";
import { parsePage, slugify, titleFromFileName, type MarkdownPage } from "./parser";
import { getLogger, withSpan } from "./telemetry";

const log = getLogger("pages");

/** One special folder: where its pages live, and what one of them is called. */
export interface PageFolder {
  /** The folder's name, at the root of the data repo. */
  folder: string;
  /** What one page is called in messages — "roadmap page", "task". */
  label: string;
}

export const ROADMAP_FOLDER = "roadmap";
export const TASKS_FOLDER = "tasks";

/** The roadmap folder: markdown pages, one sidebar tab (roadmap.feature.md). */
export const ROADMAP: PageFolder = { folder: ROADMAP_FOLDER, label: "roadmap page" };

/** The tasks folder: the same pages, called tasks (tasks.feature.md). */
export const TASKS: PageFolder = { folder: TASKS_FOLDER, label: "task" };

/** Every special folder, in sidebar order. */
export const PAGE_FOLDERS: PageFolder[] = [ROADMAP, TASKS];

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

/**
 * Create a page: `<folder>/<slug>.md` holding its heading, committed and
 * pushed like a new feature. A `/` in the name nests it in a subfolder.
 */
export async function createPage(
  dataDir: string,
  kind: PageFolder,
  name: string,
): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
  const pageName = segments.pop() ?? "";
  if (!pageName) throw new Error(`${capitalize(kind.label)} name is required`);
  const stem = slugify(pageName);
  if (!stem) throw new Error(`${capitalize(kind.label)} name is required`);
  const folder = [kind.folder, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(kind, `${folder}/${stem}.md`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`${capitalize(kind.label)} already exists: ${fileName}`);
  }
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const projection = await absorb(dataDir, fileName, `# ${pageName}\n`);
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(
    dataDir,
    await pagePaths(dataDir, fileName),
    `Create ${kind.label}: ${pageName}`,
  );
  return fileName;
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
 */
async function absorb(dataDir: string, fileName: string, text: string): Promise<string> {
  const page = parsePage(text);
  const loaded = await loadPageDoc(dataDir, fileName);
  if (loaded === null) {
    const created = await createPageDoc(dataDir, fileName, importPageDoc(page));
    return projectPage(created.doc);
  }
  const next = reconcilePage(loaded.doc, page);
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
    name: page?.name || titleFromFileName(fileName.replace(/\.md$/, "")),
    ...(page?.assigned ? { assigned: page.assigned } : {}),
  };
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
