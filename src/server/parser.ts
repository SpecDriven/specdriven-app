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
// The first `#` heading is the feature name; a `##` heading that ends with a
// version starts a scenario. The `@` marks where the name ends and the version
// begins, so a name that itself contains a version ("Migrate to v2 API @v1")
// stays unambiguous. Scenarios are atomic, immutable, and versioned.
// `##` headings without a version, and headings inside fenced code blocks
// (``` or ~~~), are ordinary content, not scenario boundaries.

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

export interface Scenario {
  name: string;
  version: number;
  status: ScenarioStatus;
  body: string;
  /** GitHub urls of the automated tests covering this scenario
      (specs/traceability.spec.md). */
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
}

export interface Feature {
  name: string;
  /** Free markdown between the feature heading and the first scenario. */
  description: string;
  scenarios: Scenario[];
  /** The ticket tracking the feature as a whole, if it has one. */
  link?: ExternalLink;
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
 * Test links are stored inside the scenario as a trailing `### Tests` markdown
 * table (specs/traceability.spec.md) — like the scenario table, plain markdown
 * that renders naturally on GitHub. The parser lifts the urls out of that
 * section into `Scenario.tests`; serializeFeature writes them back.
 */
const TESTS_HEADING_RE = /^###\s+Tests\s*$/i;
const URL_RE = /https?:\/\/\S+/;

/** Only GitHub urls are stored as test links (specs/traceability.spec.md). */
export function isTestLink(url: string): boolean {
  return /^https:\/\/(www\.)?github\.com\/.+/.test(url.trim());
}

/**
 * Split a scenario body into its content and the test links held by a
 * trailing `### Tests` section: one url per table row (or list item —
 * anything with a url on the line counts, markdown punctuation trimmed).
 * Headings inside fenced code blocks don't start a tests section.
 */
export function splitTests(body: string): { body: string; tests: string[] } {
  const lines = body.split("\n");
  let inFence = false;
  let headingAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i]!)) inFence = !inFence;
    else if (!inFence && TESTS_HEADING_RE.test(lines[i]!)) headingAt = i;
  }
  if (headingAt === -1) return { body, tests: [] };
  const tests: string[] = [];
  for (const line of lines.slice(headingAt + 1)) {
    const m = line.match(URL_RE);
    if (m) tests.push(m[0]!.replace(/[|)\]>,.]+$/, ""));
  }
  return { body: lines.slice(0, headingAt).join("\n").trim(), tests };
}

function testsTable(tests: string[]): string {
  return ["### Tests", "", "| Test |", "| --- |", ...tests.map((t) => `| ${t} |`)].join("\n");
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
      const { text, link } = splitExternalLink(split.body);
      current.body = text;
      current.tests = split.tests;
      if (link) current.link = link;
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

  const { text: description, link } = splitExternalLink(preamble.join("\n").trim());
  const feature: Feature = { name, description, scenarios: sortScenarios(scenarios) };
  if (link) feature.link = link;
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
}

export function serializeFeature(feature: Feature, { links = true }: SerializeOptions = {}): string {
  const parts = [`# ${feature.name}`];
  if (links && feature.link) parts.push(formatExternalLink(feature.link));
  if (feature.description) parts.push(feature.description);
  for (const s of feature.scenarios) {
    const chunks = [header(s.name, s.version, s.status)];
    if (links && s.link) chunks.push(formatExternalLink(s.link));
    if (s.body) chunks.push(s.body);
    if (s.tests.length > 0) chunks.push(testsTable(s.tests));
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
