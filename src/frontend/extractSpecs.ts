// The review step of "Extract specs from a code project"
// (specs/app/extract-specs-from-code.feature.md), as plain data: the
// proposed folders the user ticks, renames and moves about, and what the
// server is then asked to make. Pure, so the dialog's behaviour is tested
// without a page; the dialog (ExtractSpecsDialog.tsx) only renders this.

import type { Language, ModuleProposal, ModuleSource, ProposedFolder } from "../server/intentModules";
import type { ExtractionJob, JobFolder } from "../server/intentExtraction";
import type { ChosenFolder } from "../server/intentRepo";
import { slugify } from "../server/parser";

/** How deep folders may be nested by hand: the app's own limit for chosen folders. */
export const MAX_REVIEW_DEPTH = 6;

/** One folder under review. */
export interface ReviewFolder {
  /** Stays the same through a rename or a move. */
  key: string;
  name: string;
  /** The analysed folders whose code its specs are drafted from. */
  modules: string[];
  files: number;
  tests: number;
  languages: Language[];
  source: ModuleSource;
  reason: string;
  description: string;
  /** Ticked: it is made, and specs are drafted for it when it has code of its own. */
  selected: boolean;
  children: ReviewFolder[];
}

/** A proposal's folders as the review starts with them. */
export function reviewFolders(folders: readonly ProposedFolder[]): ReviewFolder[] {
  return folders.map((f) => ({
    key: f.id,
    name: f.name,
    modules: [...f.modules],
    files: f.files,
    tests: f.tests,
    languages: [...f.languages],
    source: f.source,
    reason: f.reason,
    description: f.description,
    selected: f.selected,
    children: reviewFolders(f.children),
  }));
}

/** Every folder, parents before their children. */
export function flatten(tree: readonly ReviewFolder[]): ReviewFolder[] {
  return tree.flatMap((f) => [f, ...flatten(f.children)]);
}

const mapTree = (tree: readonly ReviewFolder[], fn: (f: ReviewFolder) => ReviewFolder): ReviewFolder[] =>
  tree.map((f) => fn({ ...f, children: mapTree(f.children, fn) }));

/** Tick or untick a folder — and, with it, everything inside it. */
export function setSelected(tree: readonly ReviewFolder[], key: string, selected: boolean): ReviewFolder[] {
  const all = (f: ReviewFolder): ReviewFolder => ({ ...f, selected, children: f.children.map(all) });
  const visit = (list: readonly ReviewFolder[]): ReviewFolder[] =>
    list.map((f) => (f.key === key ? all(f) : { ...f, children: visit(f.children) }));
  return visit(tree);
}

/** Tick or untick every folder. */
export function setAllSelected(tree: readonly ReviewFolder[], selected: boolean): ReviewFolder[] {
  return mapTree(tree, (f) => ({ ...f, selected }));
}

/** Give a folder another name. */
export function rename(tree: readonly ReviewFolder[], key: string, name: string): ReviewFolder[] {
  return mapTree(tree, (f) => (f.key === key ? { ...f, name } : f));
}

const depthOf = (f: ReviewFolder): number => 1 + Math.max(0, ...f.children.map(depthOf));

/**
 * The folders `key` may be moved into, each with the depth it sits at:
 * every folder but itself, the ones inside it, the one it is in already,
 * and any so deep that the move would nest past the limit.
 */
export function moveTargets(tree: readonly ReviewFolder[], key: string): { key: string; name: string; depth: number }[] {
  const moving = flatten(tree).find((f) => f.key === key);
  if (!moving) return [];
  const height = depthOf(moving);
  const out: { key: string; name: string; depth: number }[] = [];
  const visit = (list: readonly ReviewFolder[], depth: number) => {
    for (const f of list) {
      if (f.key === key) continue;
      const holdsIt = f.children.some((c) => c.key === key);
      if (!holdsIt && depth + height <= MAX_REVIEW_DEPTH) out.push({ key: f.key, name: f.name, depth });
      visit(f.children, depth + 1);
    }
  };
  visit(tree, 1);
  return out;
}

/**
 * Move a folder into another — at its end — or to the top level (`into`
 * null). A move into itself, into a folder inside it, or past the depth
 * limit changes nothing.
 */
export function move(tree: readonly ReviewFolder[], key: string, into: string | null): ReviewFolder[] {
  const moving = flatten(tree).find((f) => f.key === key);
  if (!moving) return [...tree];
  if (into !== null && !moveTargets(tree, key).some((t) => t.key === into)) return [...tree];
  const without = (list: readonly ReviewFolder[]): ReviewFolder[] =>
    list.filter((f) => f.key !== key).map((f) => ({ ...f, children: without(f.children) }));
  const rest = without(tree);
  if (into === null) return [...rest, moving];
  return mapTree(rest, (f) => (f.key === into ? { ...f, children: [...f.children, moving] } : f));
}

/** Whether a folder or anything inside it is ticked: it has to exist for those to sit in it. */
const holdsSelected = (f: ReviewFolder): boolean => f.selected || f.children.some(holdsSelected);

/**
 * What the server is asked to make: every ticked folder, and every folder
 * that holds one, each at the path its name gives it under its parent — a
 * second folder of the same name beside it gets `-2`. Specs are drafted for
 * the ticked ones that have code of their own.
 */
export function chosen(tree: readonly ReviewFolder[]): ChosenFolder[] {
  const out: ChosenFolder[] = [];
  const visit = (list: readonly ReviewFolder[], parent: string) => {
    const taken = new Set<string>();
    for (const f of list) {
      if (!holdsSelected(f)) continue;
      const base = slugify(f.name) || "folder";
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      taken.add(slug);
      const folder = parent ? `${parent}/${slug}` : slug;
      out.push({ folder, name: f.name.trim(), modules: f.modules, draft: f.selected && f.modules.length > 0 && f.files + f.tests > 0 });
      visit(f.children, folder);
    }
  };
  visit(tree, "");
  return out;
}

/** Why the review cannot go on, as one sentence, or null when it can. */
export function reviewProblem(tree: readonly ReviewFolder[]): string | null {
  const picked = chosen(tree);
  if (picked.length === 0) return "Tick at least one folder";
  if (picked.some((f) => !f.name)) return "Give every folder a name";
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line under the tree: how much is chosen. */
export function reviewSummary(tree: readonly ReviewFolder[]): string {
  const picked = chosen(tree);
  const drafted = picked.filter((f) => f.draft).length;
  if (picked.length === 0) return "No folder is ticked";
  return `${plural(picked.length, "folder")} will be made, ${drafted === picked.length ? "each" : drafted} with specs drafted from its code`;
}

/** What a folder holds, for the hint under its name. */
export function folderCounts(f: Pick<ReviewFolder, "files" | "tests" | "children">): string {
  const parts: string[] = [];
  if (f.files > 0 || f.children.length === 0) parts.push(plural(f.files, "file"));
  if (f.tests > 0) parts.push(plural(f.tests, "test"));
  if (f.children.length > 0) parts.push(plural(f.children.length, "folder"));
  return parts.join(", ");
}

/** What the analysis found, as the sentence above the tree. */
export function proposalSummary(proposal: Pick<ModuleProposal, "sourceFiles" | "languages" | "skipped" | "truncated">, labels: Record<Language, string>): string {
  const languages = proposal.languages.map((l) => labels[l]).join(", ");
  const parts = [`${plural(proposal.sourceFiles, "source file")}${languages ? ` in ${languages}` : ""}`];
  if (proposal.skipped.length > 0) {
    parts.push(`${proposal.skipped.map((s) => `${plural(s.files, "file")} of ${s.what}`).join(", ")} not read`);
  }
  if (proposal.truncated) parts.push("the project is large, so only part of it is proposed");
  return `${parts.join(" · ")}.`;
}

// --- The drafting's progress (ExtractionProgress.tsx) ------------------------------------

/** What GET /api/extract/draft answers. */
export interface ExtractionStatus {
  job: ExtractionJob | null;
  /** Whether the open folder has a repository to push to. */
  published: boolean;
}

/** Whether a run is at work: the page keeps asking how it stands. */
export function drafting(job: ExtractionJob | null | undefined): boolean {
  return job?.state === "running" || job?.state === "cancelling";
}

const SETTLED = new Set<JobFolder["state"]>(["done", "empty", "failed"]);

/** How many features a run has written so far: what the page reloads its list on. */
export function featuresWritten(job: ExtractionJob | null | undefined): number {
  return job ? job.folders.reduce((n, f) => n + f.batches.filter((b) => b.state === "done").length, 0) : 0;
}

/** Whether anything is left that a retry would take up. */
export function resumable(job: ExtractionJob | null | undefined): boolean {
  if (!job || drafting(job)) return false;
  return job.folders.some((f) => f.state === "failed" || f.state === "cancelled" || f.state === "pending");
}

/** The pill's words: how the run stands, in a line. */
export function progressLabel(job: ExtractionJob): string {
  const total = job.folders.length;
  const settled = job.folders.filter((f) => SETTLED.has(f.state)).length;
  const failed = job.folders.filter((f) => f.state === "failed").length;
  if (job.state === "running") return `Drafting specs — ${settled} of ${plural(total, "folder")}`;
  if (job.state === "cancelling") return "Stopping the drafting…";
  if (job.state === "interrupted") return `Drafting paused — ${settled} of ${plural(total, "folder")}`;
  if (job.state === "cancelled") return `Drafting stopped — ${settled} of ${plural(total, "folder")}`;
  if (failed > 0) return `Specs drafted — ${plural(failed, "folder")} failed`;
  return `Specs drafted — ${plural(featuresWritten(job), "feature")}`;
}

/** One folder's line in the popover: what came of it. */
export function folderLine(folder: JobFolder): string {
  const done = folder.batches.filter((b) => b.state === "done");
  const scenarios = done.reduce((n, b) => n + (b.scenarios ?? 0), 0);
  const unread = folder.notRead > 0 ? ` · ${plural(folder.notRead, "file")} not read` : "";
  switch (folder.state) {
    case "pending":
      return "waiting";
    case "running": {
      const at = folder.batches.findIndex((b) => b.state === "running");
      return folder.batches.length > 1 ? `drafting part ${at + 1} of ${folder.batches.length}…` : "drafting…";
    }
    case "done":
      return `${plural(done.length, "feature")}, ${plural(scenarios, "scenario")}${unread}`;
    case "empty":
      return folder.batches.find((b) => b.note)?.note ?? "nothing to specify";
    case "failed":
      return folder.error ?? "failed";
    case "cancelled":
      return done.length > 0 ? `stopped after ${plural(done.length, "feature")}` : "not drafted";
  }
}
