import { mkdir, readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  pull,
  theirsVersion,
  commitAndPush,
  moveAndPush,
  resolveConflict as gitResolve,
} from "./git";
import { parseFeature, markPublished, markProposed, slugify, titleFromFileName } from "./parser";

export { slugify } from "./parser";

export interface PublishResult {
  status: "published" | "conflict";
  /** On conflict: the remote side of the merge for this file. */
  theirs?: string;
  /** On conflict: the content the user tried to publish. */
  ours?: string;
  message: string;
}

function isFeatureFile(fileName: string): boolean {
  return fileName.endsWith(".feature.md");
}

export interface FeatureListing {
  /** Path relative to the data repo root, e.g. `billing/quotes.feature.md`. */
  fileName: string;
  /** Display name: the file's `# <name>` heading, or derived from the stem. */
  name: string;
}

/**
 * Folders are plain directories in the data repo (specs/folders.spec.md).
 * Hidden entries (`.git` and friends) are not part of the tree.
 */
async function walk(
  dataDir: string,
  rel = "",
): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true });
  } catch {
    return { files, folders };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      folders.push(path);
      const sub = await walk(dataDir, path);
      files.push(...sub.files);
      folders.push(...sub.folders);
    } else if (isFeatureFile(entry.name)) {
      files.push(path);
    }
  }
  return { files, folders };
}

/**
 * specs/ui.spec.md "Main page": the sidebar shows feature names, not file
 * names — each listed file carries its display name. Feature files anywhere
 * in the folder tree are listed, with folder-relative paths.
 */
export async function listFeatures(dataDir: string): Promise<FeatureListing[]> {
  const entries = (await walk(dataDir)).files.sort();
  return Promise.all(
    entries.map(async (fileName) => {
      let name = "";
      try {
        name = parseFeature(await Bun.file(`${dataDir}/${fileName}`).text()).name;
      } catch {
        // unreadable (e.g. deleted mid-listing): fall back to the stem
      }
      return { fileName, name: name || titleFromFileName(fileName) };
    }),
  );
}

/**
 * Every folder in the data repo, including empty ones — a freshly created
 * folder must show in the sidebar tree so features can be dragged into it.
 */
export async function listFolders(dataDir: string): Promise<string[]> {
  return (await walk(dataDir)).folders.sort();
}

export async function readFeature(dataDir: string, fileName: string): Promise<string | null> {
  const file = Bun.file(`${dataDir}/${safe(fileName)}`);
  return (await file.exists()) ? file.text() : null;
}

/**
 * Scenario "create new feature": creates a new feature file in the local
 * filesystem. A `/` in the name places the feature in a folder
 * (specs/folders.spec.md): `billing/Basic Quote` creates
 * `billing/basic-quote.feature.md`, creating the folders as needed.
 */
export async function createFeature(dataDir: string, name: string): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
  const featureName = segments.pop() ?? "";
  if (!featureName) throw new Error("Feature name is required");
  const folder = segments.map(slugify).filter(Boolean).join("/");
  const fileName = folder
    ? `${folder}/${slugify(featureName)}.feature.md`
    : `${slugify(featureName)}.feature.md`;
  const path = `${dataDir}/${safe(fileName)}`;
  if (await Bun.file(path).exists()) {
    throw new Error(`Feature file already exists: ${fileName}`);
  }
  if (folder) await mkdir(`${dataDir}/${folder}`, { recursive: true });
  await Bun.write(path, `# ${featureName}\n`);
  await commitAndPush(dataDir, fileName, `Create feature: ${featureName}`);
  return fileName;
}

/**
 * specs/folders.spec.md: create a folder for feature files. Nested
 * paths (`billing/sub`) are allowed; each segment is slugified like a file
 * stem. Git does not track empty directories, so the folder exists locally
 * until a feature lands in it — nothing to commit here.
 */
export async function createFolder(dataDir: string, path: string): Promise<string> {
  const folder = path.split("/").map(slugify).filter(Boolean).join("/");
  if (!folder) throw new Error("Folder name is required");
  safeFolder(folder);
  const full = `${dataDir}/${folder}`;
  if (await exists(full)) throw new Error(`Folder already exists: ${folder}`);
  await mkdir(full, { recursive: true });
  return folder;
}

/**
 * specs/folders.spec.md: only an empty folder can be deleted — one with
 * no files anywhere beneath it (macOS `.DS_Store` junk doesn't count). This
 * keeps folder deletion non-destructive: features must be moved out first.
 * Empty directories are untracked by git, so removal is a local fs operation.
 */
export async function deleteFolder(dataDir: string, path: string): Promise<void> {
  const folder = safeFolder(path);
  if (!folder) throw new Error("Folder name is required");
  const full = `${dataDir}/${folder}`;
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(full);
  } catch {
    throw new Error(`Folder not found: ${folder}`);
  }
  if (!s.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  const contents = (await readdir(full, { recursive: true })) as string[];
  const blocking = contents.filter((entry) => entry.split("/").pop() !== ".DS_Store");
  for (const entry of blocking) {
    if (!(await stat(`${full}/${entry}`)).isDirectory()) {
      throw new Error(`Folder is not empty: ${folder} — move its features out first`);
    }
  }
  await rm(full, { recursive: true });
}

/**
 * specs/folders.spec.md: drag-moving a feature into a folder is a
 * `git mv` into that directory, committed and pushed like a rename. The
 * target folder must already exist; the file name itself is unchanged.
 */
export async function moveFeature(
  dataDir: string,
  fileName: string,
  toFolder: string,
): Promise<{ fileName: string; message: string }> {
  const from = safe(fileName);
  const folder = safeFolder(toFolder);
  if (folder && !(await isDirectory(`${dataDir}/${folder}`))) {
    throw new Error(`Folder not found: ${folder}`);
  }
  const base = from.split("/").pop()!;
  const to = folder ? `${folder}/${base}` : base;
  if (to === from) return { fileName: from, message: "already there" };
  if (!(await Bun.file(`${dataDir}/${from}`).exists())) {
    throw new Error(`Feature file not found: ${from}`);
  }
  if (await Bun.file(`${dataDir}/${to}`).exists()) {
    throw new Error(`Feature file already exists: ${to}`);
  }
  const sync = await moveAndPush(dataDir, from, to, `Move feature: ${from} -> ${to}`);
  return { fileName: to, message: sync.message };
}

/**
 * specs/ui.spec.md "Main page": the Edit link next to the feature name edits
 * the actual feature file name. The new name is normalized the same way
 * createFeature builds one (slug stem + `.feature.md`), and the rename is
 * committed and pushed to GitHub using `git mv`.
 */
export async function renameFeature(
  dataDir: string,
  fileName: string,
  newFileName: string,
): Promise<{ fileName: string; message: string }> {
  const from = safe(fileName);
  const input = newFileName.trim().replace(/\.feature\.md$|\.feature$|\.md$/, "");
  // A plain name renames in place; a `/` path also moves between folders
  // (specs/folders.spec.md) — segments are slugified like file stems.
  const segments = input.split("/").map(slugify).filter(Boolean);
  const slug = segments.pop();
  if (!slug) throw new Error("Feature file name is required");
  const folder = input.includes("/")
    ? segments.join("/")
    : from.split("/").slice(0, -1).join("/");
  const to = folder ? `${folder}/${slug}.feature.md` : `${slug}.feature.md`;
  if (to === from) return { fileName: from, message: "file name unchanged" };
  if (!(await Bun.file(`${dataDir}/${from}`).exists())) {
    throw new Error(`Feature file not found: ${from}`);
  }
  if (await Bun.file(`${dataDir}/${to}`).exists()) {
    throw new Error(`Feature file already exists: ${to}`);
  }
  if (folder) await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const sync = await moveAndPush(dataDir, from, to, `Rename feature: ${from} -> ${to}`);
  return { fileName: to, message: sync.message };
}

export interface SaveResult {
  status: "saved";
  /** The content as written, with unpublished scenarios marked [proposed]. */
  content: string;
  message: string;
}

/**
 * Scenario "Scenario is automatically saved locally and pushed to GitHub":
 * write the feature to the local filesystem right away (we don't want to lose
 * any data), marking unpublished scenarios [proposed]. The reload cron then
 * commits and pushes saved scenarios after its git pull.
 */
export async function saveFeature(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<SaveResult> {
  const name = safe(fileName);
  const proposed = markProposed(content);
  await assertPublishedUnchanged(dataDir, name, proposed);
  await Bun.write(`${dataDir}/${name}`, proposed);
  return { status: "saved", content: proposed, message: "saved locally" };
}

/**
 * Scenario "Publish feature": every scenario is marked [published] (published
 * scenarios are immutable — specs/ui.spec.md); git pull first; on a clean
 * merge, save, then git commit and push. On a merge conflict, report both
 * sides so the user can resolve (accept yours / accept theirs / manual edit).
 */
export async function publishFeature(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<PublishResult> {
  const name = safe(fileName);
  const published = markPublished(content);
  await assertPublishedUnchanged(dataDir, name, published);
  const pullResult = await pull(dataDir);
  if (!pullResult.ok) {
    const theirs = (await theirsVersion(dataDir, name)) ?? "";
    return { status: "conflict", theirs, ours: published, message: pullResult.message };
  }
  await Bun.write(`${dataDir}/${name}`, published);
  const sync = await commitAndPush(dataDir, name, `Publish feature: ${name}`);
  return { status: "published", message: sync.message };
}

/** Complete a conflicted publish with the user's chosen resolution, then commit and push. */
export async function resolveFeatureConflict(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<PublishResult> {
  const sync = await gitResolve(dataDir, safe(fileName), markPublished(content));
  return { status: "published", message: sync.message };
}

/**
 * specs/ui.spec.md: "If a scenario is already published, then it is
 * immutable." A published scenario (same name and version) must survive a
 * publish with its body intact; adding a new version alongside it is fine.
 */
async function assertPublishedUnchanged(dataDir: string, fileName: string, next: string) {
  const existingText = await readFeature(dataDir, fileName);
  if (existingText === null) return;
  const before = parseFeature(existingText);
  const after = parseFeature(next);
  for (const old of before.scenarios) {
    if (!old.published) continue;
    const match = after.scenarios.find((s) => s.name === old.name && s.version === old.version);
    if (!match || match.body !== old.body) {
      throw new Error(`Scenario "${old.name}" @v${old.version} is published and immutable`);
    }
  }
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/** A feature file path: `/`-separated safe segments ending in `.feature.md`. */
function safe(fileName: string): string {
  const segments = fileName.split("/");
  if (segments.some(badSegment) || !isFeatureFile(segments[segments.length - 1]!)) {
    throw new Error(`Invalid feature file name: ${fileName}`);
  }
  return fileName;
}

/** A folder path relative to the data repo; empty means the top level. */
function safeFolder(path: string): string {
  const folder = path.replace(/^\/+|\/+$/g, "");
  if (folder && folder.split("/").some(badSegment)) {
    throw new Error(`Invalid folder path: ${path}`);
  }
  return folder;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
