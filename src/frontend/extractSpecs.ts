// The review step of "Extract specs from a code project"
// (specs/app/extract-specs-from-code.feature.md), as plain data: the
// proposed folders the user ticks, renames and moves about, and what the
// server is then asked to make. Pure, so the dialog's behaviour is tested
// without a page; the dialog (ExtractSpecsDialog.tsx) only renders this.

import type { Language, ModuleProposal, ModuleSource, ProposedFolder } from "../server/intentModules";
import type { ExtractionJob, JobFolder, JobLink } from "../server/intentExtraction";
import type { ChosenFolder } from "../server/intentRepo";
import { DRAFT_INSTRUCTIONS, tidyInstructions } from "../server/intentDraftPrompt";
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

/** Every feature of a run's test-linking pass. */
function linksOf(job: ExtractionJob | null | undefined): JobLink[] {
  return job ? job.folders.flatMap((f) => f.links ?? []) : [];
}

/** How many test links a run has added to scenarios so far. */
export function testsLinked(job: ExtractionJob | null | undefined): number {
  return linksOf(job).reduce((n, l) => n + (l.linked ?? 0), 0);
}

/**
 * Whether a run is in its test-linking pass: a run that only links, or one
 * whose drafting is through and whose features are being linked — or still
 * wait to be.
 */
export function linking(job: ExtractionJob | null | undefined): boolean {
  if (!job) return false;
  if (job.kind === "link") return true;
  if (!job.tests || job.folders.some((f) => !SETTLED.has(f.state))) return false;
  return linksOf(job).some((l) => l.state === "pending" || l.state === "running");
}

/** How many features a run has written so far. */
export function featuresWritten(job: ExtractionJob | null | undefined): number {
  return job ? job.folders.reduce((n, f) => n + f.batches.filter((b) => b.state === "done").length, 0) : 0;
}

/** How many times a run has changed the folder's features — one written, one given its links: what the page reloads its list on. */
export function featuresTouched(job: ExtractionJob | null | undefined): number {
  return featuresWritten(job) + linksOf(job).filter((l) => l.state === "done").length;
}

/** Whether anything is left that a retry would take up. */
export function resumable(job: ExtractionJob | null | undefined): boolean {
  if (!job || drafting(job)) return false;
  if (job.folders.some((f) => f.state === "failed" || f.state === "cancelled" || f.state === "pending")) return true;
  return Boolean(job.tests) && linksOf(job).some((l) => l.state === "failed" || l.state === "pending");
}

/** The pill's words: how the run stands, in a line. */
export function progressLabel(job: ExtractionJob): string {
  if (linking(job) || job.kind === "link") {
    const links = linksOf(job);
    const through = links.filter((l) => l.state !== "pending" && l.state !== "running").length;
    const of = `${through} of ${plural(links.length, "feature")}`;
    const failed = links.filter((l) => l.state === "failed").length;
    if (job.state === "running") return `Linking tests — ${of}`;
    if (job.state === "cancelling") return "Stopping the linking…";
    if (job.state === "interrupted") return `Linking paused — ${of}`;
    if (job.state === "cancelled") return `Linking stopped — ${of}`;
    if (failed > 0) return `Tests linked — ${plural(failed, "feature")} failed`;
    return `Tests linked — ${plural(testsLinked(job), "link")}`;
  }
  const total = job.folders.length;
  const settled = job.folders.filter((f) => SETTLED.has(f.state)).length;
  const failed = job.folders.filter((f) => f.state === "failed").length;
  if (job.state === "running") return `Drafting specs — ${settled} of ${plural(total, "folder")}`;
  if (job.state === "cancelling") return "Stopping the drafting…";
  if (job.state === "interrupted") return `Drafting paused — ${settled} of ${plural(total, "folder")}`;
  if (job.state === "cancelled") return `Drafting stopped — ${settled} of ${plural(total, "folder")}`;
  if (failed > 0) return `Specs drafted — ${plural(failed, "folder")} failed`;
  const linkFailed = linksOf(job).filter((l) => l.state === "failed").length;
  if (linkFailed > 0) return `Specs drafted — linking failed for ${plural(linkFailed, "feature")}`;
  const linked = job.tests ? `, ${plural(testsLinked(job), "test")} linked` : "";
  return `Specs drafted — ${plural(featuresWritten(job), "feature")}${linked}`;
}

/** What a folder's test-linking pass has come to, as words to add to its line; "" when it has none. */
function linksLine(folder: JobFolder): string {
  const links = folder.links ?? [];
  if (links.length === 0) return "";
  if (links.some((l) => l.state === "running")) return "linking tests…";
  const failed = links.find((l) => l.state === "failed");
  if (failed) return `linking failed: ${failed.error ?? "the turn failed"}`;
  if (links.some((l) => l.state === "pending")) return "tests still to link";
  const linked = links.reduce((n, l) => n + (l.linked ?? 0), 0);
  return linked > 0 ? `${plural(linked, "test")} linked` : (links.find((l) => l.note)?.note ?? "no tests to link");
}

/** One folder's line in the popover: what came of it. */
export function folderLine(folder: JobFolder): string {
  // A folder of a run that only links tests: its features, not its batches.
  if (folder.batches.length === 0 && folder.links) {
    const through = folder.links.filter((l) => l.state === "done" || l.state === "empty").length;
    switch (folder.state) {
      case "pending":
        return "waiting";
      case "running":
        return `linking tests — ${through} of ${plural(folder.links.length, "feature")}…`;
      case "failed":
        return folder.error ?? "failed";
      case "cancelled":
        return through > 0 ? `stopped after ${plural(through, "feature")}` : "not linked";
      default:
        return `${plural(folder.links.length, "feature")} · ${linksLine(folder)}`;
    }
  }
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
    case "done": {
      const links = linksLine(folder);
      return `${plural(done.length, "feature")}, ${plural(scenarios, "scenario")}${unread}${links ? ` · ${links}` : ""}`;
    }
    case "empty":
      return folder.batches.find((b) => b.note)?.note ?? "nothing to specify";
    case "failed":
      return folder.error ?? "failed";
    case "cancelled":
      return done.length > 0 ? `stopped after ${plural(done.length, "feature")}` : "not drafted";
  }
}

// --- The drafting prompt ------------------------------------------------------------------

/** The prompt step's text, and what it is measured against. */
export interface PromptDraft {
  /** The writing instructions as the step shows them. */
  text: string;
  /** What the step started from: the named folder's own prompt, else the built-in one. */
  loaded: string;
  /** The existing specification folder `loaded` was read for; "" when none was asked about. */
  loadedFor: string;
}

/** The step as it starts: the built-in instructions, no folder asked about. */
export const builtInPrompt = (): PromptDraft => ({ text: DRAFT_INSTRUCTIONS, loaded: DRAFT_INSTRUCTIONS, loadedFor: "" });

const samePrompt = (a: string, b: string): boolean => tidyInstructions(a) === tidyInstructions(b);

/** Whether the user changed the text from what the step started with. */
export const promptChanged = (prompt: PromptDraft): boolean => !samePrompt(prompt.text, prompt.loaded);

/** Whether the folder named keeps a prompt of its own. */
export const hasFolderPrompt = (prompt: PromptDraft): boolean => !samePrompt(prompt.loaded, DRAFT_INSTRUCTIONS);

/** Why the user is shown the prompt step again, once a folder is named after it. */
export type PromptReview =
  /** The folder keeps its own prompt, which is now the text shown. */
  | "folder"
  /** The folder keeps none, and the text shown before was another folder's: the built-in one is shown. */
  | "builtin"
  /** The user's text would replace the prompt the folder keeps. */
  | "replaces";

export const PROMPT_REVIEW: Record<PromptReview, string> = {
  folder: "The specification folder you chose has its own drafting prompt, shown here. Check it, then go on.",
  builtin: "The specification folder you chose has no drafting prompt of its own: it drafts with the built-in one, shown here.",
  replaces:
    "The specification folder you chose has its own drafting prompt. Yours replaces it for everyone who uses the folder — or go back to the folder’s.",
};

/**
 * The prompt once the specification folder is named: `folder` is the
 * existing one ("" for a new folder, which keeps no prompt yet) and `saved`
 * the prompt it keeps, or null. Text the user has not changed follows the
 * folder; text they changed stays theirs. `review` says the step must be
 * shown again before anything is made — specs are never drafted with a
 * prompt the user did not see, and a folder's own is never replaced unseen.
 */
export function promptFor(prompt: PromptDraft, folder: string, saved: string | null): { prompt: PromptDraft; review: PromptReview | null } {
  if (folder === prompt.loadedFor) return { prompt, review: null };
  const loaded = saved ?? DRAFT_INSTRUCTIONS;
  if (!promptChanged(prompt)) {
    const review = samePrompt(loaded, prompt.text) ? null : saved !== null ? "folder" : "builtin";
    return { prompt: { text: loaded, loaded, loadedFor: folder }, review };
  }
  const review = saved !== null && !samePrompt(saved, prompt.text) ? "replaces" : null;
  return { prompt: { ...prompt, loaded, loadedFor: folder }, review };
}

/**
 * What the prompt step says about being shown again, while it still holds:
 * that the text is the folder's stops being so once the user changes it,
 * and that theirs replaces the folder's once they go back to the folder's.
 */
export function promptReviewNote(prompt: PromptDraft, review: PromptReview | null): string | null {
  if (review === null) return null;
  return (review === "replaces") === promptChanged(prompt) ? PROMPT_REVIEW[review] : null;
}

/**
 * What the drafting is asked to use: the text, when the user changed it —
 * it is then saved in the folder — else nothing, and the folder's own
 * prompt, or the built-in one, is used.
 */
export const promptToSend = (prompt: PromptDraft): string | undefined => (promptChanged(prompt) ? tidyInstructions(prompt.text) : undefined);
