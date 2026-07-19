import { readdir } from "node:fs/promises";
import { pull, theirsVersion, commitAndPush, resolveConflict as gitResolve } from "./git";
import { parseFeature, markPublished, markSaved } from "./parser";

export interface PublishResult {
  status: "published" | "conflict";
  /** On conflict: the remote side of the merge for this file. */
  theirs?: string;
  /** On conflict: the content the user tried to publish. */
  ours?: string;
  message: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFeatureFile(fileName: string): boolean {
  return fileName.endsWith(".feature.md");
}

export async function listFeatures(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(dataDir);
    return entries.filter(isFeatureFile).sort();
  } catch {
    return [];
  }
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
