import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { SPECS_FOLDER, isFeatureFile, isSpecsFolderPath, walk } from "./walk";
import { autoResolveMergeConflicts, mergeInProgress } from "./automerge/driftSync";
import { threeWayFeature } from "./automerge/merge";
import { docToFeature, isProjectionOf, projectFeature } from "./automerge/project";
import { importFeatureDoc, reconcile, removeDraftScenario } from "./automerge/reconcile";
import {
  createFeatureDoc,
  docDirRel,
  hasFeatureDoc,
  listFeatureDocs,
  loadFeatureDoc,
  saveFeatureDoc,
} from "./automerge/store";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { getLogger, withSpan } from "./telemetry";
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
  sortScenarios,
  renameFeatureName,
  slugify,
  titleFromFileName,
} from "./parser";
import type { Feature, ScenarioPick, ScenarioStatus, ScenarioTarget } from "./parser";

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
 * shape as ensurePageFolder / ensureModelsFolder, but unconditional: `specs/`
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
      (specs/agents/claude.spec.md) and the sidebar's publish rollup
      (specs/ui/ui.feature.md "Design system"). */
  scenarios: (ScenarioPick & { status: ScenarioStatus })[];
  /** The project member the feature is assigned to, for the sidebar filter. */
  assigned?: string;
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
      let assigned: string | undefined;
      let scenarios: FeatureListing["scenarios"] = [];
      try {
        const parsed = parseFeature(await readFile(`${dataDir}/${fileName}`, "utf8"));
        name = parsed.name;
        assigned = parsed.assigned;
        scenarios = parsed.scenarios.map(({ name, version, status }) => ({
          name,
          version,
          status,
        }));
      } catch {
        // unreadable (e.g. deleted mid-listing): fall back to the stem
      }
      return {
        fileName,
        name: name || titleFromFileName(fileName),
        scenarios,
        ...(assigned ? { assigned } : {}),
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

export async function readFeature(dataDir: string, fileName: string): Promise<string | null> {
  return readTextFile(`${dataDir}/${safe(fileName)}`);
}

/**
 * The feature as the editor should see it: the `.feature.md` content plus
 * what lives only in the Automerge document — the draft scenarios
 * (specs/automerge-store.spec.md "draft scenarios live in the document
 * only"), serialized with explicit [draft] chips so a later save keeps them
 * drafts, and the external links the projection leaves out while "Publish
 * external links" is off (specs/external-links/project-management-jira-
 * linear-etc.feature.md) — and the same thing parsed, each scenario carrying
 * the document's id for it (`Scenario.id`), which the markdown never does.
 * The file stays the source for everything it holds — the document only
 * contributes what the file cannot see.
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

/**
 * Fold the document's drafts, its ids, and the external links the file
 * doesn't carry, into a feature text for the editor.
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
  const have = new Set(feature.scenarios.map(key));
  const drafts = loaded.doc.specs
    .filter((s) => s.status === "draft" && !have.has(key(s)))
    .map((s) => {
      const link = docLinks.get(key(s));
      return {
        id: s.id,
        name: s.name,
        version: s.version,
        status: s.status,
        body: s.body,
        tests: [...s.tests],
        ...(link ? { link } : {}),
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
    return {
      ...s,
      ...(id === undefined ? {} : { id }),
      ...(link ? { link } : {}),
    };
  });
  const link = feature.link ?? inDoc.link;
  if (link && !feature.link) linked++;
  const parsed: Feature = {
    ...feature,
    ...(link ? { link } : {}),
    scenarios: sortScenarios([...scenarios, ...drafts]),
  };
  return {
    content: drafts.length === 0 && linked === 0 ? content : serializeFeature(parsed),
    parsed,
  };
}

/**
 * Rewrite every feature file to its document's current projection — what
 * the "Publish external links" switch does on the spot, so toggling it puts
 * the links into (or takes them out of) every `.feature.md` at once rather
 * than one file at a time as they happen to be edited. Local writes; the
 * reload cron commits and pushes them like any saved change. Returns how
 * many files changed.
 */
export async function reprojectFeatures(dataDir: string): Promise<number> {
  let changed = 0;
  for (const fileName of await listFeatureDocs(dataDir)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null) continue;
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) continue;
    const projection = projectFeature(loaded.doc);
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
 * slice's scaffold (src/server/eventModel/feature.ts), whose heading is
 * the name.
 *
 * The name is relative to the spec tree: a leading `specs/` is accepted (the
 * client lists folders with it) but never doubled.
 */
export async function createFeature(dataDir: string, name: string, text?: string): Promise<string> {
  const segments = name.split("/").map((s) => s.trim());
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
  await commitAndPush(dataDir, await featurePaths(dataDir, fileName), `Create feature: ${featureName}`);
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
 * specs/ui/folders.feature.md: only an empty folder can be deleted — one with
 * no files anywhere beneath it (macOS `.DS_Store` junk doesn't count). This
 * keeps folder deletion non-destructive: features must be moved out first.
 * Empty directories are untracked by git, so removal is a local fs operation.
 * The spec tree's own root is not a folder anyone may delete.
 */
export async function deleteFolder(dataDir: string, path: string): Promise<void> {
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
 * specs/ui.spec.md "Main page": the Edit link next to the feature name edits
 * the feature name — the file's `# <name>` heading — not the file name. The
 * file (and every link to it) keeps its name; the new heading is committed
 * and pushed like any other content edit.
 */
export async function renameFeature(
  dataDir: string,
  fileName: string,
  newName: string,
): Promise<{ fileName: string; name: string; message: string }> {
  const file = safe(fileName);
  const name = newName.trim();
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
 * specs/ui.spec.md "Feature entry menu" (File → Rename): renames the
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
 * specs/ui.spec.md "Feature entry menu" (Delete): deletes the feature file —
 * a `git rm`, committed and pushed. The client asks for confirmation first.
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
 * (specs/editor-autosave.feature.md "Autosave Never Adds the Same Scenario
 * Twice") — the only way a draft gets out from under its old name, since a
 * save that leaves a draft out removes nothing.
 */
export async function saveFeature(
  dataDir: string,
  fileName: string,
  content: string,
  scenario?: ScenarioTarget,
): Promise<SaveResult> {
  const name = safe(fileName);
  const proposed = markProposed(content);
  assertFeatureText(name, proposed);
  await assertPublishedUnchanged(dataDir, name, proposed);
  const written = await writeFeatureFile(dataDir, name, proposed, scenario);
  // Hand the drafts (and the ids) back with the file content, or the client
  // would see the scenario it just saved vanish.
  return { status: "saved", ...(await featureView(dataDir, name, written)), message: "saved locally" };
}

/**
 * Delete a draft scenario (specs/ui.spec.md "Scenario editor"): drafts
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
 * Mark scenarios published: every scenario for a whole-feature publish, or
 * just the targeted one (specs/crud-feature.spec.md "publish each scenario
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
 * scenarios are immutable — specs/ui.spec.md); git pull first; on a clean
 * merge, save, then git commit and push. On a merge conflict, report both
 * sides so the user can resolve (accept yours / accept theirs / manual edit).
 * With a scenario target, only that scenario is marked [published]
 * (specs/crud-feature.spec.md "publish each scenario individually").
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
  const projection = await absorbIntoDoc(dataDir, name, resolved, { force: true, scenario });
  const sync = await gitResolve(
    dataDir,
    name,
    projection,
    (await hasFeatureDoc(dataDir, name)) ? [docDirRel(name)] : [],
  );
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
    if (old.status !== "published") continue;
    const match = after.scenarios.find((s) => s.name === old.name && s.version === old.version);
    if (!match || match.body !== old.body) {
      throw new Error(`Scenario "${old.name}" @v${old.version} is published and immutable`);
    }
  }
}

/**
 * The one door into the data repo for feature content. The text is checked
 * against the file format first, so a malformed feature — a lost `# <name>`
 * heading, junk above it — is an error the user sees rather than a file the
 * next sync commits and pushes. Then the Automerge document (the system of
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
 */
async function absorbIntoDoc(
  dataDir: string,
  fileName: string,
  text: string,
  { force = false, scenario }: { force?: boolean; scenario?: ScenarioTarget } = {},
): Promise<string> {
  return withSpan("automerge.absorb_edit", { "specdriven.file": fileName }, async (span) => {
    const feature = parseFeature(text);
    const loaded = await loadFeatureDoc(dataDir, fileName);
    if (loaded === null) {
      span.setAttribute("automerge.imported", true);
      const created = await createFeatureDoc(dataDir, fileName, importFeatureDoc(feature));
      return projectFeature(created.doc);
    }
    const next = reconcile(loaded.doc, feature, { force, scenario });
    await saveFeatureDoc(dataDir, fileName, next, loaded.heads);
    return projectFeature(next);
  });
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
function safeFolder(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
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
