// Feature files are markdown, named `<slug>.feature.md`
// (specs/crud-feature.spec.md):
//
//   # <name of the feature>
//
//   <optional feature description — any markdown>
//
//   ## <name of scenario> @vNNN              (draft, editable; NNN positive int)
//   ## <name of scenario> @vNNN [draft]      (draft the user chose to keep)
//   ## <name of scenario> @vNNN [proposed]   (saved, not yet published)
//   ## <name of scenario> @vNNN [published]  (published, immutable)
//
// Only [published] and [proposed] scenarios belong in a `.feature.md` on
// disk: draft is an internal status that lives in the Automerge document
// alone (specs/automerge-store.spec.md). The [draft] chip is a wire format
// between the editor and the server — the projection drops draft scenarios,
// so the chip never lands in a file. Chipless headings still parse (hand
// edits may write them) — they enter as drafts, save promotes them to
// [proposed], and the projection leaves whatever stays draft out of the file.
//
//   <scenario body — any markdown up to the next scenario heading;
//    Gherkin tables are written as markdown tables>
//
// A feature or a scenario may carry a link to the ticket tracking it
// (specs/external-links/project-management-jira-linear-etc.feature.md): one
// `[<program>:<ticket>](<url>)` line right under its heading, e.g.
// `[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)`. The parser
// lifts it into `link`; whether the projection writes it is the "Publish
// external links" setting.
//
// A feature may also carry the project member it is assigned to
// (project-settings.json in the data repo): one `**Assigned:** <name>` line
// under the `#` heading, beside the link line. The parser lifts it into
// `assigned`; the projection always writes it.
//
// A feature and each scenario record who created them and who last updated
// them (specs/app/specs-authorship.feature.md): `**Created by:** <user>` and
// `**Updated by:** <user>` lines under the heading, beside the link line. The
// Automerge document holds them always; the projection writes them only when
// the data repo's project-settings.json turns `authors-in-markdown` on.
//
// The first `#` heading is the feature name; a `##` heading that ends with a
// version starts a scenario. The `@` marks where the name ends and the version
// begins, so a name that itself contains a version ("Migrate to v2 API @v1")
// stays unambiguous. Scenarios are atomic, immutable, and versioned.
// `##` headings without a version, and headings inside fenced code blocks
// (``` or ~~~), are ordinary content, not scenario boundaries.

import { formatEstimateLine, parseEstimateLine } from "./calendar";

/**
 * Scenario lifecycle: draft → proposed → published, advancing one way.
 * draft never appears in feature files — it is stored only in the Automerge
 * document; the other two are written as `[...]` chips on the heading.
 */
export type ScenarioStatus = "published" | "proposed" | "draft";

/**
 * A link to the ticket that tracks a feature or a scenario in a project
 * management tool — Jira, Linear, etc.
 * (specs/external-links/project-management-jira-linear-etc.feature.md).
 * Written into the markdown as `[<program>:<ticket>](<url>)`, e.g.
 * `[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)`.
 */
export interface ExternalLink {
  /**
   * Short name of the tool: "Jira", "Linear", "GitHub"… One of the
   * `EXTERNAL_LINK_TYPES` the editor offers by name, or — for "Other" — the
   * name the user gave it.
   */
  program: string;
  /** The ticket id as the tool shows it: "ABC-123", "ENG-42", "#17". */
  ticket: string;
  url: string;
}

/**
 * The tools the editor's "Tool" dropdown offers; a link to any other tool is
 * "Other", and keeps the tool's own name in `program`.
 */
export const EXTERNAL_LINK_TYPES = ["GitHub", "Jira", "Linear", "Other"] as const;
export type ExternalLinkType = (typeof EXTERNAL_LINK_TYPES)[number];

/** The dropdown entry a link's program is — "Other" for any tool not offered by name. */
export function externalLinkTypeOf(program: string): ExternalLinkType {
  const name = program.trim().toLowerCase();
  return EXTERNAL_LINK_TYPES.find((t) => t !== "Other" && t.toLowerCase() === name) ?? "Other";
}

/**
 * A pull request implementing a feature or a scenario
 * (specs/external-links/related-pull-requests.feature.md). Held in the
 * Automerge document only — never parsed from or written to markdown.
 */
export interface PullRequestLink {
  url: string;
  /** The pull request's title, read from GitHub or typed; empty when unknown. */
  title: string;
}

export interface Scenario {
  name: string;
  version: number;
  status: ScenarioStatus;
  body: string;
  /**
   * The automated tests covering this scenario (specs/external-links/
   * test-traceability.feature.md), each as the text inside its `[test: … ]`
   * token: the GitHub url alone, or `<test name> : <url>` when the test's
   * function name is known — see parseTestRef / formatTestRef. Kept as
   * strings so the Automerge document and the file agree on the entry.
   */
  tests: string[];
  /**
   * The document's id for the scenario
   * (specs/datastore/automerge-store.feature.md) — the identity that survives
   * a rename, carried only on what the editor reads from the server. Private
   * to the document: never parsed from or written to markdown.
   */
  id?: string;
  /** The ticket tracking this scenario, if it has one. */
  link?: ExternalLink;
  /**
   * The pull requests implementing this scenario. Document-only, like `id`:
   * carried on what the editor reads from the server, never serialized.
   */
  prs?: PullRequestLink[];
  /** Who created the scenario (specs/app/specs-authorship.feature.md). */
  createdBy?: string;
  /** Who last changed it. */
  updatedBy?: string;
}

export interface Feature {
  name: string;
  /** Free markdown between the feature heading and the first scenario. */
  description: string;
  scenarios: Scenario[];
  /** The ticket tracking the feature as a whole, if it has one. */
  link?: ExternalLink;
  /** The pull requests implementing the feature as a whole; document-only. */
  prs?: PullRequestLink[];
  /**
   * Name of the project member the feature is assigned to, if any — one of
   * the members listed in the data repo's `project-settings.json`
   * (src/server/members.ts). Absent when nobody is assigned.
   */
  assigned?: string;
  /**
   * Who created the feature and who last changed it — it or any of its
   * scenarios (specs/app/specs-authorship.feature.md): the GitHub login the
   * app works as, which may be an agent's given its own token.
   */
  createdBy?: string;
  updatedBy?: string;
}

/**
 * Shared identity slug: feature file stems (`<slug>.feature.md`) and deep-link
 * url segments (specs/navigation.spec.md) both use it. Lives here rather than
 * features.ts so the frontend can import it without pulling in node:fs.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Display name derived from a feature file name — the stem of
 * `<slug>.feature.md`, de-kebabed and title-cased: "quote-policy.feature.md"
 * → "Quote Policy". Used wherever a feature has no `# <name>` heading to fall
 * back on (specs/ui.spec.md "Main page": show the name, not the file name).
 */
export function titleFromFileName(fileName: string): string {
  return fileName
    .split("/")
    .pop()!
    .replace(/\.feature(\.md)?$/, "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Test links are stored inside the scenario as `[test: <url> ]` or
 * `[test: <test name> : <url> ]` lines at the end of its body
 * (specs/external-links/test-traceability.feature.md) — plain text that
 * GitHub shows verbatim. The name is the test function the url's `#L<n>`
 * anchor points at, read from the code when the link is added
 * (src/server/testName.ts). Older files carry a trailing `### Tests`
 * markdown table instead (specs/traceability.spec.md); the parser still
 * reads it, and serializeFeature writes the lines, so a file moves to the
 * new form the first time it is written. Either way the links land in
 * `Scenario.tests`, apart from the body — which is what lets a published
 * scenario's tests keep changing while its body stays immutable.
 *
 * A `[test:…]` token inside a rule's own line traces that one rule, not the
 * scenario: it stays in the body and the preview renders it where it stands.
 */
const TESTS_HEADING_RE = /^###\s+Tests\s*$/i;
const URL_RE = /https?:\/\/\S+/;
/**
 * What sits inside one token: an optional name (anything but `:` and `]`),
 * a colon, then an http(s) url. The url must start with a scheme so that
 * `https` is never mistaken for a name in front of `//…`.
 */
const TEST_TOKEN = String.raw`\[test:\s*((?:[^\]:]*?\s*:\s*)?https?:\/\/[^\]\s]+)\s*\]`;
/** One `[test: … ]` token, capturing its text; spaces around it are optional. */
const TEST_REF_RE = new RegExp(TEST_TOKEN, "g");
/** A line holding nothing but test tokens. */
const TEST_LINE_RE = new RegExp(String.raw`^\s*(?:${TEST_TOKEN}\s*)+$`);

/** Only GitHub urls are stored as test links (specs/traceability.spec.md). */
export function isTestLink(url: string): boolean {
  return /^https:\/\/(www\.)?github\.com\/.+/.test(url.trim());
}

/** The line a test url's `#L<n>` anchor names, or null without one. */
export function testLine(url: string): number | null {
  const m = url.trim().match(/#L(\d+)(?:-L\d+)?$/);
  return m ? Number(m[1]) : null;
}

/** One entry of `Scenario.tests`, taken apart. */
export interface TestRef {
  /** The GitHub url of the test, line anchor included. */
  url: string;
  /** The test's function name, when the reference carries one. */
  name?: string;
}

/**
 * A test name the token syntax can carry: something, on one line, with no
 * `:` (the separator) and no `]` (the token's end).
 */
export function isTestName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/[:\]\n]/.test(trimmed);
}

/**
 * Take a test reference apart: `<name> : <url>` gives both, a bare url just
 * the url. The name is what stands before the first colon that is followed
 * by the url — a url's own `https:` never counts as a separator.
 */
export function parseTestRef(text: string): TestRef {
  const m = text.trim().match(/^(?:([^:]*?)\s*:\s*)?(https?:\/\/\S+)$/);
  if (!m) return { url: text.trim() };
  const name = m[1]?.trim();
  return name ? { url: m[2]!, name } : { url: m[2]! };
}

/** The text a reference is written as inside its token. */
export function formatTestRef(ref: TestRef): string {
  const name = ref.name?.trim();
  return name ? `${name} : ${ref.url.trim()}` : ref.url.trim();
}

/**
 * Split a scenario body into its content and its test links: every line
 * made only of `[test: <url> ]` tokens, plus — in older files — a trailing
 * `### Tests` section, one url per table row (or list item; anything with a
 * url on the line counts, markdown punctuation trimmed). Lines and headings
 * inside fenced code blocks are content. Links are returned in the order
 * met, in their canonical `<name> : <url>` spelling, one per url — the
 * first mention of a url wins.
 */
export function splitTests(body: string): { body: string; tests: string[] } {
  const lines = body.split("\n");
  let inFence = false;
  let headingAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i]!)) inFence = !inFence;
    else if (!inFence && TESTS_HEADING_RE.test(lines[i]!)) headingAt = i;
  }
  const tests: string[] = [];
  const kept: string[] = [];
  let lifted = false;
  inFence = false;
  for (const line of headingAt === -1 ? lines : lines.slice(0, headingAt)) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence && TEST_LINE_RE.test(line)) {
      for (const m of line.matchAll(TEST_REF_RE)) tests.push(formatTestRef(parseTestRef(m[1]!)));
      lifted = true;
      continue;
    }
    kept.push(line);
  }
  if (headingAt !== -1) {
    for (const line of lines.slice(headingAt + 1)) {
      const m = line.match(URL_RE);
      if (m) tests.push(m[0]!.replace(/[|)\]>,.]+$/, ""));
    }
  }
  if (!lifted && headingAt === -1) return { body, tests: [] };
  // Removing a token line can leave two blank lines back to back.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const byUrl = new Map<string, string>();
  for (const t of tests) {
    const url = parseTestRef(t).url;
    if (!byUrl.has(url)) byUrl.set(url, t);
  }
  return { body: text, tests: [...byUrl.values()] };
}

/** The lines a scenario's test links are written as. */
function testsLines(tests: string[]): string {
  return tests.map((t) => `[test: ${t} ]`).join("\n");
}

/**
 * External links (specs/external-links/project-management-jira-linear-etc.
 * feature.md) are written as one markdown link on a line of its own —
 * `[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)` — right under
 * the heading it belongs to: the feature's `# <name>` or the scenario's.
 * Plain markdown, so GitHub renders it as a clickable ticket link. The
 * parser lifts that first line out into `link`; serializeFeature writes it
 * back, and the projection leaves it out when "Publish external links" is
 * off in Settings.
 */
const EXTERNAL_LINK_RE = /^\s{0,3}\[([^\[\]:\n]+):([^\[\]\n]+)\]\((https?:\/\/[^\s()]+)\)\s*$/;

/** The markdown line an external link is written as. */
export function formatExternalLink(link: ExternalLink): string {
  return `[${link.program}:${link.ticket}](${link.url})`;
}

/** The link a line of markdown holds, or null when it is not a link line. */
export function parseExternalLinkLine(line: string): ExternalLink | null {
  const m = line.match(EXTERNAL_LINK_RE);
  if (!m) return null;
  const program = m[1]!.trim();
  const ticket = m[2]!.trim();
  if (!program || !ticket) return null;
  return { program, ticket, url: m[3]! };
}

/**
 * A well-formed external link: a program and a ticket that the line syntax
 * can carry (no brackets, no colon in the program — it ends at the first
 * one) and an http(s) url with nothing the link syntax would cut short.
 */
export function isExternalLink(link: ExternalLink): boolean {
  const back = parseExternalLinkLine(formatExternalLink(link));
  return (
    back !== null &&
    back.program === link.program &&
    back.ticket === link.ticket &&
    back.url === link.url
  );
}

/**
 * Lift an external link off the top of a markdown text: when its first
 * non-blank line is a link line, that line is the link and the rest is the
 * text. Anything else — a link further down, a line with more on it — is
 * ordinary content.
 */
export function splitExternalLink(text: string): { text: string; link?: ExternalLink } {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at === -1) return { text };
  const link = parseExternalLinkLine(lines[at]!);
  if (!link) return { text };
  return { text: lines.slice(at + 1).join("\n").trim(), link };
}

/**
 * The project member a feature is assigned to (src/server/members.ts) is
 * written as one line under the feature's `# <name>` heading —
 * `**Assigned:** Ada Lovelace` — beside the external-link line, in either
 * order. Plain markdown, so GitHub renders it as bold text rather than
 * front-matter noise. The name is a member's name as `project-settings.json`
 * spells it; a name that is not in that file still parses and is kept, so a
 * hand edit or a member removed from the project loses nothing.
 */
const ASSIGNED_RE = /^\s{0,3}\*\*Assigned:\*\*\s*(.+?)\s*$/i;

/** The markdown line an assignment is written as. */
export function formatAssigned(assigned: string): string {
  return `**Assigned:** ${assigned}`;
}

/** The member name a line of markdown assigns, or null when it is not one. */
export function parseAssignedLine(line: string): string | null {
  const m = line.match(ASSIGNED_RE);
  if (!m) return null;
  return m[1]!.trim() || null;
}

/**
 * Authorship (specs/app/specs-authorship.feature.md) is written as two lines
 * under a feature's or a scenario's heading — `**Created by:** ada` and
 * `**Updated by:** grace` — beside the ticket link, in any order. Written
 * only while the data repo's project-settings.json asks for it
 * (`authors-in-markdown`); the Automerge document records them either way.
 */
const CREATED_BY_RE = /^\s{0,3}\*\*Created by:\*\*\s*(.+?)\s*$/i;
const UPDATED_BY_RE = /^\s{0,3}\*\*Updated by:\*\*\s*(.+?)\s*$/i;

/** The markdown line a creator is written as. */
export function formatCreatedBy(user: string): string {
  return `**Created by:** ${user}`;
}

/** The markdown line the last updater is written as. */
export function formatUpdatedBy(user: string): string {
  return `**Updated by:** ${user}`;
}

/** The creator a line of markdown names, or null when it is not one. */
export function parseCreatedByLine(line: string): string | null {
  return line.match(CREATED_BY_RE)?.[1]?.trim() || null;
}

/** The last updater a line of markdown names, or null when it is not one. */
export function parseUpdatedByLine(line: string): string | null {
  return line.match(UPDATED_BY_RE)?.[1]?.trim() || null;
}

/**
 * A task is finished or it is not (specs/app/tasks.feature.md), and that is
 * written as one more line under the heading — `**Status:** Done` — beside
 * the assignment, in either order. Only "Done" is ever written: a task still
 * to do carries no line at all, so nothing is added to a page until somebody
 * ticks it off, and a hand-written `**Status:** Blocked` is left where it is
 * as ordinary content rather than being swallowed and lost.
 */
const DONE_RE = /^\s{0,3}\*\*Status:\*\*\s*done\s*$/i;

/** The markdown line a finished page is marked with. */
export function formatDone(): string {
  return "**Status:** Done";
}

/** Whether a line of markdown is the done marker. */
export function parseDoneLine(line: string): boolean {
  return DONE_RE.test(line);
}

/**
 * An engineering notebook entry is an observation or a decision
 * (specs/app/engineering-notebook.feature.md). The kind is written as one
 * more metadata line under the heading, beside the author and the date; a
 * word that is neither reads as an observation, so a hand-written
 * `**Kind:** Note` degrades rather than being lost.
 */
export type EntryKind = "Observation" | "Decision";

const KIND_RE = /^\s{0,3}\*\*Kind:\*\*\s*(observation|decision)\s*$/i;

/** The markdown line an entry's kind is written as. */
export function formatKind(kind: EntryKind): string {
  return `**Kind:** ${kind}`;
}

/** The kind a line of markdown declares, or null when it is not one. */
export function parseKindLine(line: string): EntryKind | null {
  const m = line.match(KIND_RE);
  if (!m) return null;
  return m[1]!.toLowerCase() === "decision" ? "Decision" : "Observation";
}

/**
 * Who wrote a notebook entry: the identity that authors the app's commits to
 * the data repo (specs/user-info-settings.feature.md), written once when the
 * entry is created and shown rather than edited.
 */
const AUTHOR_RE = /^\s{0,3}\*\*Author:\*\*\s*(.+?)\s*$/i;

/** The markdown line an entry's author is written as. */
export function formatAuthor(author: string): string {
  return `**Author:** ${author}`;
}

/** The author a line of markdown names, or null when it is not one. */
export function parseAuthorLine(line: string): string | null {
  const m = line.match(AUTHOR_RE);
  if (!m) return null;
  return m[1]!.trim() || null;
}

/**
 * The day an entry was written, `yyyy-mm-dd`. It is also the prefix of the
 * entry's file name, so the folder reads in order on GitHub; the line is what
 * survives a rename of the file.
 */
const DATE_RE = /^\s{0,3}\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/i;

/** The markdown line an entry's date is written as. */
export function formatEntryDate(date: string): string {
  return `**Date:** ${date}`;
}

/** The date a line of markdown carries, or null when it is not one. */
export function parseEntryDateLine(line: string): string | null {
  return line.match(DATE_RE)?.[1] ?? null;
}

/**
 * A decision that replaces an earlier one, written as a markdown link to the
 * entry it supersedes: `**Supersedes:** [<title>](/notebook/<entry>)`. The
 * link's target is the earlier entry's file name without its folder and
 * suffix, which is what the deep link carries; the text is its title at the
 * time, kept as written so the sentence still reads after a rename.
 */
const SUPERSEDES_RE = /^\s{0,3}\*\*Supersedes:\*\*\s*\[(.+?)\]\(([^)\s]+)\)\s*$/i;

/** What one entry says about the entry it replaces. */
export interface Supersedes {
  /** The earlier entry's title, as it read when the link was made. */
  title: string;
  /** The earlier entry's url — `/notebook/<entry>`. */
  url: string;
}

/** The markdown line a supersession is written as. */
export function formatSupersedes(link: Supersedes): string {
  return `**Supersedes:** [${link.title}](${link.url})`;
}

/** The supersession a line of markdown declares, or null when it is not one. */
export function parseSupersedesLine(line: string): Supersedes | null {
  const m = line.match(SUPERSEDES_RE);
  if (!m) return null;
  const title = m[1]!.trim();
  const url = m[2]!.trim();
  return title && url ? { title, url } : null;
}

/**
 * Lift a page's metadata lines off the top of a text, without the ticket link
 * splitFeatureMeta also looks for. What a markdown page carries (parsePage):
 * the assignment and the done marker every page may have, and the author,
 * date, kind and supersession a notebook entry adds
 * (specs/app/engineering-notebook.feature.md). They may come in any order,
 * and anything else ends the metadata.
 */
export function splitPageMeta(text: string): {
  text: string;
  assigned?: string;
  estimate?: number;
  done?: boolean;
  author?: string;
  date?: string;
  kind?: EntryKind;
  supersedes?: Supersedes;
} {
  let rest = text;
  let assigned: string | undefined;
  let estimate: number | undefined;
  let done = false;
  let author: string | undefined;
  let date: string | undefined;
  let kind: EntryKind | undefined;
  let supersedes: Supersedes | undefined;
  // At most one line of each kind, so a pass per possible line settles them
  // whichever order they were written in (splitFeatureMeta).
  for (let pass = 0; pass < 7; pass++) {
    const lines = rest.split("\n");
    const at = lines.findIndex((line) => line.trim() !== "");
    if (at === -1) break;
    const line = lines[at]!;
    const nextAssigned = assigned === undefined ? parseAssignedLine(line) : null;
    const nextEstimate = estimate === undefined ? parseEstimateLine(line) : null;
    const nextAuthor = author === undefined ? parseAuthorLine(line) : null;
    const nextDate = date === undefined ? parseEntryDateLine(line) : null;
    const nextKind = kind === undefined ? parseKindLine(line) : null;
    const nextSupersedes = supersedes === undefined ? parseSupersedesLine(line) : null;
    if (nextAssigned) assigned = nextAssigned;
    else if (nextEstimate !== null) estimate = nextEstimate;
    else if (nextAuthor) author = nextAuthor;
    else if (nextDate) date = nextDate;
    else if (nextKind) kind = nextKind;
    else if (nextSupersedes) supersedes = nextSupersedes;
    else if (!done && parseDoneLine(line)) done = true;
    else break;
    rest = lines.slice(at + 1).join("\n").trim();
  }
  return {
    text: rest,
    ...(assigned ? { assigned } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    ...(done ? { done } : {}),
    ...(author ? { author } : {}),
    ...(date ? { date } : {}),
    ...(kind ? { kind } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}

/**
 * Lift a feature's metadata lines — its ticket link, its assignment and its
 * authorship — off the top of the text under the `#` heading. They may come
 * in any order, and anything else ends the metadata: a line further down, or
 * one with more on it, is ordinary description.
 */
export function splitFeatureMeta(text: string): {
  text: string;
  link?: ExternalLink;
  assigned?: string;
  createdBy?: string;
  updatedBy?: string;
} {
  let rest = text;
  let link: ExternalLink | undefined;
  let assigned: string | undefined;
  let createdBy: string | undefined;
  let updatedBy: string | undefined;
  // At most one line of each kind, so a pass per kind settles it whichever
  // order they were written in.
  for (let pass = 0; pass < 4; pass++) {
    const lines = rest.split("\n");
    const at = lines.findIndex((line) => line.trim() !== "");
    if (at === -1) break;
    const line = lines[at]!;
    const nextLink = link === undefined ? parseExternalLinkLine(line) : null;
    const nextAssigned = assigned === undefined ? parseAssignedLine(line) : null;
    const nextCreated = createdBy === undefined ? parseCreatedByLine(line) : null;
    const nextUpdated = updatedBy === undefined ? parseUpdatedByLine(line) : null;
    if (nextLink) link = nextLink;
    else if (nextAssigned) assigned = nextAssigned;
    else if (nextCreated) createdBy = nextCreated;
    else if (nextUpdated) updatedBy = nextUpdated;
    else break;
    rest = lines.slice(at + 1).join("\n").trim();
  }
  return {
    text: rest,
    ...(link ? { link } : {}),
    ...(assigned ? { assigned } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

/**
 * Lift a scenario's metadata lines — its ticket link and its authorship —
 * off the top of its body, in any order; the rest is the body.
 */
export function splitScenarioMeta(text: string): {
  text: string;
  link?: ExternalLink;
  createdBy?: string;
  updatedBy?: string;
} {
  let rest = text;
  let link: ExternalLink | undefined;
  let createdBy: string | undefined;
  let updatedBy: string | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const lines = rest.split("\n");
    const at = lines.findIndex((line) => line.trim() !== "");
    if (at === -1) break;
    const line = lines[at]!;
    const nextLink = link === undefined ? parseExternalLinkLine(line) : null;
    const nextCreated = createdBy === undefined ? parseCreatedByLine(line) : null;
    const nextUpdated = updatedBy === undefined ? parseUpdatedByLine(line) : null;
    if (nextLink) link = nextLink;
    else if (nextCreated) createdBy = nextCreated;
    else if (nextUpdated) updatedBy = nextUpdated;
    else break;
    rest = lines.slice(at + 1).join("\n").trim();
  }
  if (!link && !createdBy && !updatedBy) return { text };
  return {
    text: rest,
    ...(link ? { link } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

const FEATURE_RE = /^#\s+(.+?)\s*$/;
const SCENARIO_RE = /^##\s+(.+?)\s+@v([1-9]\d*)(?:\s+\[(published|proposed|saved|draft)\])?\s*$/;
/** Feature files written before the `@` version prefix: ``## <name> v1 [published]``. */
const LEGACY_PLAIN_SCENARIO_RE = /^##\s+(.+?)\s+v([1-9]\d*)(?:\s+\[(published|proposed|saved)\])?\s*$/;
/** Feature files written before the bracket syntax: ``## <name> `v1` `published` ``. */
const LEGACY_SCENARIO_RE = /^##\s+(.+?)\s+`v([1-9]\d*)`(?:\s+`(published|proposed|saved)`)?\s*$/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

interface HeadingMatch {
  name: string;
  version: number;
  status: ScenarioStatus;
  /**
   * Whether the status was written as a chip. A chipless heading is a draft
   * too, but an explicit [draft] chip is a user's choice the save path keeps,
   * while a chipless draft is promoted to [proposed] on save.
   */
  explicit: boolean;
}

/**
 * Read a scenario heading in the current `@vN` syntax or either legacy one —
 * the un-prefixed `vN` version and the backtick chips. Both are read and
 * written back in the current syntax, so an old feature file normalizes the
 * first time it is saved. `saved` is the old name of the proposed state
 * (specs/crud-feature.spec.md "Feature file format").
 */
function matchScenario(line: string): HeadingMatch | null {
  const m =
    line.match(SCENARIO_RE) ??
    line.match(LEGACY_SCENARIO_RE) ??
    line.match(LEGACY_PLAIN_SCENARIO_RE);
  if (!m) return null;
  return {
    name: m[1]!,
    version: Number(m[2]),
    status:
      m[3] === "published"
        ? "published"
        : m[3] === "proposed" || m[3] === "saved"
          ? "proposed"
          : "draft",
    explicit: m[3] !== undefined,
  };
}

/**
 * Canonical scenario order (specs/ui.spec.md): by name, then by version.
 * parseFeature returns scenarios in this order, so lists always render
 * sorted and a save writes the file back in canonical order.
 */
export function sortScenarios(scenarios: Scenario[]): Scenario[] {
  return [...scenarios].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
}

/**
 * Why a text is not a well-formed feature file, or null when it is
 * (specs/crud-feature.spec.md "Feature file format"): it opens with the
 * feature heading — `# ` followed by the feature name — and nothing above it.
 * Reading stays lenient (a file with no heading still lists, named after its
 * stem); writing does not, so a bug upstream cannot commit a broken file.
 */
export function featureTextError(text: string): string | null {
  const first = text.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return "the file is empty";
  if (FEATURE_RE.test(first)) return null;
  if (/^#\s*$/.test(first)) return "the feature heading has no name";
  return `it must start with the feature heading "# <name>", not ${JSON.stringify(clip(first))}`;
}

/** Enough of a line to recognize it in an error message. */
function clip(line: string): string {
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function parseFeature(text: string): Feature {
  let name = "";
  const preamble: string[] = [];
  const scenarios: Scenario[] = [];
  let current: Scenario | null = null;
  const bodyLines: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) {
      const split = splitTests(bodyLines.join("\n").trim());
      const { text, link, createdBy, updatedBy } = splitScenarioMeta(split.body);
      current.body = text;
      current.tests = split.tests;
      if (link) current.link = link;
      if (createdBy) current.createdBy = createdBy;
      if (updatedBy) current.updatedBy = updatedBy;
      scenarios.push(current);
      bodyLines.length = 0;
    }
  };

  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const featureMatch = line.match(FEATURE_RE);
      if (featureMatch && !name && !current) {
        name = featureMatch[1]!;
        continue;
      }
      const scenarioMatch = matchScenario(line);
      if (scenarioMatch) {
        flush();
        current = {
          name: scenarioMatch.name,
          version: scenarioMatch.version,
          status: scenarioMatch.status,
          body: "",
          tests: [],
        };
        continue;
      }
    }
    if (current) bodyLines.push(line);
    else preamble.push(line);
  }
  flush();

  const { text: description, link, assigned, createdBy, updatedBy } = splitFeatureMeta(
    preamble.join("\n").trim(),
  );
  const feature: Feature = { name, description, scenarios: sortScenarios(scenarios) };
  if (link) feature.link = link;
  if (assigned) feature.assigned = assigned;
  if (createdBy) feature.createdBy = createdBy;
  if (updatedBy) feature.updatedBy = updatedBy;
  return feature;
}

function header(name: string, version: number, status: ScenarioStatus): string {
  return `## ${name} @v${version} [${status}]`;
}

export interface SerializeOptions {
  /**
   * Whether the feature's and scenarios' external links are written
   * (default true). The `.feature.md` projection passes the "Publish
   * external links" setting here; everything else — the editor wire format,
   * the conflict dialog — always carries the links.
   */
  links?: boolean;
  /**
   * Whether who created and last updated the feature and each scenario is
   * written (default true; specs/app/specs-authorship.feature.md). The
   * projection passes the data repo's `authors-in-markdown` setting.
   */
  authors?: boolean;
}

export function serializeFeature(
  feature: Feature,
  { links = true, authors = true }: SerializeOptions = {},
): string {
  const parts = [`# ${feature.name}`];
  if (links && feature.link) parts.push(formatExternalLink(feature.link));
  if (feature.assigned) parts.push(formatAssigned(feature.assigned));
  if (authors && feature.createdBy) parts.push(formatCreatedBy(feature.createdBy));
  if (authors && feature.updatedBy) parts.push(formatUpdatedBy(feature.updatedBy));
  if (feature.description) parts.push(feature.description);
  for (const s of feature.scenarios) {
    const chunks = [header(s.name, s.version, s.status)];
    if (links && s.link) chunks.push(formatExternalLink(s.link));
    if (authors && s.createdBy) chunks.push(formatCreatedBy(s.createdBy));
    if (authors && s.updatedBy) chunks.push(formatUpdatedBy(s.updatedBy));
    if (s.body) chunks.push(s.body);
    if (s.tests.length > 0) chunks.push(testsLines(s.tests));
    parts.push(chunks.join("\n\n"));
  }
  return parts.join("\n\n") + "\n";
}

/** Identity of one scenario inside a feature file: heading name + version. */
export interface ScenarioPick {
  name: string;
  version: number;
}

/**
 * A scenario the editor is saving or publishing: its heading identity, plus
 * the document's id for it when the editor holds one (`Scenario.id`). The id
 * is what keeps the scenario one scenario through a rename — the document
 * renames that entry rather than filing the new name as a second scenario
 * (specs/editor-autosave.feature.md "Autosave Never Adds the Same Scenario
 * Twice"), which matters most for a draft: the file never held it, so a save
 * that leaves it out removes nothing
 * (specs/datastore/automerge-store.feature.md "draft scenarios live in the
 * document only").
 */
export interface ScenarioTarget extends ScenarioPick {
  id?: string;
}

/**
 * Serialize just the picked scenarios of a feature file — the heading and
 * description stay, every unpicked scenario drops out
 * (specs/agents/claude.spec.md: a code gen session can take a whole spec or
 * a subset of its scenarios). Throws when a pick names a scenario the file
 * doesn't have, so a stale client selection fails loudly instead of running
 * Claude over less than the user chose.
 */
export function extractScenarios(text: string, picks: ScenarioPick[]): string {
  const feature = parseFeature(text);
  const key = (s: ScenarioPick) => `${s.name}@v${s.version}`;
  const have = new Set(feature.scenarios.map(key));
  for (const pick of picks) {
    if (!have.has(key(pick))) {
      throw new Error(`scenario not found: ${pick.name} @v${pick.version}`);
    }
  }
  const wanted = new Set(picks.map(key));
  return serializeFeature({
    ...feature,
    scenarios: feature.scenarios.filter((s) => wanted.has(key(s))),
  });
}

/**
 * Rewrite the feature's `# <name>` heading — its display name — leaving the
 * rest of the text untouched (specs/ui.spec.md "Main page": the Edit link
 * edits the feature name, not the file name). Only the first `#` heading
 * before any scenario and outside fenced code blocks is the name; a file
 * without one gets a heading inserted at the top.
 */
export function renameFeatureName(text: string, name: string): string {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (matchScenario(line)) break;
    if (FEATURE_RE.test(line)) {
      lines[i] = `# ${name}`;
      return lines.join("\n");
    }
  }
  const body = text.replace(/^\n+/, "");
  return body ? `# ${name}\n\n${body}` : `# ${name}\n`;
}

/**
 * Rewrite every scenario heading's status chip with the value chosen by
 * `next`. Works on the raw text line-by-line so body content that doesn't fit
 * the parse model survives untouched, and headings inside fenced code blocks
 * are left alone. Legacy headings are normalized to the `@vN` and bracket
 * syntax, and old [saved] chips to [proposed].
 */
function rewriteHeaders(text: string, next: (m: HeadingMatch) => ScenarioStatus): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = matchScenario(line);
      if (!m) return line;
      return header(m.name, m.version, next(m));
    })
    .join("\n");
}

/**
 * Mark every scenario heading as published: a [proposed] chip is upgraded and
 * already-[published] headings stay as they are. An explicit [draft] chip is
 * the user's choice to keep the scenario out of the feature file, so a
 * whole-feature publish leaves it alone — a draft publishes only through
 * markScenarioPublished, an explicit action on that one scenario.
 */
export function markPublished(text: string): string {
  return rewriteHeaders(text, (m) => (m.status === "draft" && m.explicit ? "draft" : "published"));
}

/**
 * Mark one scenario (by name and version) as published, leaving every other
 * heading untouched (specs/crud-feature.spec.md "publish each scenario
 * individually").
 */
export function markScenarioPublished(text: string, name: string, version: number): string {
  return rewriteHeaders(text, (m) =>
    m.name === name && m.version === version ? "published" : m.status,
  );
}

/**
 * Mark every unmarked scenario heading with a [proposed] chip
 * (specs/crud-feature.spec.md, "Scenario is automatically saved locally and
 * pushed to GitHub"). [published] and [proposed] headings are untouched, and
 * so is an explicit [draft] chip — that is the editor asking for the scenario
 * to stay a draft, stored in the document and kept out of the file.
 */
export function markProposed(text: string): string {
  return rewriteHeaders(text, (m) =>
    m.status === "draft" && !m.explicit ? "proposed" : m.status,
  );
}

// Markdown pages (specs/app/roadmap.feature.md, specs/app/tasks.feature.md)
// are the data repo's other kind of markdown: regular files in the special
// `roadmap/` and `tasks/` folders, with no scenarios in them. Like a feature,
// a page may carry the project member it is assigned to on an `**Assigned:**`
// line under its heading — which, with the `**Status:** Done` line a finished
// task is ticked off with, is all a task needs to be a task; everything else
// is free markdown, kept as written.

/** A markdown page: its heading, its state, and its markdown. */
export interface MarkdownPage {
  /** The `# <name>` heading, or "" for a file that opens without one. */
  name: string;
  /** Everything below the heading and the metadata lines. */
  body: string;
  /** Name of the project member the document is assigned to, if any. */
  assigned?: string;
  /** How long a task is estimated to take, in minutes — what its Add to
      calendar button writes (tasks.feature.md, src/server/calendar.ts). */
  estimate?: number;
  /** Whether the page is finished — a task's Done (tasks.feature.md). */
  done?: boolean;
  /**
   * Who wrote a notebook entry
   * (specs/app/engineering-notebook.feature.md). Absent on a roadmap page or
   * a task, and on an entry dropped into the folder by hand.
   */
  author?: string;
  /** The day a notebook entry was written, `yyyy-mm-dd`. */
  date?: string;
  /** Whether a notebook entry is an observation or a decision. */
  kind?: EntryKind;
  /** The earlier decision a notebook entry replaces, if any. */
  supersedes?: Supersedes;
}

const PAGE_HEADING_RE = /^#\s+(.+?)\s*$/;

/**
 * Read a markdown page. A leading `# <name>` heading is the name; the
 * `**Assigned:** <name>` and `**Status:** Done` lines right under it are its
 * metadata. A file that starts with none of them is all body — a plain markdown file must survive the
 * round trip unchanged apart from its surrounding blank lines.
 */
export function parsePage(text: string): MarkdownPage {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  const heading = at === -1 ? null : lines[at]!.match(PAGE_HEADING_RE);
  const rest = heading ? lines.slice(at + 1).join("\n").trim() : text.trim();
  const { text: body, assigned, estimate, done, author, date, kind, supersedes } =
    splitPageMeta(rest);
  return {
    name: heading ? heading[1]! : "",
    body,
    ...(assigned ? { assigned } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    ...(done ? { done: true } : {}),
    ...(author ? { author } : {}),
    ...(date ? { date } : {}),
    ...(kind ? { kind } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}

/**
 * The markdown a page is written as — the shape parsePage reads. A notebook
 * entry's lines come in a fixed order — author, date, kind, then the
 * supersession under it (specs/app/engineering-notebook.feature.md) — so the
 * projection is deterministic however the file was written by hand.
 */
export function serializePage(doc: MarkdownPage): string {
  const parts: string[] = [];
  if (doc.name) parts.push(`# ${doc.name}`);
  if (doc.assigned) parts.push(formatAssigned(doc.assigned));
  if (doc.estimate) parts.push(formatEstimateLine(doc.estimate));
  if (doc.author) parts.push(formatAuthor(doc.author));
  if (doc.date) parts.push(formatEntryDate(doc.date));
  if (doc.kind) parts.push(formatKind(doc.kind));
  if (doc.supersedes) parts.push(formatSupersedes(doc.supersedes));
  if (doc.done) parts.push(formatDone());
  if (doc.body) parts.push(doc.body);
  return parts.length === 0 ? "" : parts.join("\n\n") + "\n";
}
