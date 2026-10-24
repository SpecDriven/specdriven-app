import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import {
  FOLDER_DISPLAY_NAME_FILE,
  LEGACY_FOLDER_DISPLAY_NAME_FILE,
  SPECS_FOLDER,
  isFeatureFile,
  isFolderDisplayNameFile,
  isSpecsFolderPath,
  walk,
} from "./walk";
import type * as A from "@automerge/automerge";
import { absorbDrift, autoResolveMergeConflicts, mergeInProgress } from "./automerge/driftSync";
import { threeWayFeature, threeWayFeatureStrict } from "./automerge/merge";
import { docToFeature, interleaveDrafts, isProjectionOf, projectFeature, projectionFor } from "./automerge/project";
import {
  assertPublishedKept,
  importFeatureDoc,
  reconcile,
  removeDraftScenario,
  setConfluencePage,
  setPullRequests,
  setResourceLinks,
  setScenarioFiles,
} from "./automerge/reconcile";
import {
  createFeatureDoc,
  docDirRel,
  hasFeatureDoc,
  listFeatureDocs,
  loadFeatureDoc,
  saveFeatureDoc,
} from "./automerge/store";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { errorAttributes, getLogger, withSpan } from "./telemetry";
import type { FeatureDoc } from "./automerge/schema";
import {
  pull,
  theirsVersion,
  commitAndPush,
  moveAndPush,
  removeAndPush,
  resolveConflict as gitResolve,
} from "./git";
import {
  parseFeature,
  featureTextError,
  markPublished,
  markProposed,
  markScenarioPublished,
  serializeFeature,
  renameFeatureName,
  slugify,
  titleFromFileName,
} from "./parser";
import type {
  ConfluencePage,
  Feature,
  PullRequestLink,
  ResourceLink,
  ScenarioFile,
  ScenarioPick,
  ScenarioStatus,
  ScenarioTarget,
  SpecAttribute,
} from "./parser";
import { RESOURCE_LINK_TOOLS } from "./resourceLinks";
import type { ResourceLinkKind } from "./resourceLinks";
import { cleanLine } from "./text";
import { currentAuthor } from "./user";

export { slugify } from "./parser";
export type { ScenarioTarget } from "./parser";

export interface PublishResult {
  status: "published" | "conflict";
  /** On conflict: the remote side of the merge for this file. */
  theirs?: string;
  /** On conflict: the content the user tried to publish. */
  ours?: string;
  message: string;
}

export { walk, SPECS_FOLDER, isSpecsFolderPath };

const log = getLogger("features");

/**
 * The spec tree's folder exists, created here when it does not — the same
 * shape as ensurePageFolder, but unconditional: `specs/`
 * is where features live, not an opt-in tab. Git does not track empty
 * directories, so a fresh one holds nothing to commit until a feature lands in
 * it. Returns whether this call created it.
 */
export async function ensureSpecsFolder(dataDir: string): Promise<boolean> {
  const path = `${dataDir}/${SPECS_FOLDER}`;
  if (await isDirectory(path)) return false;
  await mkdir(path, { recursive: true });
  log.info("created the specs folder", { "specdriven.dir": dataDir });
  return true;
}

export interface FeatureListing {
  /** Path relative to the data repo root, e.g. `billing/quotes.feature.md`. */
  fileName: string;
  /** Display name: the file's `# <name>` heading, or derived from the stem. */
  name: string;
  /** The file's scenarios, for scenario-level code gen selection
      (specs/agents/claude.feature.md) and the sidebar's publish rollup
      (specs/ui/ui.feature.md "Design system"). */
  scenarios: (ScenarioPick & { status: ScenarioStatus; attributes?: SpecAttribute[] })[];
  /** The project member the feature is assigned to, for the sidebar filter. */
  assigned?: string;
  /**
   * The feature's own custom attributes, and each scenario's above
   * (specs/app/custom-attributes.feature.md): for the sidebar's attribute
   * filter, and the names a `from` slot may refer to.
   */
  attributes?: SpecAttribute[];
}

/**
 * specs/ui/ui.feature.md "Main page": the sidebar shows feature names, not file
 * names — each listed file carries its display name. Feature files anywhere
 * in the folder tree are listed, with folder-relative paths.
 */
export async function listFeatures(dataDir: string): Promise<FeatureListing[]> {
  const entries = (await walk(dataDir)).files.sort();
  return Promise.all(
    entries.map(async (fileName) => {
      let name = "";
      let assigned: string | undefined;
      let attributes: SpecAttribute[] | undefined;
      let scenarios: FeatureListing["scenarios"] = [];
      try {
        const parsed = parseFeature(await readFile(`${dataDir}/${fileName}`, "utf8"));
        name = parsed.name;
        assigned = parsed.assigned;
        attributes = parsed.attributes;
        scenarios = parsed.scenarios.map(({ name, version, status, attributes }) => ({
          name,
          version,
          status,
          ...(attributes ? { attributes } : {}),
        }));
      } catch {
        // unreadable (e.g. deleted mid-listing): fall back to the stem
      }
      return {
        fileName,
        name: name || titleFromFileName(fileName),
        scenarios,
        ...(assigned ? { assigned } : {}),
        ...(attributes ? { attributes } : {}),
      };
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

/**
 * A folder's display name (specs/ui/folders.feature.md "describe a folder"):
 * a `display-name.txt` inside it — or, in a data repo written before that
 * name, a `description.txt` — whose first non-blank line the sidebar shows
 * in place of the folder name. Plain text, one line; anything past the
 * first line is left for whoever reads the file on GitHub.
 */
export { FOLDER_DISPLAY_NAME_FILE } from "./walk";

/** The display name a folder's display-name file gives it, or null without one. */
export async function readFolderDescription(dataDir: string, folder: string): Promise<string | null> {
  const dir = `${dataDir}/${safeFolder(folder)}`;
  const text =
    (await readTextFile(`${dir}/${FOLDER_DISPLAY_NAME_FILE}`)) ??
    (await readTextFile(`${dir}/${LEGACY_FOLDER_DISPLAY_NAME_FILE}`));
  if (text === null) return null;
  return firstLine(text);
}

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}

/**
 * specs/ui/folders.feature.md "edit a folder's display name": the folder's
 * display-name.txt gets the new name as its first non-blank line — any
 * lines past it stay — committed and pushed. A legacy description.txt is
 * moved over in the same commit. A blank name clears the display name: the
 * file goes, a `git rm`, and the folder shows its name.
 */
export async function setFolderDescription(
  dataDir: string,
  path: string,
  name: string,
): Promise<{ description: string | null; message: string }> {
  const folder = safeFolder(path);
  if (folder === SPECS_FOLDER) throw new Error("Folder name is required");
  if (!(await isDirectory(`${dataDir}/${folder}`))) throw new Error(`Folder not found: ${folder}`);
  const description = cleanLine(name);
  const file = `${folder}/${FOLDER_DISPLAY_NAME_FILE}`;
  const legacy = `${folder}/${LEGACY_FOLDER_DISPLAY_NAME_FILE}`;
  const current = await readTextFile(`${dataDir}/${file}`);
  const legacyText = await readTextFile(`${dataDir}/${legacy}`);
  const present = [...(current !== null ? [file] : []), ...(legacyText !== null ? [legacy] : [])];
  if (!description) {
    if (present.length === 0) return { description: null, message: "no display name to clear" };
    const sync = await removeAndPush(dataDir, present, `Clear folder display name: ${folder}`);
    return { description: null, message: sync.message };
  }
  const base = current ?? legacyText;
  if (legacyText === null && base !== null && firstLine(base) === description) {
    return { description, message: "display name unchanged" };
  }
  const lines = (base ?? "").split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().length > 0);
  const text =
    first === -1 ? `${description}\n` : [...lines.slice(0, first), description, ...lines.slice(first + 1)].join("\n");
  await writeTextFile(`${dataDir}/${file}`, text);
  if (legacyText !== null) await rm(`${dataDir}/${legacy}`, { force: true });
  const sync = await commitAndPush(
    dataDir,
    legacyText !== null ? [file, legacy] : file,
    `Set folder display name: ${folder} -> ${description}`,
  );
  return { description, message: sync.message };
}

/**
 * Every described folder's description, keyed by folder path — what the
 * listing carries beside the folder list, so the tree can label a folder
 * by its description without a fetch per folder.
 */
export async function listFolderDescriptions(dataDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const folder of await listFolders(dataDir)) {
    const description = await readFolderDescription(dataDir, folder);
    if (description !== null) out[folder] = description;
  }
  return out;
}

export async function readFeature(dataDir: string, fileName: string): Promise<string | null> {
  return readTextFile(`${dataDir}/${safe(fileName)}`);
}

/**
 * The feature as the editor should see it: the `.feature.md` content plus
 * what lives only in the Automerge document — the draft scenarios
 * (specs/datastore/automerge-store.feature.md "draft scenarios live in the
 * document only"), serialized with explicit [draft] chips so a later save keeps
 * them drafts, and the external links the projection leaves out while "Publish
 * external links" is off (specs/external-links/project-management-jira-
 * linear-etc.feature.md) — and the same thing parsed, each scenario carrying
 * the document's id for it (`Scenario.id`), which the markdown never does. The
 * file stays the source for everything it holds — the document only contributes
 * what the file cannot see.
 */
export interface FeatureView {
  content: string;
  parsed: Feature;
}

export async function readFeatureView(
  dataDir: string,
  fileName: string,
): Promise<FeatureView | null> {
  const content = await readFeature(dataDir, fileName);
  if (content === null) return null;
  return featureView(dataDir, safe(fileName), content);
}

/** The editor's view as text alone — a code gen session's input. */
export async function readFeatureForEditor(
  dataDir: string,
  fileName: string,
): Promise<string | null> {
  return (await readFeatureView(dataDir, fileName))?.content ?? null;
}

/** The Aha! and Figma lists a feature or scenario carries, as spread-able keys. */
function resourcesOf(s: { aha?: ResourceLink[]; figma?: ResourceLink[] }) {
  return {
    ...(s.aha ? { aha: s.aha } : {}),
    ...(s.figma ? { figma: s.figma } : {}),
  };
}

/**
 * Fold the document's drafts, its ids, the external links the file doesn't
 * carry, and the pull request links it never carries
 * (specs/external-links/related-pull-requests.feature.md), into a feature
 * text for the editor.
 */
async function featureView(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<FeatureView> {
  const feature = parseFeature(content);
  const loaded = await loadFeatureDoc(dataDir, fileName);
  if (loaded === null) return { content, parsed: feature };
  const inDoc = docToFeature(loaded.doc);
  const key = (s: { name: string; version: number }) => `${s.name}@v${s.version}`;
  const ids = new Map(loaded.doc.specs.map((s) => [key(s), s.id] as const));
  // Plain copies of the document's links (docToFeature strips the proxies).
  const docLinks = new Map(inDoc.scenarios.map((s) => [key(s), s.link] as const));
  // qTest test cases (specs/external-links/qtest-test-cases.feature.md) are
  // external links too: the file holds them only while links are published.
  const docQtests = new Map(inDoc.scenarios.map((s) => [key(s), s.qtest] as const));
  const docPrs = new Map(inDoc.scenarios.map((s) => [key(s), s.prs] as const));
  // Aha! and Figma links (specs/external-links/aha-and-figma-links.feature.md):
  // the document's alone, like the pull request links.
  const docResources = new Map(
    inDoc.scenarios.map((s) => [key(s), resourcesOf(s)] as const),
  );
  // Stored files (specs/editor/store-associated-files.feature.md): the
  // document's alone, like the pull request links.
  const docFiles = new Map(inDoc.scenarios.map((s) => [key(s), s.files] as const));
  // Feature flags (specs/app/feature-flags.feature.md): a draft is the
  // document's alone, so its flags come from there too.
  const docFlags = new Map(inDoc.scenarios.map((s) => [key(s), s.flags] as const));
  // Custom attributes (specs/app/custom-attributes.feature.md): the same.
  const docAttributes = new Map(inDoc.scenarios.map((s) => [key(s), s.attributes] as const));
  // Authorship (specs/app/specs-authorship.feature.md) is the document's
  // record; the file carries it only while the repo asks for it, and a hand
  // edit of those lines never moves it (reconcile.ts assignAuthors).
  const authorsOf = (s: { createdBy?: string; updatedBy?: string }) => ({
    ...(s.createdBy ? { createdBy: s.createdBy } : {}),
    ...(s.updatedBy ? { updatedBy: s.updatedBy } : {}),
  });
  const docAuthors = new Map(inDoc.scenarios.map((s) => [key(s), authorsOf(s)] as const));
  const have = new Set(feature.scenarios.map(key));
  const drafts = loaded.doc.specs
    .filter((s) => s.status === "draft" && !have.has(key(s)))
    .map((s) => {
      const link = docLinks.get(key(s));
      const qtest = docQtests.get(key(s));
      const prs = docPrs.get(key(s));
      const files = docFiles.get(key(s));
      const flags = docFlags.get(key(s));
      const attributes = docAttributes.get(key(s));
      return {
        id: s.id,
        name: s.name,
        version: s.version,
        status: s.status,
        body: s.body,
        tests: [...s.tests],
        ...(s.negative ? { negative: true as const } : {}),
        ...(flags ? { flags } : {}),
        ...(attributes ? { attributes } : {}),
        ...(link ? { link } : {}),
        ...(qtest ? { qtest } : {}),
        ...(prs ? { prs } : {}),
        ...docResources.get(key(s)),
        ...(files ? { files } : {}),
        ...docAuthors.get(key(s)),
      };
    });
  // Links: the file's own where it has one (it is the source for what it
  // holds), else the document's. A file written with links off has none,
  // and the editor must still show — and keep — them.
  let linked = 0;
  const scenarios = feature.scenarios.map((s) => {
    const id = ids.get(key(s));
    const link = s.link ?? docLinks.get(key(s));
    if (link && !s.link) linked++;
    const qtest = s.qtest ?? docQtests.get(key(s));
    if (qtest && !s.qtest) linked++;
    const prs = docPrs.get(key(s));
    const files = docFiles.get(key(s));
    const { createdBy: _c, updatedBy: _u, ...rest } = s;
    return {
      ...rest,
      ...(id === undefined ? {} : { id }),
      ...(link ? { link } : {}),
      ...(qtest ? { qtest } : {}),
      ...(prs ? { prs } : {}),
      ...docResources.get(key(s)),
      ...(files ? { files } : {}),
      ...docAuthors.get(key(s)),
    };
  });
  const link = feature.link ?? inDoc.link;
  if (link && !feature.link) linked++;
  const qtest = feature.qtest ?? inDoc.qtest;
  if (qtest && !feature.qtest) linked++;
  const confluence = feature.confluence ?? inDoc.confluence;
  if (confluence && !feature.confluence) linked++;
  // Pull request links are the document's alone: the file never holds them,
  // and serializeFeature never writes them, so `content` is unaffected.
  const { createdBy: _c, updatedBy: _u, ...featureRest } = feature;
  const parsed: Feature = {
    ...featureRest,
    ...(link ? { link } : {}),
    ...(qtest ? { qtest } : {}),
    ...(confluence ? { confluence } : {}),
    ...(inDoc.confluencePage ? { confluencePage: inDoc.confluencePage } : {}),
    ...(inDoc.prs ? { prs: inDoc.prs } : {}),
    ...resourcesOf(inDoc),
    ...authorsOf(inDoc),
    // The file's order for what the file holds, each draft next to where the
    // document has it (project.ts interleaveDrafts): what the editor shows
    // is what its save sends back, drafts and all, in one order.
    scenarios: interleaveDrafts(
      scenarios,
      inDoc.scenarios.flatMap((s) => {
        if (have.has(key(s))) return [s];
        const draft = drafts.find((d) => key(d) === key(s));
        return draft ? [draft] : [];
      }),
      key,
    ),
  };
  // The text keeps the file's form for authorship: lines only where the
  // file has them, the parsed view carrying the document's record always.
  const authored =
    !!(feature.createdBy || feature.updatedBy) ||
    feature.scenarios.some((s) => s.createdBy || s.updatedBy);
  return {
    content:
      drafts.length === 0 && linked === 0
        ? content
        : serializeFeature(parsed, { authors: authored }),
    parsed,
  };
}

/**
 * Rewrite every feature file to its document's current projection — what
 * the "Publish external links" switch does on the spot, and the repo's
 * `authors-in-markdown` switch (specs/app/specs-authorship.feature.md), so
 * toggling either puts the links or the authors into (or takes them out of)
 * every `.feature.md` at once rather
 * than one file at a time as they happen to be edited. Local writes; the
 * reload cron commits and pushes them like any saved change. Returns how
 * many files changed.
 */
export async function reprojectFeatures(dataDir: string): Promise<number> {
  const options = await projectionFor(dataDir);
  let changed = 0;
  for (const fileName of await listFeatureDocs(dataDir)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null) continue;
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) continue;
    const projection = projectFeature(loaded.doc, options);
    // Only a file that already is a projection — in the other form — is
    // rewritten; a drifted file is left for the sync tick to absorb first.
    if (text === projection || !isProjectionOf(text, loaded.doc)) continue;
    await writeTextFile(`${dataDir}/${fileName}`, projection);
    changed++;
  }
  return changed;
}

/**
 * Scenario "create new feature": creates a new feature file in the local
 * filesystem. A `/` in the name places the feature in a folder
 * (specs/ui/folders.feature.md): `billing/Basic Quote` creates
 * `specs/billing/basic-quote.feature.md`, creating the folders as needed. The
 * file holds the heading alone unless `text` brings the whole feature — a
 * plugin's scaffold (an Event Model slice's, through @specdriven/host),
 * whose heading is the name.
 *
 * The name is relative to the spec tree: a leading `specs/` is accepted (the
 * client lists folders with it) but never doubled. `message` words the commit
 * (a spec proposal names its proposer there, src/server/proposals/service.ts).
 */
export async function createFeature(
  dataDir: string,
  name: string,
  text?: string,
  message?: (featureName: string) => string,
): Promise<string> {
  const segments = name.split("/").map(cleanLine);
  const featureName = segments.pop() ?? "";
  if (!featureName) throw new Error("Feature name is required");
  const within = segments.map(slugify).filter(Boolean);
  if (within[0] === SPECS_FOLDER) within.shift();
  const folder = [SPECS_FOLDER, ...within].join("/");
  const fileName = `${folder}/${slugify(featureName)}.feature.md`;
  const path = `${dataDir}/${safe(fileName)}`;
  if (await fileExists(path)) {
    throw new Error(`Feature file already exists: ${fileName}`);
  }
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  await writeFeatureFile(dataDir, safe(fileName), text ?? `# ${featureName}\n`);
  await commitAndPush(
    dataDir,
    await featurePaths(dataDir, fileName),
    message ? message(featureName) : `Create feature: ${featureName}`,
  );
  return fileName;
}

/**
 * specs/ui/folders.feature.md: create a folder for feature files, under the
 * spec tree. Nested paths (`billing/sub`) are allowed; each segment is
 * slugified like a file stem, and a leading `specs/` is accepted rather than
 * doubled. Git does not track empty directories, so the folder exists locally
 * until a feature lands in it — nothing to commit here.
 */
export async function createFolder(dataDir: string, path: string): Promise<string> {
  const segments = path.split("/").map(slugify).filter(Boolean);
  if (segments[0] === SPECS_FOLDER) segments.shift();
  if (segments.length === 0) throw new Error("Folder name is required");
  const folder = safeFolder([SPECS_FOLDER, ...segments].join("/"));
  const full = `${dataDir}/${folder}`;
  if (await exists(full)) throw new Error(`Folder already exists: ${folder}`);
  await mkdir(full, { recursive: true });
  return folder;
}

/**
 * specs/ui/folders.feature.md "delete a folder": an empty folder — one with
 * no files anywhere beneath it (macOS `.DS_Store` junk doesn't count) — is
 * removed as a local fs operation, git never having tracked it. A folder
 * with files beneath it is refused unless `force` is set: then it goes the
 * way a feature does ("delete a folder with features in it"), a `git rm -r`
 * of the folder and of its features' Automerge documents, committed and
 * pushed, and whatever git did not track is swept off disk after. The
 * client asks for confirmation first, naming how many features go.
 * The spec tree's own root is not a folder anyone may delete.
 */
export async function deleteFolder(
  dataDir: string,
  path: string,
  { force = false }: { force?: boolean } = {},
): Promise<{ message: string; features: number }> {
  const folder = safeFolder(path);
  if (folder === SPECS_FOLDER) throw new Error("Folder name is required");
  const full = `${dataDir}/${folder}`;
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(full);
  } catch {
    throw new Error(`Folder not found: ${folder}`);
  }
  if (!s.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  const files = await filesBeneath(full);
  if (files.length === 0) {
    await rm(full, { recursive: true });
    // Moving the last feature out leaves the folder's Automerge mirror
    // (.specdriven/automerge/<folder>) behind, empty: git mv moves the
    // documents but not their parent. It goes with the folder when nothing
    // is left in it — a document still there belongs to a feature git
    // knows nothing about, and stays.
    await rmIfEmpty(`${dataDir}/${docDirRel(folder)}`);
    return { message: "folder deleted", features: 0 };
  }
  const features = (await walk(dataDir, folder)).files.length;
  // A folder holding nothing but descriptions ("describe a folder") has no
  // feature to lose, so it needs no second confirmation — but git tracks
  // those files, so it goes the committed way, not off the disk alone.
  const onlyDescriptions = files.every((entry) => isFolderDisplayNameFile(entry.split("/").pop() ?? ""));
  if (!force && !onlyDescriptions) {
    throw new Error(`Folder is not empty: ${folder} — move its features out first`);
  }
  const docFolder = docDirRel(folder);
  const paths = [folder, ...((await isDirectory(`${dataDir}/${docFolder}`)) ? [docFolder] : [])];
  const sync = await removeAndPush(
    dataDir,
    paths,
    `Delete folder: ${folder} (${features} feature${features === 1 ? "" : "s"})`,
  );
  // git rm leaves behind what it never tracked — an empty subfolder, a
  // .DS_Store, a feature whose commit failed — and the folder with them.
  for (const p of paths) await rm(`${dataDir}/${p}`, { recursive: true, force: true });
  return { message: sync.message, features };
}

/**
 * specs/ui/folders.feature.md "rename a folder": the folder keeps its place
 * in the tree and takes a new last segment, slugified like a file stem. With
 * features beneath it the rename is a `git mv` of the whole directory —
 * their Automerge documents, which mirror the tree under
 * `.specdriven/automerge/specs/`, move in the same commit — committed and
 * pushed; every feature's url follows. An empty folder is renamed on disk
 * alone, git never having tracked it.
 */
export async function renameFolder(
  dataDir: string,
  path: string,
  name: string,
): Promise<{ path: string; message: string }> {
  const from = safeFolder(path);
  if (from === SPECS_FOLDER) throw new Error("Folder name is required");
  if (!(await isDirectory(`${dataDir}/${from}`))) throw new Error(`Folder not found: ${from}`);
  const stem = slugify(cleanLine(name).split("/").pop() ?? "");
  if (!stem) throw new Error("Folder name is required");
  const to = [...from.split("/").slice(0, -1), stem].join("/");
  if (to === from) return { path: from, message: "already named that" };
  if (await exists(`${dataDir}/${to}`)) throw new Error(`Folder already exists: ${to}`);
  if ((await filesBeneath(`${dataDir}/${from}`)).length === 0) {
    await rename(`${dataDir}/${from}`, `${dataDir}/${to}`);
    return { path: to, message: "renamed locally (git does not track an empty folder)" };
  }
  const docFrom = docDirRel(from);
  const docMoves = (await isDirectory(`${dataDir}/${docFrom}`)) ? [{ from: docFrom, to: docDirRel(to) }] : [];
  const sync = await moveAndPush(dataDir, from, to, `Rename folder: ${from} -> ${to}`, docMoves);
  return { path: to, message: sync.message };
}

/**
 * specs/ui/folders.feature.md: drag-moving a feature into a folder is a
 * `git mv` into that directory, committed and pushed like a rename. The
 * target folder must already exist; the file name itself is unchanged. An
 * empty target means the top of the spec tree — `specs/` itself.
 */
export async function moveFeature(
  dataDir: string,
  fileName: string,
  toFolder: string,
): Promise<{ fileName: string; message: string }> {
  const from = safe(fileName);
  const folder = safeFolder(toFolder);
  if (!(await isDirectory(`${dataDir}/${folder}`))) {
    throw new Error(`Folder not found: ${folder}`);
  }
  const base = from.split("/").pop()!;
  const to = `${folder}/${base}`;
  if (to === from) return { fileName: from, message: "already there" };
  if (!(await fileExists(`${dataDir}/${from}`))) {
    throw new Error(`Feature file not found: ${from}`);
  }
  if (await fileExists(`${dataDir}/${to}`)) {
    throw new Error(`Feature file already exists: ${to}`);
  }
  const sync = await moveAndPush(dataDir, from, to, `Move feature: ${from} -> ${to}`, await docMoves(dataDir, from, to));
  return { fileName: to, message: sync.message };
}

/**
 * specs/ui/ui.feature.md "Main page": the Edit link next to the feature name
 * edits the feature name — the file's `# <name>` heading — not the file name.
 * The file (and every link to it) keeps its name; the new heading is committed
 * and pushed like any other content edit.
 */
export async function renameFeature(
  dataDir: string,
  fileName: string,
  newName: string,
): Promise<{ fileName: string; name: string; message: string }> {
  const file = safe(fileName);
  const name = cleanLine(newName);
  if (!name) throw new Error("Feature name is required");
  const current = await readFeature(dataDir, file);
  if (current === null) throw new Error(`Feature file not found: ${file}`);
  const oldName = parseFeature(current).name || titleFromFileName(file);
  if (name === oldName) return { fileName: file, name, message: "feature name unchanged" };
  await writeFeatureFile(dataDir, file, renameFeatureName(current, name));
  const sync = await commitAndPush(
    dataDir,
    await featurePaths(dataDir, file),
    `Rename feature: ${oldName} -> ${name}`,
  );
  return { fileName: file, name, message: sync.message };
}

/**
 * specs/ui/ui.feature.md "Feature entry menu" (File → Rename): renames the
 * underlying file, keeping its folder and the `.feature.md` extension — the
 * UI only shows and edits the stem left of the dot. A `git mv`, committed
 * and pushed like a move; links to the old file name go stale.
 */
export async function renameFeatureFile(
  dataDir: string,
  fileName: string,
  newStem: string,
): Promise<{ fileName: string; message: string }> {
  const from = safe(fileName);
  const stem = slugify(newStem);
  if (!stem) throw new Error("File name is required");
  const folder = from.split("/").slice(0, -1).join("/");
  const to = folder ? `${folder}/${stem}.feature.md` : `${stem}.feature.md`;
  if (to === from) return { fileName: from, message: "file name unchanged" };
  if (!(await fileExists(`${dataDir}/${from}`))) {
    throw new Error(`Feature file not found: ${from}`);
  }
  if (await fileExists(`${dataDir}/${to}`)) {
    throw new Error(`Feature file already exists: ${to}`);
  }
  const sync = await moveAndPush(dataDir, from, to, `Rename file: ${from} -> ${to}`, await docMoves(dataDir, from, to));
  return { fileName: to, message: sync.message };
}

/**
 * specs/ui/ui.feature.md "Feature entry menu" (Delete): deletes the feature
 * file — a `git rm`, committed and pushed. The client asks for confirmation
 * first.
 */
export async function deleteFeature(
  dataDir: string,
  fileName: string,
): Promise<{ message: string }> {
  const file = safe(fileName);
  if (!(await fileExists(`${dataDir}/${file}`))) {
    throw new Error(`Feature file not found: ${file}`);
  }
  const sync = await removeAndPush(
    dataDir,
    await featurePaths(dataDir, file),
    `Delete feature: ${file}`,
  );
  return { message: sync.message };
}

/** The doc-directory rename that rides along when a feature file moves. */
async function docMoves(
  dataDir: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string }[]> {
  return (await hasFeatureDoc(dataDir, from))
    ? [{ from: docDirRel(from), to: docDirRel(to) }]
    : [];
}

/**
 * The editor's view of what was saved (FeatureView): the written file content
 * — chipless scenarios marked [proposed] — plus the [draft] scenarios, which
 * land in the Automerge document but never in the file, and the parsed form
 * carrying each scenario's document id.
 */
export interface SaveResult extends FeatureView {
  status: "saved";
  message: string;
}

/**
 * Scenario "Scenario is automatically saved locally and pushed to GitHub":
 * write the feature to the local filesystem right away (we don't want to lose
 * any data), marking unpublished scenarios [proposed]. Scenarios sent with an
 * explicit [draft] chip stay drafts: absorbed into the Automerge document,
 * left out of the `.feature.md`. The reload cron then commits and pushes
 * saved scenarios after its git pull.
 *
 * `scenario` is the one the editor is saving, with the document id it read it
 * under: a scenario going out under a new name or version is then a rename
 * of that entry, not a second scenario beside it
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice") — the only way a draft gets out from under its old name,
 * since a save that leaves a draft out removes nothing.
 */
export async function saveFeature(
  dataDir: string,
  fileName: string,
  content: string,
  scenario?: ScenarioTarget,
): Promise<SaveResult> {
  const name = safe(fileName);
  // A save must not mint a feature that is not there: after a git-mv the
  // editor's last PUT still names the retired path, and absorbIntoDoc would
  // create the old file and a new Automerge doc beside the moved one.
  if (!(await fileExists(`${dataDir}/${name}`))) {
    throw new Error(`Feature file not found: ${name}`);
  }
  let proposed = markProposed(content);
  assertFeatureText(name, proposed);
  proposed = await foldDiskEdit(dataDir, name, proposed);
  await assertPublishedUnchanged(dataDir, name, proposed);
  const written = await writeFeatureFile(dataDir, name, proposed, scenario);
  // Hand the drafts (and the ids) back with the file content, or the client
  // would see the scenario it just saved vanish.
  return { status: "saved", ...(await featureView(dataDir, name, written)), message: "saved locally" };
}

/**
 * Fold an edit made to the `.feature.md` on disk — by hand, by an agent, by a
 * git checkout — that the reload cron has not absorbed into the document yet
 * (driftSync.ts importDrift) into a save's text. The save is otherwise
 * reconciled against the document alone and its projection written over the
 * file, so a disk edit landing between two sync ticks would be silently lost.
 *
 * The merge base is the document's projection: what the file held before the
 * disk edit. A disk edit that tampers with a published scenario is not folded
 * in — the drift pass refuses it and repairs the file from the document — and
 * one that changed the same text the editor did is refused with an error
 * rather than guessed at (threeWayFeatureStrict), so nothing is dropped
 * silently either way.
 */
async function foldDiskEdit(dataDir: string, fileName: string, text: string): Promise<string> {
  const onDisk = await readFeature(dataDir, fileName);
  if (onDisk === null || featureTextError(onDisk) !== null) return text;
  const loaded = await loadFeatureDoc(dataDir, fileName);
  if (loaded === null || isProjectionOf(onDisk, loaded.doc)) return text;
  const theirs = parseFeature(onDisk);
  try {
    assertPublishedKept(loaded.doc, theirs);
  } catch {
    return text;
  }
  const merged = threeWayFeatureStrict(
    parseFeature(projectFeature(loaded.doc)),
    parseFeature(text),
    theirs,
  );
  if (!merged.ok) {
    throw new Error(
      `${fileName} was edited on disk and here at the same time (${merged.conflict}) — ` +
        `the disk edit is kept; reopen the feature to pick it up`,
    );
  }
  log.info(`folded an unsynced disk edit of ${fileName} into a save`);
  return serializeFeature(merged.feature);
}

/**
 * Delete a draft scenario (specs/ui/ui.feature.md "Scenario editor"): drafts
 * live in the Automerge document only, so this is a document operation rather
 * than a save of the feature without them — markdown cannot express a draft's
 * absence, and the next read would fold the draft straight back in. Local like
 * every other edit; the reload cron commits and pushes the document. The
 * result is the editor's view of the feature with the draft gone.
 */
export async function deleteDraftScenario(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget,
): Promise<SaveResult> {
  const name = safe(fileName);
  const loaded = await loadFeatureDoc(dataDir, name);
  const next = loaded === null ? null : removeDraftScenario(loaded.doc, target);
  if (loaded === null || next === null) {
    throw new Error(`Draft scenario "${target.name}" @v${target.version} not found`);
  }
  await saveFeatureDoc(dataDir, name, next, loaded.heads);
  const content = await readFeature(dataDir, name);
  if (content === null) throw new Error(`Feature file not found: ${name}`);
  return {
    status: "saved",
    ...(await featureView(dataDir, name, content)),
    message: "draft deleted locally",
  };
}

/**
 * Set the pull request links of the feature (`target` null) or one scenario
 * (specs/external-links/related-pull-requests.feature.md): a direct document
 * write, never a markdown one — the file's bytes stay what the document
 * projects — committed and pushed by the reload cron like any saved change.
 * A feature with no document yet gets one minted from the file first, the
 * way the first save does. Throws when the scenario is not in the document.
 */
export async function savePullRequests(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget | null,
  prs: PullRequestLink[],
): Promise<SaveResult> {
  const name = safe(fileName);
  const content = await readFeature(dataDir, name);
  if (content === null) throw new Error(`Feature file not found: ${name}`);
  let loaded = await loadFeatureDoc(dataDir, name);
  if (loaded === null) {
    await createFeatureDoc(dataDir, name, importFeatureDoc(parseFeature(content)));
    loaded = await loadFeatureDoc(dataDir, name);
    if (loaded === null) throw new Error(`Could not create a document for ${name}`);
  }
  const next = setPullRequests(loaded.doc, target, prs);
  if (next === null) {
    throw new Error(`Scenario "${target!.name}" @v${target!.version} not found`);
  }
  await saveFeatureDoc(dataDir, name, next, loaded.heads);
  return {
    status: "saved",
    ...(await featureView(dataDir, name, content)),
    message: "pull requests saved locally",
  };
}

/**
 * Record the version of the feature's Confluence page as the app just
 * published it (specs/external-links/confluence-wiki.feature.md "Changes
 * made in Confluence are not overwritten unnoticed") — a direct document
 * operation like savePullRequests, as the version is never in the markdown.
 * A feature with no document yet gets one minted from the file first.
 */
export async function saveConfluencePage(dataDir: string, fileName: string, page: ConfluencePage): Promise<FeatureView> {
  const name = safe(fileName);
  const content = await readFeature(dataDir, name);
  if (content === null) throw new Error(`Feature file not found: ${name}`);
  let loaded = await loadFeatureDoc(dataDir, name);
  if (loaded === null) {
    await createFeatureDoc(dataDir, name, importFeatureDoc(parseFeature(content)));
    loaded = await loadFeatureDoc(dataDir, name);
    if (loaded === null) throw new Error(`Could not create a document for ${name}`);
  }
  const next = setConfluencePage(loaded.doc, page);
  if (next !== loaded.doc) await saveFeatureDoc(dataDir, name, next, loaded.heads);
  return featureView(dataDir, name, content);
}

/**
 * Set the Aha! or Figma links of the feature (`target` null) or one scenario
 * (specs/external-links/aha-and-figma-links.feature.md): a direct document
 * write like savePullRequests — the links never reach the markdown —
 * committed and pushed by the reload cron. A feature with no document yet
 * gets one minted from the file first. Throws when the scenario is not in
 * the document.
 */
export async function saveResourceLinks(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget | null,
  kind: ResourceLinkKind,
  links: ResourceLink[],
): Promise<SaveResult> {
  const name = safe(fileName);
  const content = await readFeature(dataDir, name);
  if (content === null) throw new Error(`Feature file not found: ${name}`);
  let loaded = await loadFeatureDoc(dataDir, name);
  if (loaded === null) {
    await createFeatureDoc(dataDir, name, importFeatureDoc(parseFeature(content)));
    loaded = await loadFeatureDoc(dataDir, name);
    if (loaded === null) throw new Error(`Could not create a document for ${name}`);
  }
  const next = setResourceLinks(loaded.doc, target, kind, links);
  if (next === null) {
    throw new Error(`Scenario "${target!.name}" @v${target!.version} not found`);
  }
  await saveFeatureDoc(dataDir, name, next, loaded.heads);
  return {
    status: "saved",
    ...(await featureView(dataDir, name, content)),
    message: `${RESOURCE_LINK_TOOLS[kind].name} links saved locally`,
  };
}

/**
 * Set the files stored with one scenario
 * (specs/editor/store-associated-files.feature.md): a direct document write
 * like savePullRequests — the list never reaches the markdown — committed
 * and pushed by the reload cron. The bytes are already stored
 * (scenarioFiles.ts storeScenarioFile); this only says which of them the
 * scenario lists, and under what names. A feature with no document yet gets
 * one minted from the file first. Throws when the scenario is not in the
 * document.
 */
export async function saveScenarioFiles(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget,
  files: ScenarioFile[],
): Promise<SaveResult> {
  const name = safe(fileName);
  const content = await readFeature(dataDir, name);
  if (content === null) throw new Error(`Feature file not found: ${name}`);
  let loaded = await loadFeatureDoc(dataDir, name);
  if (loaded === null) {
    await createFeatureDoc(dataDir, name, importFeatureDoc(parseFeature(content)));
    loaded = await loadFeatureDoc(dataDir, name);
    if (loaded === null) throw new Error(`Could not create a document for ${name}`);
  }
  const next = setScenarioFiles(loaded.doc, target, files);
  if (next === null) {
    throw new Error(`Scenario "${target.name}" @v${target.version} not found`);
  }
  await saveFeatureDoc(dataDir, name, next, loaded.heads);
  return {
    status: "saved",
    ...(await featureView(dataDir, name, content)),
    message: "files saved locally",
  };
}

/**
 * The files one scenario of a feature lists right now, read from its
 * document — what an upload adds to or replaces in. Empty when the feature
 * has no document yet; null when the document has no such scenario.
 */
export async function readScenarioFiles(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget,
): Promise<ScenarioFile[] | null> {
  const name = safe(fileName);
  const loaded = await loadFeatureDoc(dataDir, name);
  if (loaded === null) return [];
  const entry =
    (target.id ? loaded.doc.specs.find((s) => s.id === target.id) : undefined) ??
    loaded.doc.specs.find((s) => s.name === target.name && s.version === target.version);
  if (!entry) return null;
  return (entry.files ?? []).map((f) => ({ name: f.name, file: f.file, size: f.size }));
}

/**
 * Delete a published scenario (specs/editor/spec-editor.feature.md "Delete
 * Published Spec"): the one removal a plain save must never perform —
 * published scenarios are immutable, and both immutability gates would refuse
 * it. Called only from its own route, which the user-settings switch guards;
 * the client has already shown the Danger Zone confirmation. The doc absorbs
 * the removal with `force`, the same authority a human conflict resolution
 * has, and the change is committed and pushed right away like every other
 * edit to published content.
 */
export async function deletePublishedScenario(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget,
): Promise<SaveResult> {
  const name = safe(fileName);
  const projection = await removePublished(dataDir, name, target);
  const sync = await commitAndPush(
    dataDir,
    await featurePaths(dataDir, name),
    `Delete published scenario: ${target.name} v${target.version} (${name})`,
  );
  return {
    status: "saved",
    ...(await featureView(dataDir, name, projection)),
    message: sync.message,
  };
}

/**
 * Take a published scenario out of a feature, locally — the doc absorbing
 * the removal with `force` — and return the projection now on disk. The
 * caller commits and pushes.
 */
async function removePublished(
  dataDir: string,
  name: string,
  target: ScenarioTarget,
): Promise<string> {
  const current = await readFeature(dataDir, name);
  if (current === null) throw new Error(`Feature file not found: ${name}`);
  const feature = parseFeature(current);
  const at = feature.scenarios.findIndex(
    (s) => s.status === "published" && s.name === target.name && s.version === target.version,
  );
  if (at === -1) {
    throw new Error(`Published scenario "${target.name}" @v${target.version} not found`);
  }
  const next = serializeFeature({
    ...feature,
    scenarios: feature.scenarios.filter((_, i) => i !== at),
  });
  assertFeatureText(name, next);
  const projection = await absorbIntoDoc(dataDir, name, next, { force: true });
  await writeTextFile(`${dataDir}/${name}`, projection);
  return projection;
}

/** What moveScenario answers: the source feature's editor view, as a delete
    answers, plus where the scenario went. */
export interface MoveScenarioResult extends SaveResult {
  movedTo: string;
}

/**
 * Move a scenario to another feature (specs/ui/navigation.feature.md "move a
 * scenario to another feature"): it keeps its name, version, status, body,
 * tests, ticket and pull request links, and leaves the source the way a
 * Delete of it would. Added to the target before it is taken out of the
 * source, so a failure part way leaves it in both rather than in neither.
 *
 * Drafts and [proposed] scenarios are local writes, committed and pushed by
 * the reload cron like any save. A [published] one is published content
 * leaving its feature — the route lets it through only while Settings allows
 * deleting published scenarios — and both files are committed and pushed
 * together right away, as a Delete Published Spec is.
 */
export async function moveScenario(
  dataDir: string,
  fileName: string,
  target: ScenarioTarget,
  toFileName: string,
): Promise<MoveScenarioResult> {
  const from = safe(fileName);
  const to = safe(toFileName);
  if (from === to) throw new Error("The scenario is already in that feature");
  const source = await readFeatureView(dataDir, from);
  if (source === null) throw new Error(`Feature file not found: ${from}`);
  const same = (s: { name: string; version: number }) =>
    s.name === target.name && s.version === target.version;
  const moving = source.parsed.scenarios.find(same);
  if (!moving) throw new Error(`Scenario "${target.name}" @v${target.version} not found`);
  const dest = await readFeatureView(dataDir, to);
  if (dest === null) throw new Error(`Feature file not found: ${to}`);
  if (dest.parsed.scenarios.some(same)) {
    const destName = dest.parsed.name || titleFromFileName(to);
    throw new Error(`"${destName}" already has "${target.name}" v${target.version}`);
  }

  // Into the target, last in its order: a fresh document entry there (no id
  // — ids belong to the source's document), then its pull request, Aha! and
  // Figma links and stored files, which only the document holds.
  const { id: _id, prs, aha, figma, files, ...carried } = moving;
  await saveFeature(
    dataDir,
    to,
    serializeFeature({ ...dest.parsed, scenarios: [...dest.parsed.scenarios, carried] }),
  );
  if (prs && prs.length > 0) {
    await savePullRequests(dataDir, to, { name: moving.name, version: moving.version }, prs);
  }
  for (const [kind, links] of [
    ["aha", aha],
    ["figma", figma],
  ] as const) {
    if (links && links.length > 0) {
      await saveResourceLinks(dataDir, to, { name: moving.name, version: moving.version }, kind, links);
    }
  }
  if (files && files.length > 0) {
    await saveScenarioFiles(dataDir, to, { name: moving.name, version: moving.version }, files);
  }

  // Out of the source, by what the scenario is — as its Delete would.
  const pick = { name: moving.name, version: moving.version };
  let view: FeatureView;
  let message = "moved locally";
  if (moving.status === "draft") {
    view = await deleteDraftScenario(dataDir, from, pick);
  } else if (moving.status === "proposed") {
    view = await saveFeature(
      dataDir,
      from,
      serializeFeature({ ...source.parsed, scenarios: source.parsed.scenarios.filter((s) => !same(s)) }),
    );
  } else {
    const projection = await removePublished(dataDir, from, pick);
    const sync = await commitAndPush(
      dataDir,
      [...(await featurePaths(dataDir, from)), ...(await featurePaths(dataDir, to))],
      `Move published scenario: ${moving.name} v${moving.version} (${from} -> ${to})`,
    );
    view = await featureView(dataDir, from, projection);
    message = sync.message;
  }
  return { status: "saved", content: view.content, parsed: view.parsed, movedTo: to, message };
}

/**
 * Mark scenarios published: every scenario for a whole-feature publish, or
 * just the targeted one (crud-feature.md "publish each scenario
 * individually"). A target that isn't in the content is an error, not a no-op.
 */
function markForPublish(content: string, scenario?: ScenarioTarget): string {
  if (!scenario) return markPublished(content);
  const exists = parseFeature(content).scenarios.some(
    (s) => s.name === scenario.name && s.version === scenario.version,
  );
  if (!exists) {
    throw new Error(`Scenario "${scenario.name}" v${scenario.version} not found`);
  }
  return markScenarioPublished(content, scenario.name, scenario.version);
}

/**
 * Scenario "Publish feature": every scenario is marked [published] (published
 * scenarios are immutable — specs/ui/ui.feature.md); git pull first; on a clean
 * merge, save, then git commit and push. On a merge conflict, report both
 * sides so the user can resolve (accept yours / accept theirs / manual edit).
 * With a scenario target, only that scenario is marked [published]
 * (crud-feature.md "publish each scenario individually").
 * The target's document id, when the editor sends one, is how the dialog's
 * Publish of a retyped title publishes the draft it came from rather than a
 * second scenario beside it (saveFeature).
 */
export async function publishFeature(
  dataDir: string,
  fileName: string,
  content: string,
  scenario?: ScenarioTarget,
): Promise<PublishResult> {
  const name = safe(fileName);
  if (!(await fileExists(`${dataDir}/${name}`))) {
    throw new Error(`Feature file not found: ${name}`);
  }
  let published = markForPublish(content, scenario);
  // Checked before the pull: content we would refuse to write must not leave
  // a merge behind for the user to resolve.
  assertFeatureText(name, published);
  await assertPublishedUnchanged(dataDir, name, published);
  // The pre-pull file is the merge base for the user's buffer if the pull
  // brings a conflict this tick can auto-merge.
  const baseText = await readFeature(dataDir, name);
  const pullResult = await pull(dataDir);
  if (!pullResult.ok) {
    // A pull can fail without leaving a merge behind — no credentials, no
    // network, a missing remote. That is an error to report, not a conflict
    // to resolve: a conflict dialog here would claim the file is missing on
    // the remote when the truth is we could not reach the remote at all.
    if (pullResult.conflictedFiles.length === 0) {
      throw new Error(`Publish failed — git pull: ${pullResult.message}`);
    }
    // The merged documents (or a scenario-level three-way merge) resolve
    // what they can before a human is asked to.
    await autoResolveMergeConflicts(dataDir, pullResult.conflictedFiles);
    if (await mergeInProgress(dataDir)) {
      const theirs = (await theirsVersion(dataDir, name)) ?? "";
      return { status: "conflict", theirs, ours: published, message: pullResult.message };
    }
  }
  // The pull (clean or auto-merged) may have moved the file past the buffer's
  // base. Fold the buffer in three-way so a publish never silently reverts
  // what a peer landed in the meantime.
  const pulledText = await readFeature(dataDir, name);
  if (pulledText !== null && pulledText !== (baseText ?? "") && pulledText !== published) {
    const folded = threeWayFeature(
      parseFeature(baseText ?? ""),
      parseFeature(published),
      parseFeature(pulledText),
    );
    if (!folded.ok) {
      return { status: "conflict", theirs: pulledText, ours: published, message: folded.conflict };
    }
    published = serializeFeature(folded.feature);
  }
  await writeFeatureFile(dataDir, name, published, scenario);
  const sync = await commitAndPush(
    dataDir,
    await featurePaths(dataDir, name),
    scenario
      ? `Publish scenario: ${scenario.name} v${scenario.version} (${name})`
      : `Publish feature: ${name}`,
  );
  return { status: "published", message: sync.message };
}

/**
 * Complete a conflicted publish with the user's chosen resolution, then commit
 * and push. A scenario target scopes the marking to that scenario; if the
 * resolution dropped it (e.g. "accept theirs"), nothing is marked. Its
 * document id rides along from the publish that conflicted, so a renamed
 * scenario is still renamed by the resolution rather than doubled.
 */
export async function resolveFeatureConflict(
  dataDir: string,
  fileName: string,
  content: string,
  scenario?: ScenarioTarget,
): Promise<PublishResult> {
  const name = safe(fileName);
  const resolved = scenario
    ? markScenarioPublished(content, scenario.name, scenario.version)
    : markPublished(content);
  // A hand-edited resolution is user-typed text like any other: it goes
  // through the same check before it reaches the repo.
  assertFeatureText(name, resolved);
  // The human chose this resolution, so it overrides the doc's published
  // state (force) — the same authority a hand-edited merge has today.
  const projection = await absorbIntoDoc(dataDir, name, resolved, {
    force: true,
    scenario,
    drift: false,
  });
  const sync = await gitResolve(
    dataDir,
    name,
    projection,
    (await hasFeatureDoc(dataDir, name)) ? [docDirRel(name)] : [],
  );
  return { status: "published", message: sync.message };
}

/**
 * specs/ui/ui.feature.md: "If a scenario is already published, then it is
 * immutable." A published scenario (same name and version) must survive a
 * publish still published and with its body intact; adding a new version
 * alongside it is fine.
 */
async function assertPublishedUnchanged(dataDir: string, fileName: string, next: string) {
  const existingText = await readFeature(dataDir, fileName);
  if (existingText === null) return;
  const before = parseFeature(existingText);
  const after = parseFeature(next);
  for (const old of before.scenarios) {
    if (old.status !== "published") continue;
    const match = after.scenarios.find((s) => s.name === old.name && s.version === old.version);
    if (!match || match.status !== "published" || match.body !== old.body) {
      throw new Error(`Scenario "${old.name}" @v${old.version} is published and immutable`);
    }
  }
}

/**
 * The one door into the data repo for feature content. The text is checked
 * against the file format first, so a malformed feature — a lost `# <name>`
 * heading, junk above it, a code fence left open (parser.ts unclosedFence:
 * every scenario heading after it would be swallowed into the body above and
 * reconciled as a deletion) — is an error the user sees rather than a file
 * the next sync commits and pushes. Then the Automerge document (the system of
 * record) absorbs the edit — reconciled as CRDT operations, or imported
 * whole for a feature that predates its document — and what lands in the
 * `.feature.md` is the document's projection: parse-equal to the input,
 * canonically formatted, identical on every peer that merges the same edits.
 */
async function writeFeatureFile(
  dataDir: string,
  fileName: string,
  text: string,
  scenario?: ScenarioTarget,
): Promise<string> {
  assertFeatureText(fileName, text);
  const projection = await absorbIntoDoc(dataDir, fileName, text, { scenario });
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  return projection;
}

/**
 * Feed a feature text into its Automerge document — reconciled as CRDT
 * operations, or imported whole for a feature that predates its document —
 * and return the projection the markdown file must now hold. `force` skips
 * the published-immutability gate for an explicit human conflict resolution;
 * `scenario` carries the editor's document id for the scenario it is saving
 * (reconcile).
 *
 * The file is about to be overwritten with the projection, so an external
 * edit the sync tick has not absorbed yet (importDrift) is absorbed here
 * first and the text folded in on top of it (foldDrift) — otherwise the
 * write would drop it from the file, the document and git without a trace.
 * `drift: false` skips that for a conflict resolution, whose file holds
 * merge markers rather than anyone's edit.
 */
async function absorbIntoDoc(
  dataDir: string,
  fileName: string,
  text: string,
  {
    force = false,
    scenario,
    drift = true,
  }: { force?: boolean; scenario?: ScenarioTarget; drift?: boolean } = {},
): Promise<string> {
  return withSpan("automerge.absorb_edit", { "specdriven.file": fileName }, async (span) => {
    let feature = parseFeature(text);
    // Every write through here is the app's user's own edit, so it is theirs
    // to sign (specs/app/specs-authorship.feature.md); the drift folded in
    // below is not, and reconciles unsigned.
    const author = await currentAuthor();
    const options = await projectionFor(dataDir);
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) {
      span.setAttribute("automerge.imported", true);
      // A file already on disk without a document (written before documents
      // existed) is imported unsigned first — its scenarios were not created
      // by whoever happens to save it next — and this write reconciled on top.
      const disk = drift ? await readTextFile(`${dataDir}/${fileName}`) : null;
      if (disk === null || featureTextError(disk) !== null) {
        const fresh = importFeatureDoc(feature, author);
        assertProjection(fileName, projectFeature(fresh, options));
        const created = await createFeatureDoc(dataDir, fileName, fresh);
        return projectFeature(created.doc, options);
      }
      const imported = importFeatureDoc(parseFeature(disk));
      const next = reconcile(imported, feature, { force, scenario, author });
      assertProjection(fileName, projectFeature(next, options));
      const created = await createFeatureDoc(dataDir, fileName, next);
      return projectFeature(created.doc, options);
    }
    let doc = loaded.doc;
    const disk = drift ? await readTextFile(`${dataDir}/${fileName}`) : null;
    if (disk !== null && !isProjectionOf(disk, doc)) {
      span.setAttribute("automerge.drift_folded", true);
      ({ doc, feature } = foldDrift(fileName, doc, disk, feature));
    }
    const next = reconcile(doc, feature, { force, scenario, author });
    // Checked before the document is saved: a projection that would not read
    // back as this feature must not become the system of record either.
    const projection = projectFeature(next, options);
    assertProjection(fileName, projection);
    await saveFeatureDoc(dataDir, fileName, next, loaded.heads);
    return projection;
  });
}

/**
 * Absorb a file that drifted since the last sync tick into the document, by
 * the drift pass's own rules (absorbDrift), and fold the text being written
 * in on top of it — the backstop behind saveFeature's foldDiskEdit for every
 * write, a publish or a rename included. The rule is foldDiskEdit's: merged
 * three-way against the document as it was, and refused rather than guessed
 * at where both sides changed the same text (threeWayFeatureStrict). A text
 * that already carries the drift (foldDiskEdit ran, or it was read from the
 * drifted file) merges to itself.
 *
 * Markdown that does not parse as a feature cannot be absorbed; rather than
 * overwrite it the write is refused, so whoever is mid-edit on disk can finish.
 */
function foldDrift(
  fileName: string,
  doc: A.Doc<FeatureDoc>,
  disk: string,
  edit: Feature,
): { doc: A.Doc<FeatureDoc>; feature: Feature } {
  const problem = featureTextError(disk);
  if (problem) {
    throw new Error(`${fileName} was changed on disk and no longer parses (${problem}) — fix it before saving`);
  }
  const absorbed = absorbDrift(doc, disk);
  if (absorbed.refused !== undefined) {
    // The drift tampered with a published scenario: the document wins, as on
    // the sync tick, and the write about to happen repairs the file.
    log.warn(`refused drift on ${fileName}; repaired from its document`, errorAttributes(absorbed.refused));
    return { doc, feature: edit };
  }
  const merged = threeWayFeatureStrict(docToFeature(doc), edit, docToFeature(absorbed.doc));
  if (!merged.ok) {
    throw new Error(
      `${fileName} was edited on disk and here at the same time (${merged.conflict}) — ` +
        `the disk edit is kept; reopen the feature to pick it up`,
    );
  }
  log.info(`absorbed drifted ${fileName} into its document before writing over it`);
  return { doc: absorbed.doc, feature: merged.feature };
}

/**
 * What a mutation commits for a feature: the markdown projection plus the
 * document directory that is the system of record behind it, so a peer never
 * receives one without the other.
 */
async function featurePaths(dataDir: string, fileName: string): Promise<string[]> {
  return (await hasFeatureDoc(dataDir, fileName)) ? [fileName, docDirRel(fileName)] : [fileName];
}

function assertFeatureText(fileName: string, text: string): void {
  const problem = featureTextError(text);
  if (problem) throw new Error(`Refusing to write ${fileName} — ${problem}`);
}

/**
 * The same check on what the document projects to, run before the document
 * is saved and its projection written. The text a user sends is checked on
 * the way in (assertFeatureText), but the projection is a different text:
 * the parser's reading of it, written back. Should that reading ever open a
 * fence the input did not — as a body whose first line lost its indentation
 * once did — the file on disk would refuse every later save, and the
 * document would already hold the broken body. Neither is allowed to land.
 */
function assertProjection(fileName: string, projection: string): void {
  const problem = featureTextError(projection);
  if (problem) {
    throw new Error(`Refusing to write ${fileName} — its projection would not read back (${problem})`);
  }
}

/** Segments that would escape or hide inside the data repo are rejected. */
function badSegment(segment: string): boolean {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}

/**
 * A feature file path: `/`-separated safe segments ending in `.feature.md`,
 * under `specs/`. Requiring the prefix here is what keeps a feature from ever
 * being written outside the spec tree — every mutation funnels through this.
 */
function safe(fileName: string): string {
  const segments = fileName.split("/");
  if (
    segments.some(badSegment) ||
    !isFeatureFile(segments[segments.length - 1]!) ||
    !isSpecsFolderPath(fileName) ||
    segments.length < 2
  ) {
    throw new Error(`Invalid feature file name: ${fileName}`);
  }
  return fileName;
}

/**
 * A folder path within the spec tree, returned repo-relative. The prefix is
 * optional on the way in — `billing` and `specs/billing` are the same folder,
 * and an empty path is the top of the tree, `specs/` itself — so a caller that
 * thinks in tree-relative terms and one echoing back a listed path both work.
 */
/**
 * The files anywhere beneath a directory, relative to it, macOS `.DS_Store`
 * junk left out: what decides whether git could know the folder at all. A
 * folder with none is untracked by construction, so it can be renamed or
 * removed on disk alone; one with a display-name.txt and no feature is not.
 */
async function filesBeneath(full: string): Promise<string[]> {
  const contents = (await readdir(full, { recursive: true })) as string[];
  const files: string[] = [];
  for (const entry of contents) {
    if (entry.split("/").pop() === ".DS_Store") continue;
    if (!(await stat(`${full}/${entry}`)).isDirectory()) files.push(entry);
  }
  return files;
}

function safeFolder(path: string): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return SPECS_FOLDER;
  const segments = trimmed.split("/");
  if (segments.some(badSegment)) throw new Error(`Invalid folder path: ${path}`);
  return isSpecsFolderPath(trimmed) ? trimmed : `${SPECS_FOLDER}/${trimmed}`;
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

/** Remove a directory that holds nothing but empty directories; leave any other alone. */
async function rmIfEmpty(path: string): Promise<void> {
  if (!(await isDirectory(path))) return;
  const entries = (await readdir(path, { recursive: true })) as string[];
  for (const entry of entries) {
    if (!(await stat(`${path}/${entry}`)).isDirectory()) return;
  }
  await rm(path, { recursive: true, force: true });
}
