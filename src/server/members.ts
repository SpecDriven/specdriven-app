// Project members live with the specs, not with the app: `project-settings.json`
// in the root of the data repo lists the people working on the project, so
// every checkout of the repo — and every teammate — sees the same list, and
// changing it is an ordinary commit. The editor offers those names in the
// feature's "Assigned" dropdown, and the chosen one is written into the
// `.feature.md` as its `**Assigned:**` line (src/server/parser.ts).
//
//   {
//     "members": [
//       { "name": "Ada Lovelace", "email": "ada.lovelace@acme.example" },
//       "Grace Hopper"
//     ]
//   }
//
// A bare list of names — the whole file, or the entries inside it — reads the
// same way: a project settings file is hand-edited, so anything that clearly
// names people is accepted rather than refused.

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
}

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
 * The project's members. No file, or one that doesn't parse, is an empty
 * list — the assignment dropdown then offers nothing but "Unassigned", which
 * is what a project that never listed its members should see.
 */
export async function readProjectMembers(dataDir: string): Promise<ProjectMember[]> {
  const text = await readTextFile(`${dataDir}/${PROJECT_SETTINGS_FILE}`);
  if (text === null) return [];
  try {
    return normalizeMembers(JSON.parse(text));
  } catch {
    return [];
  }
}
