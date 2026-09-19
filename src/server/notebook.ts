// The engineering notebook (specs/app/engineering-notebook.feature.md): a
// shared, dated log of what a team notices about the way it works and what it
// decides to do about it. `notebook/<yyyy-mm-dd>-<slug>.md` in the data repo,
// one entry per file, read and written by everyone with access to the repo.
//
// An entry is a markdown page (pages.ts) and gets every page behaviour for
// free — the Automerge document behind it, the drift import, the sync tick's
// commit and push. What lives here is only what makes an entry an entry: the
// date in front of the slug, the author taken from the identity that signs
// the app's commits, the Observation/Decision kind, and the link from a
// decision to the one it supersedes.
//
// The notebook is the one module whose switch is on by default, so it must
// never write to a data repo by itself: unlike the roadmap, the folder is not
// created when the switch goes on but when the first entry is written.

import { NOTEBOOK, listPages, readPage, savePage, type PageListing, type PageView } from "./pages";
import { createPage } from "./pages";
import {
  parsePage,
  serializePage,
  type EntryKind,
  type MarkdownPage,
  type Supersedes,
} from "./parser";
import { getCurrentUser } from "./user";

/** The body a new decision opens with — a skeleton the writer may delete. */
const DECISION_SKELETON = "## Context\n\n## Decision\n\n## Consequences";

/** `2026-09-12`, in the machine's own timezone: the day the writer is having. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Who a new entry is signed by: the identity that authors the app's commits
 * to the data repo (specs/user-info-settings.feature.md) — the GitHub login
 * when one is known, else the git user name, else the OS user.
 */
export async function currentAuthor(): Promise<string> {
  const user = await getCurrentUser();
  return user.login ?? user.name ?? user.username;
}

/**
 * Write an entry: `notebook/<today>-<slug>.md` with its heading, author, date
 * and kind, committed and pushed at once like a new roadmap page. A decision
 * opens with the Context/Decision/Consequences skeleton; an observation opens
 * empty.
 */
export async function createEntry(
  dataDir: string,
  title: string,
  kind: EntryKind,
  options: { author?: string; date?: string } = {},
): Promise<string> {
  const date = options.date ?? today();
  const author = options.author ?? (await currentAuthor());
  return createPage(dataDir, NOTEBOOK, title, {
    prefix: date,
    page: {
      author,
      date,
      kind,
      ...(kind === "Decision" ? { body: DECISION_SKELETON } : {}),
    },
  });
}

/**
 * Change an entry's kind — the chip in its header, never a hand edit of the
 * metadata line. A local write through the document like any page save, so
 * the sync tick commits it.
 */
export async function setEntryKind(
  dataDir: string,
  fileName: string,
  kind: EntryKind,
): Promise<PageView> {
  return rewrite(dataDir, fileName, (page) => ({ ...page, kind }));
}

/**
 * Point a decision at the decision it replaces, or unpick it with null. The
 * earlier entry is not touched: the notebook never rewrites history, it adds
 * to it — the "Superseded by" badge is derived from this link, not stored on
 * the entry it names.
 */
export async function setSupersedes(
  dataDir: string,
  fileName: string,
  link: Supersedes | null,
): Promise<PageView> {
  return rewrite(dataDir, fileName, (page) => {
    const { supersedes: _drop, ...rest } = page;
    return link ? { ...rest, supersedes: link } : rest;
  });
}

/**
 * Follow a renamed entry: every `**Supersedes:**` line and every inline link
 * that named it is pointed at its new url, so the supersede chain and the
 * cross-links between entries survive a rename (issue #122). Unlike a feature
 * file rename, where links to the old name go stale, an entry is cited by
 * other entries — a dead link there would quietly drop a badge.
 *
 * Saved through each entry's document, never straight to the file: a page
 * written behind its document's back drifts, and the next tick reconciles the
 * old url back in. Returns the entries that changed.
 */
export async function relinkEntries(
  dataDir: string,
  from: string,
  to: string,
): Promise<string[]> {
  const url = entryUrl(to);
  const changed: string[] = [];
  for (const entry of await listPages(dataDir, NOTEBOOK)) {
    if (entry.fileName === from) continue;
    const current = await readPage(dataDir, NOTEBOOK, entry.fileName);
    if (current === null) continue;
    const page = parsePage(current.content);
    // The link text is the writer's own words and is kept as written; only
    // the url is maintained, so the sentence still reads after the rename.
    const supersedes =
      page.supersedes && entryFileOf(page.supersedes.url) === from
        ? { ...page.supersedes, url }
        : page.supersedes;
    const body = relinkBody(page.body, from, url);
    if (supersedes === page.supersedes && body === page.body) continue;
    const next = { ...page, body, ...(supersedes ? { supersedes } : {}) };
    await savePage(dataDir, NOTEBOOK, entry.fileName, serializePage(next));
    changed.push(entry.fileName);
  }
  return changed;
}

/** Inline `[text](<entry>)` links naming the entry, pointed at its new url. */
function relinkBody(body: string, from: string, url: string): string {
  return body.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, text: string, target: string) =>
    // entryFileOf returns null for anything that is not one of ours — an
    // absolute url, a path that climbs out — so those are left alone.
    entryFileOf(target) === from ? `[${text}](${url})` : whole,
  );
}

/**
 * For each entry that another entry supersedes, the entry that replaced it:
 * keyed by the superseded entry's file name. Derived on every read, so a link
 * removed by hand or on GitHub takes its badge with it on the next sync.
 */
export function supersededBy(entries: PageListing[]): Record<string, PageListing> {
  const byFile = new Map(entries.map((entry) => [entry.fileName, entry]));
  const out: Record<string, PageListing> = {};
  for (const entry of entries) {
    if (!entry.supersedes) continue;
    const target = entryFileOf(entry.supersedes.url);
    const earlier = target === null ? undefined : byFile.get(target);
    // The newest replacement wins when two entries name the same predecessor:
    // the list runs newest first, so the first one seen is it.
    if (earlier && !out[earlier.fileName]) out[earlier.fileName] = entry;
  }
  return out;
}

/**
 * The entry a `/notebook/<entry>` url names, as a repo-relative file name, or
 * null for a link that points elsewhere. A link written by hand may carry the
 * `.md` already, and a bare `<entry>` with no path is taken as one of ours.
 */
export function entryFileOf(url: string): string | null {
  const path = url.trim().replace(/^\.?\//, "");
  if (!path || path.includes("://") || path.includes("..")) return null;
  const stem = decodeURIComponent(path).replace(/\.md$/, "");
  const within = stem.startsWith(`${NOTEBOOK.folder}/`)
    ? stem.slice(NOTEBOOK.folder.length + 1)
    : stem;
  if (!within || within.startsWith(".")) return null;
  return `${NOTEBOOK.folder}/${within}.md`;
}

/** The url an entry is linked by — what parseRoute reads back. */
export function entryUrl(fileName: string): string {
  const stem = fileName.slice(NOTEBOOK.folder.length + 1).replace(/\.md$/, "");
  return `/${NOTEBOOK.folder}/${stem.split("/").map(encodeURIComponent).join("/")}`;
}

/** Entries newest first — by date, then by title, so the order never wobbles. */
export function byNewest(entries: PageListing[]): PageListing[] {
  return [...entries].sort(
    (a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name),
  );
}

/** Read an entry, change its metadata, and save it back through its document. */
async function rewrite(
  dataDir: string,
  fileName: string,
  change: (page: MarkdownPage) => MarkdownPage,
): Promise<PageView> {
  const current = await readPage(dataDir, NOTEBOOK, fileName);
  if (current === null) throw new Error(`Notebook entry not found: ${fileName}`);
  return savePage(dataDir, NOTEBOOK, fileName, serializePage(change(parsePage(current.content))));
}
