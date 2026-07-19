import { readdir } from "node:fs/promises";
import {
  pull,
  theirsVersion,
  commitAndPush,
  moveAndPush,
  resolveConflict as gitResolve,
} from "./git";
import { parseFeature, markPublished, markSaved, slugify, titleFromFileName } from "./parser";

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
  fileName: string;
  /** Display name: the file's `# <name>` heading, or derived from the stem. */
  name: string;
}

/**
 * specs/ui.spec.md "Main page": the sidebar shows feature names, not file
 * names — each listed file carries its display name.
 */
export async function listFeatures(dataDir: string): Promise<FeatureListing[]> {
  let entries: string[];
  try {
    entries = (await readdir(dataDir)).filter(isFeatureFile).sort();
  } catch {
    return [];
  }
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

export async function readFeature(dataDir: string, fileName: string): Promise<string | null> {
  const file = Bun.file(`${dataDir}/${safe(fileName)}`);
  return (await file.exists()) ? file.text() : null;
}

/** Scenario "create new feature": creates a new feature file in the local filesystem. */
export async function createFeature(dataDir: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Feature name is required");
  const fileName = `${slugify(trimmed)}.feature.md`;
  const path = `${dataDir}/${fileName}`;
  if (await Bun.file(path).exists()) {
    throw new Error(`Feature file already exists: ${fileName}`);
  }
  await Bun.write(path, `# ${trimmed}\n`);
  await commitAndPush(dataDir, fileName, `Create feature: ${trimmed}`);
  return fileName;
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
  const slug = slugify(newFileName.trim().replace(/\.feature\.md$|\.feature$|\.md$/, ""));
  if (!slug) throw new Error("Feature file name is required");
  const to = `${slug}.feature.md`;
  if (to === from) return { fileName: from, message: "file name unchanged" };
  if (!(await Bun.file(`${dataDir}/${from}`).exists())) {
    throw new Error(`Feature file not found: ${from}`);
  }
  if (await Bun.file(`${dataDir}/${to}`).exists()) {
    throw new Error(`Feature file already exists: ${to}`);
  }
  const sync = await moveAndPush(dataDir, from, to, `Rename feature: ${from} -> ${to}`);
  return { fileName: to, message: sync.message };
}

export interface SaveResult {
  status: "saved";
  /** The content as written, with unpublished scenarios marked [saved]. */
  content: string;
  message: string;
}

/**
 * Scenario "Scenario is automatically saved locally and pushed to GitHub":
 * write the feature to the local filesystem right away (we don't want to lose
 * any data), marking unpublished scenarios [saved]. The reload cron then
 * commits and pushes saved scenarios after its git pull.
 */
export async function saveFeature(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<SaveResult> {
  const name = safe(fileName);
  const saved = markSaved(content);
  await assertPublishedUnchanged(dataDir, name, saved);
  await Bun.write(`${dataDir}/${name}`, saved);
  return { status: "saved", content: saved, message: "saved locally" };
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

function safe(fileName: string): string {
  if (fileName.includes("/") || fileName.includes("..") || !isFeatureFile(fileName)) {
    throw new Error(`Invalid feature file name: ${fileName}`);
  }
  return fileName;
}
