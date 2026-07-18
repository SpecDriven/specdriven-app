import { readdir } from "node:fs/promises";
import { pull, theirsVersion, commitAndPush, resolveConflict as gitResolve } from "./git";

export interface SaveResult {
  status: "saved" | "conflict";
  /** On conflict: the remote side of the merge for this file. */
  theirs?: string;
  /** On conflict: the content the user tried to save. */
  ours?: string;
  message: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function listFeatures(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(dataDir);
    return entries.filter((f) => f.endsWith(".feature")).sort();
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
  const fileName = `${slugify(trimmed)}.feature`;
  const path = `${dataDir}/${fileName}`;
  if (await Bun.file(path).exists()) {
    throw new Error(`Feature file already exists: ${fileName}`);
  }
  await Bun.write(path, `Feature: ${trimmed}\n`);
  await commitAndPush(dataDir, fileName, `Create feature: ${trimmed}`);
  return fileName;
}

/**
 * Scenario "save feature": git pull first; on a clean merge, save, then
 * git commit and push. On a merge conflict, report both sides so the user
 * can resolve (accept yours / accept theirs / manual edit).
 */
export async function saveFeature(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<SaveResult> {
  const name = safe(fileName);
  const pullResult = await pull(dataDir);
  if (!pullResult.ok) {
    const theirs = (await theirsVersion(dataDir, name)) ?? "";
    return { status: "conflict", theirs, ours: content, message: pullResult.message };
  }
  await Bun.write(`${dataDir}/${name}`, content);
  const sync = await commitAndPush(dataDir, name, `Update feature: ${name}`);
  return { status: "saved", message: sync.message };
}

/** Complete a conflicted save with the user's chosen resolution, then commit and push. */
export async function resolveFeatureConflict(
  dataDir: string,
  fileName: string,
  content: string,
): Promise<SaveResult> {
  const sync = await gitResolve(dataDir, safe(fileName), content);
  return { status: "saved", message: sync.message };
}

function safe(fileName: string): string {
  if (fileName.includes("/") || fileName.includes("..") || !fileName.endsWith(".feature")) {
    throw new Error(`Invalid feature file name: ${fileName}`);
  }
  return fileName;
}
