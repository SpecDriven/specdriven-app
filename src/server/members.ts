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

import { isAbsolute, resolve } from "node:path";
import { readTextFile } from "./fsx";

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
 */
export function normalizeCodeRepo(value: unknown, dataDir: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const raw = entry[CODE_REPO_KEY] ?? entry.codeRepo;
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path) return null;
  return isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
}

/** The settings a parsed file holds, with paths resolved against dataDir. */
export function normalizeProjectSettings(value: unknown, dataDir: string): ProjectSettings {
  return { members: normalizeMembers(value), codeRepo: normalizeCodeRepo(value, dataDir) };
}

/**
 * The project's settings. No file, or one that doesn't parse, is the empty
 * settings — no members, so the assignment dropdown offers nothing but
 * "Unassigned", and no code repo, so sessions run in the data repo — which
 * is what a project that never wrote the file should see.
 */
export async function readProjectSettings(dataDir: string): Promise<ProjectSettings> {
  const text = await readTextFile(`${dataDir}/${PROJECT_SETTINGS_FILE}`);
  if (text === null) return { members: [], codeRepo: null };
  try {
    return normalizeProjectSettings(JSON.parse(text), dataDir);
  } catch {
    return { members: [], codeRepo: null };
  }
}

/** The project's members alone — see readProjectSettings. */
export async function readProjectMembers(dataDir: string): Promise<ProjectMember[]> {
  return (await readProjectSettings(dataDir)).members;
}
