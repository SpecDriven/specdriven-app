// The code repo's `specs` entry (specs/app/project-settings.feature.md "A
// code repo's specs symlink is created and removed from the editor"): a
// symlink at the root of a code checkout pointing at the data repo's spec
// tree, so the code sees the specs it implements at a fixed place — the
// layout the app's own checkout uses. The Project settings page shows, for
// each code repo, whether the link is there, and makes or removes it.
//
// The link is relative (`../acme-specs/specs`), so it holds for every
// teammate who keeps the two repos side by side — the layout the app
// assumes. Only a symlink is ever removed: a real `specs` folder in a code
// repo is someone's work, and the page says so instead of offering to touch it.

import { lstat, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { SPECS_FOLDER } from "./walk";
import { directoryExists } from "./fsx";

export type SpecsLinkState =
  /** Nothing at `<code repo>/specs` — the link can be made. */
  | "missing"
  /** A symlink that resolves to this data repo's spec tree. */
  | "linked"
  /** A symlink to somewhere else — removable, then makeable. */
  | "elsewhere"
  /** A real file or folder — left alone. */
  | "folder";

export interface SpecsLinkStatus {
  state: SpecsLinkState;
  /** What a symlink points at, as written, for the two symlink states. */
  target?: string;
}

/** A refusal worded for the user, with the HTTP status the route answers. */
export class SpecsLinkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

/** Where the link sits in a code repo. */
export function specsLinkPath(codeRepoDir: string): string {
  return resolve(codeRepoDir, SPECS_FOLDER);
}

/** The data repo's spec tree, where the link points. */
function specsDir(dataDir: string): string {
  return resolve(dataDir, SPECS_FOLDER);
}

/** The state of `<code repo>/specs` with respect to this data repo. */
export async function specsLinkStatus(codeRepoDir: string, dataDir: string): Promise<SpecsLinkStatus> {
  const path = specsLinkPath(codeRepoDir);
  const stat = await lstat(path).catch(() => null);
  if (stat === null) return { state: "missing" };
  if (!stat.isSymbolicLink()) return { state: "folder" };
  const target = await readlink(path).catch(() => "");
  const [here, wanted] = await Promise.all([
    realpath(path).catch(() => null),
    realpath(specsDir(dataDir)).catch(() => null),
  ]);
  return { state: here !== null && here === wanted ? "linked" : "elsewhere", target };
}

/**
 * Make `<code repo>/specs` a symlink to the data repo's spec tree — relative
 * where the platform can follow one, a junction with the absolute target on
 * Windows, where a directory symlink needs a privilege a junction does not.
 * Refused when the code repo is not there or anything already sits at the
 * path: the page offers Remove for a stray symlink first.
 */
export async function createSpecsLink(codeRepoDir: string, dataDir: string): Promise<SpecsLinkStatus> {
  if (!(await directoryExists(codeRepoDir))) {
    throw new SpecsLinkError(`Code repo not found: ${codeRepoDir}`, 400);
  }
  const path = specsLinkPath(codeRepoDir);
  const current = await specsLinkStatus(codeRepoDir, dataDir);
  if (current.state !== "missing") {
    throw new SpecsLinkError(
      current.state === "folder"
        ? `${path} already exists and is not a symlink`
        : `${path} is already a symlink to ${current.target}`,
      409,
    );
  }
  const target = specsDir(dataDir);
  if (process.platform === "win32") {
    await symlink(target, path, "junction");
  } else {
    await symlink(relative(resolve(codeRepoDir), target).split(sep).join("/"), path, "dir");
  }
  return specsLinkStatus(codeRepoDir, dataDir);
}

/**
 * Remove the `specs` symlink from a code repo — the link alone, never a real
 * folder of that name, which is refused.
 */
export async function removeSpecsLink(codeRepoDir: string, dataDir: string): Promise<SpecsLinkStatus> {
  const path = specsLinkPath(codeRepoDir);
  const current = await specsLinkStatus(codeRepoDir, dataDir);
  if (current.state === "missing") return current;
  if (current.state === "folder") {
    throw new SpecsLinkError(`${path} is not a symlink — a real folder is left as it is`, 409);
  }
  await unlink(path);
  return specsLinkStatus(codeRepoDir, dataDir);
}
