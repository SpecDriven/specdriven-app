// The roadmap folder (specs/app/roadmap.feature.md): `roadmap/` in the data
// repo, holding regular markdown files rather than `.feature.md` specs. It is
// a special folder — shown above the feature folders in the sidebar, and only
// while the user setting for it is on. With that setting on, the folder is
// created if it is not there yet, and the sync tick commits everything in it
// like any other saved change (src/server/reload.ts).
//
// A page is more than a file, though: like a feature it has an Automerge
// document behind it (src/server/automerge/roadmap.ts) — so concurrent edits
// merge instead of conflicting — and it can be assigned to a project member,
// written into the file as the same `**Assigned:** <name>` line a feature
// carries (src/server/members.ts).

import { mkdir, readdir, stat } from "node:fs/promises";
import {
  importRoadmapDoc,
  isRoadmapProjectionOf,
  projectRoadmap,
  reconcileRoadmap,
} from "./automerge/roadmap";
import {
  createRoadmapDoc,
  hasRoadmapDoc,
  listRoadmapDocs,
  loadRoadmapDoc,
  removeRoadmapDoc,
  roadmapDocDirRel,
  saveRoadmapDoc,
} from "./automerge/store";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { commitAndPush, removeAndPush } from "./git";
import { parseRoadmap, slugify, titleFromFileName, type Roadmap } from "./parser";
import { getLogger, withSpan } from "./telemetry";

const log = getLogger("roadmap");

/** The special folder's name, at the root of the data repo. */
export const ROADMAP_FOLDER = "roadmap";

/** True for the roadmap folder itself and anything beneath it. */
export function isRoadmapPath(path: string): boolean {
  return path === ROADMAP_FOLDER || path.startsWith(`${ROADMAP_FOLDER}/`);
}

/** A markdown page — a feature file living there by accident is not one. */
export function isRoadmapFile(fileName: string): boolean {
  return fileName.endsWith(".md") && !fileName.endsWith(".feature.md");
}

/** What the sidebar lists for one page. */
export interface RoadmapListing {
  /** Path relative to the data repo root, e.g. `roadmap/pricing.md`. */
  fileName: string;
  /** Display name: the file's `# <name>` heading, or derived from the stem. */
  name: string;
  /** The project member the page is assigned to, if any. */
  assigned?: string;
}

/** A page as the editor sees it: its listing, plus the markdown itself. */
export interface RoadmapView extends RoadmapListing {
  content: string;
}

/**
 * Scenario "Create roadmap folder if necessary": with the Roadmap setting on,
 * the folder exists — created here when it does not. Git does not track empty
 * directories, so a fresh one holds nothing to commit until a page lands in
 * it. Returns whether this call created it.
 */
export async function ensureRoadmapFolder(dataDir: string): Promise<boolean> {
  const path = `${dataDir}/${ROADMAP_FOLDER}`;
  if (await isDirectory(path)) return false;
  await mkdir(path, { recursive: true });
  log.info(`created the ${ROADMAP_FOLDER} folder`, { "specdriven.dir": dataDir });
  return true;
}

/** Every markdown page in the roadmap folder, nested ones included. */
export async function listRoadmap(dataDir: string): Promise<RoadmapListing[]> {
  const files = await roadmapFiles(dataDir);
  return Promise.all(
    files.map(async (fileName) => {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      const page = text === null ? null : parseRoadmap(text);
      return listing(fileName, page);
    }),
  );
}

export async function readRoadmapPage(
  dataDir: string,
  fileName: string,
): Promise<RoadmapView | null> {
  const file = safe(fileName);
  const content = await readTextFile(`${dataDir}/${file}`);
  if (content === null) return null;
  return { ...listing(file, parseRoadmap(content)), content };
}

/**
 * Save a page as the editor holds it. Local like a saved scenario — the
 * reload cron commits and pushes it — and through the document, so what lands
 * on disk is the document's projection.
 */
export async function saveRoadmapPage(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<RoadmapView> {
  const file = safe(fileName);
  const projection = await absorb(dataDir, file, content);
  await writeTextFile(`${dataDir}/${file}`, projection);
  return { ...listing(file, parseRoadmap(projection)), content: projection };
}

/**
 * Create a page: `roadmap/<slug>.md` holding its heading, committed and
 * pushed like a new feature. A `/` in the name nests it in a subfolder.
 */
export async function createRoadmapPage(dataDir: string, name: string): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
  const pageName = segments.pop() ?? "";
  if (!pageName) throw new Error("Roadmap page name is required");
  const stem = slugify(pageName);
  if (!stem) throw new Error("Roadmap page name is required");
  const folder = [ROADMAP_FOLDER, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(`${folder}/${stem}.md`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`Roadmap page already exists: ${fileName}`);
  }
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const projection = await absorb(dataDir, fileName, `# ${pageName}\n`);
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(
    dataDir,
    await pagePaths(dataDir, fileName),
    `Create roadmap page: ${pageName}`,
  );
  return fileName;
}

/**
 * Delete a page — the markdown and its document — committed and pushed like
 * a deleted feature (specs/app/roadmap.feature.md). The sidebar's ⋯ menu
 * offers it; Undo is not possible past the push, so the client confirms.
 */
export async function deleteRoadmapPage(
  dataDir: string,
  fileName: string,
): Promise<{ message: string }> {
  const file = safe(fileName);
  if (!(await fileExists(`${dataDir}/${file}`))) {
    throw new Error(`Roadmap page not found: ${file}`);
  }
  const paths = await pagePaths(dataDir, file);
  const sync = await removeAndPush(dataDir, paths, `Delete roadmap page: ${file}`);
  await removeRoadmapDoc(dataDir, file);
  return { message: sync.message };
}

/**
 * The roadmap side of the sync tick's drift pass (automerge/driftSync.ts):
 * markdown that changed without its document — an external edit, a teammate's
 * push, a page that predates its document — is absorbed (or first imported),
 * and the file rewritten to the document's projection. A document whose page
 * is gone is dropped: the markdown is the interchange format.
 */
export async function importRoadmapDrift(dataDir: string): Promise<string> {
  return withSpan("sync.import_roadmap_drift", { "specdriven.dir": dataDir }, async (span) => {
    let imported = 0;
    let absorbed = 0;
    for (const fileName of await roadmapFiles(dataDir)) {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      if (text === null) continue;
      const loaded = await loadRoadmapDoc(dataDir, fileName);
      if (loaded === null) {
        const page = importRoadmapDoc(parseRoadmap(text));
        const created = await createRoadmapDoc(dataDir, fileName, page);
        const projection = projectRoadmap(created.doc);
        if (projection !== text) await writeTextFile(`${dataDir}/${fileName}`, projection);
        imported++;
        continue;
      }
      if (isRoadmapProjectionOf(text, loaded.doc)) continue;
      const next = reconcileRoadmap(loaded.doc, parseRoadmap(text));
      await saveRoadmapDoc(dataDir, fileName, next, loaded.heads);
      await writeTextFile(`${dataDir}/${fileName}`, projectRoadmap(next));
      absorbed++;
    }
    let removed = 0;
    for (const fileName of await listRoadmapDocs(dataDir)) {
      if (!(await fileExists(`${dataDir}/${fileName}`))) {
        await removeRoadmapDoc(dataDir, fileName);
        removed++;
      }
    }
    span.setAttributes({
      "sync.roadmap_imported": imported,
      "sync.roadmap_absorbed": absorbed,
      "sync.roadmap_removed": removed,
    });
    const parts = [];
    if (imported > 0) parts.push(`imported ${imported} roadmap page(s) into documents`);
    if (absorbed > 0) parts.push(`absorbed ${absorbed} externally edited roadmap page(s)`);
    if (removed > 0) parts.push(`dropped ${removed} document(s) for deleted roadmap page(s)`);
    return parts.join("; ");
  });
}

/**
 * Feed a page's markdown into its document — reconciled as CRDT operations,
 * or imported whole for a page that has none yet — and return the projection
 * the file must now hold (features.ts absorbIntoDoc).
 */
async function absorb(dataDir: string, fileName: string, text: string): Promise<string> {
  const page = parseRoadmap(text);
  const loaded = await loadRoadmapDoc(dataDir, fileName);
  if (loaded === null) {
    const created = await createRoadmapDoc(dataDir, fileName, importRoadmapDoc(page));
    return projectRoadmap(created.doc);
  }
  const next = reconcileRoadmap(loaded.doc, page);
  await saveRoadmapDoc(dataDir, fileName, next, loaded.heads);
  return projectRoadmap(next);
}

/** What a mutation commits for a page: the markdown and its document. */
async function pagePaths(dataDir: string, fileName: string): Promise<string[]> {
  return (await hasRoadmapDoc(dataDir, fileName))
    ? [fileName, roadmapDocDirRel(fileName)]
    : [fileName];
}

function listing(fileName: string, page: Roadmap | null): RoadmapListing {
  return {
    fileName,
    name: page?.name || titleFromFileName(fileName.replace(/\.md$/, "")),
    ...(page?.assigned ? { assigned: page.assigned } : {}),
  };
}

/** Markdown files under the roadmap folder, repo-relative and sorted. */
async function roadmapFiles(dataDir: string, rel = ROADMAP_FOLDER): Promise<string[]> {
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
    if (entry.isDirectory()) files.push(...(await roadmapFiles(dataDir, path)));
    else if (isRoadmapFile(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/** A page path: `roadmap/…/<name>.md`, of safe segments. */
function safe(fileName: string): string {
  const segments = fileName.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== ROADMAP_FOLDER ||
    segments.some(badSegment) ||
    !isRoadmapFile(segments[segments.length - 1]!)
  ) {
    throw new Error(`Invalid roadmap page name: ${fileName}`);
  }
  return fileName;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
