// What an auto-save commit says (specs/ui/ui.feature.md "Auto-save commits
// say what changed"). The reload tick commits whatever the working tree
// holds — one notebook entry, a couple of features, now and then a batch —
// and a fixed "Auto-save scenarios" told the log nothing. This module turns
// the changed files into a title that names the feature or page and the
// scenarios behind the change, with one body line per file so a batch stays
// readable. Pure: it is handed each file's content before and after, and
// touches neither git nor the disk, so cli.ts stays the only place that
// runs git and the summary is tested on text alone.

import { STATE_DIR } from "../state";
import { parseFeature, parsePage, titleFromFileName } from "../parser";
import type { Feature, Scenario } from "../parser";
import { PAGE_FOLDERS, isPageFile } from "../pageFolders";
import { isFeatureFile, isFolderDisplayNameFile } from "../walk";

/** One file the working tree holds differently from HEAD. */
export interface ChangedFile {
  /** Repo-relative path. */
  path: string;
  /** Its content at HEAD; null when HEAD has no such file. Undefined when not read. */
  before?: string | null;
  /** Its content on disk; null when the file is gone. Undefined when not read. */
  after?: string | null;
}

export interface SaveSummary {
  /** The commit's subject line, at most TITLE_LIMIT characters. */
  title: string;
  /** The commit's body: a line per file, then the auto-save trailer. */
  body: string;
}

/** Git's conventional subject length; longer titles are cut with an ellipsis. */
export const TITLE_LIMIT = 72;

/** The last body line, so auto-save commits stay easy to find in a log. */
export const AUTO_SAVE_TRAILER = "Auto-saved by SpecDriven";

/** The title used when the files can't be told apart — never the empty string. */
export const FALLBACK_TITLE = "Auto-save scenarios";

/** The title when only the app's own documents changed — a drifted file absorbed, say. */
export const DOCUMENTS_TITLE = "Update app documents";

type Verb = "Add" | "Edit" | "Delete" | "Move" | "Rename" | "Describe" | "Save";

type ScenarioChange = "add" | "edit" | "remove" | "publish";

interface Entry {
  verb: Verb;
  /** What the thing is called, singular: "feature", "notebook entry", "folder description", "file". */
  noun: string;
  /** The name a title shows: the feature's, the page's, the folder's, the file's path. */
  name: string;
  /** For a feature: each scenario that changed, in the file's order. */
  scenarios: { name: string; change: ScenarioChange }[];
  /** For a feature: whether anything above the first scenario changed. */
  descriptionChanged: boolean;
  /** For a renamed feature: the name it had. */
  formerName?: string;
}

/**
 * The title and body for a commit of these files. Files under the app's
 * own folder (the Automerge documents that ride along with every save) are
 * left out: they are how the change is stored, not what changed.
 */
export function summarizeSavedChanges(files: ChangedFile[]): SaveSummary {
  const entries = mergeMoves(
    files
      .filter((f) => f.path !== STATE_DIR && !f.path.startsWith(`${STATE_DIR}/`))
      .map(entryFor),
  );
  if (entries.length === 0) {
    return { title: files.length ? DOCUMENTS_TITLE : FALLBACK_TITLE, body: AUTO_SAVE_TRAILER };
  }
  const title = fit(entries.length === 1 ? singleTitle(entries[0]!) : batchTitle(entries));
  const body = [...entries.map(bodyLine), "", AUTO_SAVE_TRAILER].join("\n");
  return { title, body };
}

function entryFor(file: ChangedFile): Entry {
  const { path, before, after } = file;
  const base = path.split("/").pop() ?? path;
  const blank: Entry = { verb: "Save", noun: "file", name: path, scenarios: [], descriptionChanged: false };
  if (before === undefined || after === undefined) return blank;
  const verb: Verb = before === null ? "Add" : after === null ? "Delete" : "Edit";
  if (isFeatureFile(base)) {
    try {
      return featureEntry(path, verb, before, after);
    } catch {
      return { ...blank, verb };
    }
  }
  if (isFolderDisplayNameFile(base)) {
    const folder = path.slice(0, -(base.length + 1)) || ".";
    return { ...blank, verb: after === null ? "Delete" : "Describe", noun: "folder description", name: folder };
  }
  const kind = PAGE_FOLDERS.find(({ folder }) => path.startsWith(`${folder}/`));
  if (kind && isPageFile(base)) {
    try {
      const page = parsePage(after ?? before ?? "");
      const name = page.name || titleFromFileName(base.replace(/\.md$/, ""));
      return { ...blank, verb, noun: kind.label, name };
    } catch {
      return { ...blank, verb };
    }
  }
  return { ...blank, verb };
}

function featureEntry(path: string, verb: Verb, before: string | null, after: string | null): Entry {
  const a = before === null ? null : parseFeature(before);
  const b = after === null ? null : parseFeature(after);
  const named = (f: Feature | null) => f?.name || titleFromFileName(path.split("/").pop()!);
  const entry: Entry = { verb, noun: "feature", name: named(b ?? a), scenarios: [], descriptionChanged: false };
  if (!a || !b) return entry;
  if (a.name !== b.name) entry.formerName = named(a);
  const was = new Map(a.scenarios.map((s) => [s.name, s]));
  const seen = new Set<string>();
  for (const s of b.scenarios) {
    seen.add(s.name);
    const old = was.get(s.name);
    if (!old) entry.scenarios.push({ name: s.name, change: "add" });
    else if (old.status !== "published" && s.status === "published") entry.scenarios.push({ name: s.name, change: "publish" });
    else if (!sameScenario(old, s)) entry.scenarios.push({ name: s.name, change: "edit" });
  }
  for (const s of a.scenarios) if (!seen.has(s.name)) entry.scenarios.push({ name: s.name, change: "remove" });
  entry.descriptionChanged = !Bun.deepEquals(withoutScenarios(a), withoutScenarios(b));
  return entry;
}

function sameScenario(a: Scenario, b: Scenario): boolean {
  return Bun.deepEquals(a, b);
}

function withoutScenarios(f: Feature): Omit<Feature, "scenarios"> {
  const { scenarios: _scenarios, ...rest } = f;
  return rest;
}

/**
 * A feature file that left one path and appeared at another in the same
 * save — the sidebar's drag between folders writes it so — is one move,
 * not a delete and an add.
 */
function mergeMoves(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  const added = new Map<string, Entry>();
  for (const e of entries) if (e.noun === "feature" && e.verb === "Add") added.set(e.name, e);
  const moved = new Set<Entry>();
  for (const e of entries) {
    if (e.noun === "feature" && e.verb === "Delete") {
      const twin = added.get(e.name);
      if (twin && !moved.has(twin)) {
        moved.add(twin);
        out.push({ ...twin, verb: "Move" });
        continue;
      }
    }
    if (!moved.has(e)) out.push(e);
  }
  return out;
}

function singleTitle(e: Entry): string {
  if (e.noun === "feature" && e.verb === "Edit") return featureTitle(e);
  if (e.verb === "Describe") return `Describe folder: ${e.name}`;
  if (e.verb === "Save") return `Save ${e.name}`;
  return `${e.verb} ${e.noun}: ${e.name}`;
}

function featureTitle(e: Entry): string {
  if (e.formerName !== undefined && e.scenarios.length === 0) {
    return `Rename feature: ${e.formerName} -> ${e.name}`;
  }
  if (e.scenarios.length === 0) return `Edit ${e.name} (description)`;
  const names = e.scenarios.map((s) => s.name);
  const changes = new Set(e.scenarios.map((s) => s.change));
  const only = changes.size === 1 && !e.descriptionChanged ? [...changes][0] : null;
  const plural = names.length === 1 ? "scenario" : "scenarios";
  const head =
    only === "add"
      ? `Add ${plural} to ${e.name}`
      : only === "remove"
        ? `Remove ${plural} from ${e.name}`
        : only === "publish"
          ? `Publish ${plural} in ${e.name}`
          : `Edit ${e.name}`;
  return `${head}: ${listNames(names, head.length + 2)}`;
}

function batchTitle(entries: Entry[]): string {
  const verbs = new Set(entries.map((e) => e.verb));
  const verb = verbs.size === 1 ? [...verbs][0]! : entries.every((e) => e.verb === "Save") ? "Save" : "Edit";
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(e.noun, [...(groups.get(e.noun) ?? []), e]);
  const counted = [...groups].map(([noun, list]) => `${list.length} ${list.length === 1 ? noun : plural(noun)}`);
  if (groups.size > 1) return `${verb} ${counted.join(", ")}`;
  const head = `${verb} ${counted[0]}`;
  if (entries[0]!.noun === "file") return head;
  const names = entries.map((e) => e.name);
  return `${head}: ${listNames(names, head.length + 2)}`;
}

/** As many names as fit the title, then how many were left out. */
function listNames(names: string[], used: number): string {
  const parts: string[] = [];
  let length = used;
  for (const [i, name] of names.entries()) {
    const left = names.length - i;
    const tail = left > 1 ? `, +${left - 1} more` : "";
    const next = (parts.length ? 2 : 0) + name.length;
    if (parts.length > 0 && length + next + tail.length > TITLE_LIMIT) {
      parts.push(`+${left} more`);
      break;
    }
    parts.push(name);
    length += next;
  }
  return parts.join(", ");
}

function plural(noun: string): string {
  return noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

function fit(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1)}…`;
}

function bodyLine(e: Entry): string {
  if (e.verb === "Save") return `- Save ${e.name}`;
  if (e.verb === "Describe") return `- Describe folder: ${e.name}`;
  const head = `- ${e.verb} ${e.noun}: ${e.name}`;
  if (e.noun !== "feature" || e.verb !== "Edit") return head;
  const parts = e.scenarios.map((s) => `${s.change} "${s.name}"`);
  if (e.formerName !== undefined) parts.unshift(`renamed from "${e.formerName}"`);
  if (e.descriptionChanged) parts.push("description");
  return parts.length ? `${head} (${parts.join("; ")})` : head;
}

/**
 * The paths a `git status --porcelain` listing names, in its order — the
 * new side of a rename, unquoted where git C-quoted an unusual name. An
 * untracked folder is listed as the folder (with its trailing slash), as
 * git lists it; the caller walks it.
 */
export function pathsInStatus(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1 && /^[RC]/.test(line)) rest = rest.slice(arrow + 4);
    paths.push(unquote(rest));
  }
  return paths;
}

/** Undo git's C-style quoting of a path with spaces, quotes or non-ASCII bytes. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = inner[++i] ?? "";
    const octal = inner.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
