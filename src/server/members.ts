// Project settings live with the specs, not with the app: `project-settings
// .json` in the root of the data repo describes the project, so every
// checkout of the repo — and every teammate — sees the same thing, and
// changing it is an ordinary commit. The app makes the file for every data
// folder it opens (ensureProjectSettings, from the reload tick), and the
// Project settings page (src/frontend/ProjectSettingsPage.tsx) edits it.
//
//   {
//     "members": [
//       { "name": "Ada Lovelace", "email": "ada.lovelace@acme.example" },
//       "Grace Hopper"
//     ],
//     "code-repos": ["../acme-app", "../acme-mobile"],
//     "default-code-repo": "../acme-app"
//   }
//
// `members` lists the people working on the project. The editor offers those
// names in the feature's "Assigned" dropdown, and the chosen one is written
// into the `.feature.md` as its `**Assigned:**` line (src/server/parser.ts).
// A bare list of names — the whole file, or the entries inside it — reads the
// same way: a project settings file is hand-edited, so anything that clearly
// names people is accepted rather than refused.
//
// `code-repos` lists where the code that implements the specs lives — none,
// one or several. The default one (`default-code-repo`, else the first) is
// the folder a code gen session (src/server/agent.ts) runs in, so Claude
// edits the code rather than the specs, the repo whose GitHub issues the
// Issues tab shows, and where test links resolve. A relative path is
// relative to the data repo, which is what a checked-in setting must be:
// `../acme-app` holds for every teammate who keeps the two repos side by
// side — the layout the app assumes. Absent, sessions run in the data repo
// as before. The older single `code-repo` key still reads as a list of one,
// and the first save through the app rewrites it as `code-repos`.
//
// `authors-in-markdown` (specs/app/specs-authorship.feature.md) says whether
// the `.feature.md` files carry who created and last updated each feature
// and scenario — `**Created by:**` / `**Updated by:**` lines. Off unless the
// file says `true`: the Automerge documents record authorship either way, so
// the switch only decides what the markdown on GitHub shows. A repo setting,
// not a device one, so every teammate's app writes the files the same way.

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

/** One code repository the settings name. */
export interface CodeRepoEntry {
  /** The path as the file holds it — relative to the data repo, usually. */
  path: string;
  /** The same, absolute. */
  dir: string;
  /** Whether this is the default repo (the one single-repo features use). */
  isDefault: boolean;
}

export interface ProjectSettings {
  members: ProjectMember[];
  /** The code repos, in file order; the default one is marked. */
  codeRepos: CodeRepoEntry[];
  /** The default repo's stored path, or null when the file names none. */
  defaultCodeRepo: string | null;
  /** Absolute path of the default code repo, or null when the file names none. */
  codeRepo: string | null;
  /** Whether feature files carry authorship lines (default false). */
  authorsInMarkdown: boolean;
}

/** The settings file's key for the code repos — hyphenated, as written by hand. */
export const CODE_REPOS_KEY = "code-repos";
/** The key naming which of the code repos is the default. */
export const DEFAULT_CODE_REPO_KEY = "default-code-repo";
/** The older key for a single code repo, still read. */
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

/** A stored code repo path as an absolute one: relative resolves against the data repo. */
export function resolveCodeRepo(path: string, dataDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
}

/**
 * The code repos a stored value names, as written and resolved, with the
 * default marked. `code-repos` is a list of paths; absent, the older single
 * `code-repo` string is a list of one. Blank or non-string entries are
 * skipped, and a path named twice (however spelled) counts once. The default
 * is the entry `default-code-repo` names — by its stored path or its
 * resolved folder — else the first. The camelCase spellings are accepted
 * beside the hyphenated keys, since a hand-edited file may well use either.
 *
 * A hosted worker (src/server/hostedMode.ts) has no code checkout — its
 * volume holds data-repo clones alone — and a path a data repo names could
 * point into another user's folder, so there the list is always empty.
 */
export function normalizeCodeRepos(value: unknown, dataDir: string): CodeRepoEntry[] {
  if (isHostedMode()) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const entry = value as Record<string, unknown>;
  const listed = entry[CODE_REPOS_KEY] ?? entry.codeRepos;
  const single = entry[CODE_REPO_KEY] ?? entry.codeRepo;
  const raw: unknown[] = Array.isArray(listed) ? listed : typeof single === "string" ? [single] : [];
  const seen = new Set<string>();
  const repos: CodeRepoEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path) continue;
    const dir = resolveCodeRepo(path, dataDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    repos.push({ path, dir, isDefault: false });
  }
  if (repos.length === 0) return repos;
  const wanted = entry[DEFAULT_CODE_REPO_KEY] ?? entry.defaultCodeRepo;
  const wantedPath = typeof wanted === "string" ? wanted.trim() : "";
  const wantedDir = wantedPath ? resolveCodeRepo(wantedPath, dataDir) : "";
  const found = wantedPath ? repos.find((r) => r.path === wantedPath || r.dir === wantedDir) : undefined;
  (found ?? repos[0]!).isDefault = true;
  return repos;
}

/**
 * The default code repo a stored value names, as an absolute path — see
 * normalizeCodeRepos. Null when the file names none.
 */
export function normalizeCodeRepo(value: unknown, dataDir: string): string | null {
  return normalizeCodeRepos(value, dataDir).find((r) => r.isDefault)?.dir ?? null;
}

/** The settings file's key for authorship in the markdown. */
export const AUTHORS_IN_MARKDOWN_KEY = "authors-in-markdown";

/**
 * Whether a stored value asks for authorship in the feature files: only a
 * literal `true` (or the string "true", hand-typed) turns it on.
 * `authorsInMarkdown` is accepted beside the hyphenated key, as `codeRepos` is.
 */
export function normalizeAuthorsInMarkdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const raw = entry[AUTHORS_IN_MARKDOWN_KEY] ?? entry.authorsInMarkdown;
  return raw === true || raw === "true";
}

/** The settings a parsed file holds, with paths resolved against dataDir. */
export function normalizeProjectSettings(value: unknown, dataDir: string): ProjectSettings {
  const codeRepos = normalizeCodeRepos(value, dataDir);
  const main = codeRepos.find((r) => r.isDefault) ?? null;
  return {
    members: normalizeMembers(value),
    codeRepos,
    defaultCodeRepo: main?.path ?? null,
    codeRepo: main?.dir ?? null,
    authorsInMarkdown: normalizeAuthorsInMarkdown(value),
  };
}

const EMPTY_SETTINGS: ProjectSettings = {
  members: [],
  codeRepos: [],
  defaultCodeRepo: null,
  codeRepo: null,
  authorsInMarkdown: false,
};

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

/** What a data folder's settings file starts as — nobody listed, no code repo. */
const INITIAL_SETTINGS = { members: [], [CODE_REPOS_KEY]: [] };

/**
 * Make the data folder's settings file when it has none (specs/app/
 * project-settings.feature.md "The settings file is created for every data
 * folder"): the empty settings, for the Project settings page to fill in. A
 * file that is there is left alone whatever it holds — even one that does
 * not parse, which is someone's to fix by hand. Returns whether it was made.
 */
export async function ensureProjectSettings(dataDir: string): Promise<boolean> {
  const path = `${dataDir}/${PROJECT_SETTINGS_FILE}`;
  if ((await readTextFile(path)) !== null) return false;
  await writeTextFile(path, `${JSON.stringify(INITIAL_SETTINGS, null, 2)}\n`);
  return true;
}

/**
 * Change the data repo's settings file in place, keeping every key the
 * mutation leaves alone. A file that is missing is created; one that does
 * not parse as a JSON object is refused rather than overwritten, since it is
 * hand-edited and may hold what someone meant to fix. A bare member list —
 * the file's other accepted form — becomes `{ "members": … }`. Local write;
 * the reload cron commits and pushes it like any saved change. Returns
 * whether the file changed.
 */
export async function updateProjectSettings(
  dataDir: string,
  mutate: (settings: Record<string, unknown>) => void,
): Promise<boolean> {
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
  const before = JSON.stringify(settings);
  mutate(settings);
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (JSON.stringify(settings) === before) return false;
  await writeTextFile(path, after);
  return true;
}

/**
 * Turn `authors-in-markdown` on or off in the data repo's settings file,
 * keeping every other key as it is. The off state is written as an absent
 * key, the default. Returns whether the file changed.
 */
export async function writeAuthorsInMarkdown(dataDir: string, on: boolean): Promise<boolean> {
  return updateProjectSettings(dataDir, (settings) => {
    if (normalizeAuthorsInMarkdown(settings) === on) return;
    delete settings.authorsInMarkdown;
    if (on) settings[AUTHORS_IN_MARKDOWN_KEY] = true;
    else delete settings[AUTHORS_IN_MARKDOWN_KEY];
  });
}

/**
 * A code repo path as the file should hold it: a folder beside the data
 * repo — or anywhere under its parent — is stored relative (`../acme-app`),
 * so the checked-in setting holds for every teammate with the same layout;
 * anything else stays as given. A relative path is kept as typed.
 */
export function storedCodeRepoPath(path: string, dataDir: string): string {
  const clean = path.trim();
  if (!isAbsolute(clean)) return clean;
  const parent = dirname(resolve(dataDir));
  const rel = relative(parent, resolve(clean));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return resolve(clean);
  return `../${rel.split(sep).join("/")}`;
}

/**
 * Write the code repos — `code-repos`, and `default-code-repo` when the
 * default is not the first — dropping the older single `code-repo` key, which
 * the list replaces. Paths are stored as storedCodeRepoPath makes them, with
 * duplicates dropped; the default must be one of them (by stored path or
 * resolved folder), else it is the first. Returns whether the file changed.
 */
export async function writeCodeRepos(
  dataDir: string,
  paths: readonly string[],
  defaultPath: string | null,
): Promise<boolean> {
  const seen = new Set<string>();
  const stored: string[] = [];
  for (const raw of paths) {
    const path = storedCodeRepoPath(raw, dataDir);
    if (!path) continue;
    const dir = resolveCodeRepo(path, dataDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    stored.push(path);
  }
  const wanted = defaultPath ? storedCodeRepoPath(defaultPath, dataDir) : "";
  const wantedDir = wanted ? resolveCodeRepo(wanted, dataDir) : "";
  const main = stored.find((p) => p === wanted || resolveCodeRepo(p, dataDir) === wantedDir);
  return updateProjectSettings(dataDir, (settings) => {
    delete settings[CODE_REPO_KEY];
    delete settings.codeRepo;
    delete settings.codeRepos;
    delete settings.defaultCodeRepo;
    settings[CODE_REPOS_KEY] = stored;
    if (main && main !== stored[0]) settings[DEFAULT_CODE_REPO_KEY] = main;
    else delete settings[DEFAULT_CODE_REPO_KEY];
  });
}

/**
 * Write the member list as `{ "name", "email"? }` objects, in the given
 * order with duplicates dropped (normalizeMembers). Returns whether the file
 * changed.
 */
export async function writeMembers(dataDir: string, members: readonly unknown[]): Promise<boolean> {
  const clean = normalizeMembers([...members]);
  return updateProjectSettings(dataDir, (settings) => {
    settings.members = clean;
  });
}

/** The project's members alone — see readProjectSettings. */
export async function readProjectMembers(dataDir: string): Promise<ProjectMember[]> {
  return (await readProjectSettings(dataDir)).members;
}
