// Project settings live with the specs, not with the app: `project-settings
// .json` in the root of the data repo describes the project, so every
// checkout of the repo — and every teammate — sees the same thing, and
// changing it is an ordinary commit.
//
//   {
//     "members": [
//       { "name": "Ada Lovelace", "email": "ada.lovelace@acme.example" },
//       "Grace Hopper"
//     ],
//     "code-repo": "../acme-app"
//   }
//
// `members` lists the people working on the project. The editor offers those
// names in the feature's "Assigned" dropdown, and the chosen one is written
// into the `.feature.md` as its `**Assigned:**` line (src/server/parser.ts).
// A bare list of names — the whole file, or the entries inside it — reads the
// same way: a project settings file is hand-edited, so anything that clearly
// names people is accepted rather than refused.
//
// `code-repo` is where the code that implements the specs lives — the folder
// a code gen session (src/server/agent.ts) runs in, so Claude edits the code
// rather than the specs. A relative path is relative to the data repo, which
// is what a checked-in setting must be: `../acme-app` holds for every
// teammate who keeps the two repos side by side. Absent, sessions run in the
// data repo as before.
//
// `authors-in-markdown` (specs/app/specs-authorship.feature.md) says whether
// the `.feature.md` files carry who created and last updated each feature
// and scenario — `**Created by:**` / `**Updated by:**` lines. Off unless the
// file says `true`: the Automerge documents record authorship either way, so
// the switch only decides what the markdown on GitHub shows. A repo setting,
// not a device one, so every teammate's app writes the files the same way.

import { isAbsolute, resolve } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";
import { isHostedMode } from "./hostedMode";

/** The data repo's project settings file, at its root. */
export const PROJECT_SETTINGS_FILE = "project-settings.json";

export interface ProjectMember {
  /** Display name, and the identity a feature's `assigned` holds. */
  name: string;
  /** Optional — shown as the member's subtitle where there is room for it. */
  email?: string;
}

export interface ProjectSettings {
  members: ProjectMember[];
  /** Absolute path of the code repo, or null when the file names none. */
  codeRepo: string | null;
  /** Whether feature files carry authorship lines (default false). */
  authorsInMarkdown: boolean;
}

/** The settings file's key for the code repo — hyphenated, as written by hand. */
export const CODE_REPO_KEY = "code-repo";

/** One member entry, or null when it names nobody. */
function normalizeMember(value: unknown): ProjectMember | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { name } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const entry = value as { name?: unknown; email?: unknown };
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const email = typeof entry.email === "string" ? entry.email.trim() : "";
  return email ? { name, email } : { name };
}

/**
 * The member list a stored value holds: entries that name somebody, in file
 * order, with duplicate names dropped — the name is the identity a feature's
 * `assigned` refers to, so the dropdown must not offer it twice.
 */
export function normalizeMembers(value: unknown): ProjectMember[] {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray((value as { members?: unknown } | null)?.members)
      ? ((value as { members: unknown[] }).members)
      : [];
  const seen = new Set<string>();
  const members: ProjectMember[] = [];
  for (const entry of entries) {
    const member = normalizeMember(entry);
    if (!member) continue;
    const key = member.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(member);
  }
  return members;
}

/**
 * The code repo a stored value names, as an absolute path: a relative one
 * resolves against the data repo. Absent, blank or not a string is null.
 * `codeRepo` is accepted beside `code-repo`, since a hand-edited file may
 * well use either spelling.
 *
 * A hosted worker (src/server/hostedMode.ts) has no code checkout — its
 * volume holds data-repo clones alone — and a path a data repo names could
 * point into another user's folder, so there it is always null.
 */
export function normalizeCodeRepo(value: unknown, dataDir: string): string | null {
  if (isHostedMode()) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const raw = entry[CODE_REPO_KEY] ?? entry.codeRepo;
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path) return null;
  return isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
}

/** The settings file's key for authorship in the markdown. */
export const AUTHORS_IN_MARKDOWN_KEY = "authors-in-markdown";

/**
 * Whether a stored value asks for authorship in the feature files: only a
 * literal `true` (or the string "true", hand-typed) turns it on.
 * `authorsInMarkdown` is accepted beside the hyphenated key, as `codeRepo` is.
 */
export function normalizeAuthorsInMarkdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const raw = entry[AUTHORS_IN_MARKDOWN_KEY] ?? entry.authorsInMarkdown;
  return raw === true || raw === "true";
}

/** The settings a parsed file holds, with paths resolved against dataDir. */
export function normalizeProjectSettings(value: unknown, dataDir: string): ProjectSettings {
  return {
    members: normalizeMembers(value),
    codeRepo: normalizeCodeRepo(value, dataDir),
    authorsInMarkdown: normalizeAuthorsInMarkdown(value),
  };
}

const EMPTY_SETTINGS: ProjectSettings = { members: [], codeRepo: null, authorsInMarkdown: false };

/**
 * The project's settings. No file, or one that doesn't parse, is the empty
 * settings — no members, so the assignment dropdown offers nothing but
 * "Unassigned", and no code repo, so sessions run in the data repo — which
 * is what a project that never wrote the file should see.
 */
export async function readProjectSettings(dataDir: string): Promise<ProjectSettings> {
  const text = await readTextFile(`${dataDir}/${PROJECT_SETTINGS_FILE}`);
  if (text === null) return { ...EMPTY_SETTINGS };
  try {
    return normalizeProjectSettings(JSON.parse(text), dataDir);
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

/**
 * Turn `authors-in-markdown` on or off in the data repo's settings file,
 * keeping every other key as it is. A file that is missing is created; one
 * that does not parse as a JSON object is refused rather than overwritten,
 * since it is hand-edited and may hold what someone meant to fix. A bare
 * member list — the file's other accepted form — becomes `{ "members": … }`.
 * The off state is written as an absent key, the default. Local write; the
 * reload cron commits and pushes it like any saved change. Returns whether
 * the file changed.
 */
export async function writeAuthorsInMarkdown(dataDir: string, on: boolean): Promise<boolean> {
  const path = `${dataDir}/${PROJECT_SETTINGS_FILE}`;
  const text = await readTextFile(path);
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${PROJECT_SETTINGS_FILE} is not valid JSON — fix it by hand first`);
    }
    if (Array.isArray(parsed)) settings = { members: parsed };
    else if (typeof parsed === "object" && parsed !== null) settings = parsed as Record<string, unknown>;
    else throw new Error(`${PROJECT_SETTINGS_FILE} must hold a JSON object`);
  }
  if (normalizeAuthorsInMarkdown(settings) === on) return false;
  delete settings.authorsInMarkdown;
  if (on) settings[AUTHORS_IN_MARKDOWN_KEY] = true;
  else delete settings[AUTHORS_IN_MARKDOWN_KEY];
  await writeTextFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** The project's members alone — see readProjectSettings. */
export async function readProjectMembers(dataDir: string): Promise<ProjectMember[]> {
  return (await readProjectSettings(dataDir)).members;
}
