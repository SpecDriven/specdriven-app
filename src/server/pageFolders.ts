// The special page folders — roadmap, tasks, notebook — as data every module
// can name without pulling in pages.ts, which itself commits through the git
// layer. The git layer's auto-save summary (git/saveSummary.ts) reads these
// to call a changed page by what it is.

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
  /**
   * Whether the folder keeps its pages in an order of its own — an
   * `order.txt` in each folder (src/server/pageOrder.ts) — rather than in
   * name order: the tasks, which are dragged into the order they are to be
   * done in (specs/app/tasks.feature.md "Reorder tasks by dragging"), and the
   * roadmap's pages (specs/app/roadmap.feature.md "Reorder roadmap pages").
   */
  ordered?: boolean;
}

export const ROADMAP_FOLDER = "roadmap";
export const TASKS_FOLDER = "tasks";
export const NOTEBOOK_FOLDER = "notebook";

/** The roadmap folder: markdown pages, one sidebar tab (roadmap.feature.md). */
export const ROADMAP: PageFolder = { folder: ROADMAP_FOLDER, label: "roadmap page", ordered: true };

/** The tasks folder: the same pages, called tasks (tasks.feature.md). */
export const TASKS: PageFolder = { folder: TASKS_FOLDER, label: "task", ordered: true };

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
