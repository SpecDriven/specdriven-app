// Import from Jira/Wiki (specs/external-links/jira-wiki-import.feature.md):
// up to five Jira issues and five Confluence pages, read with the tokens
// this device holds, become the text an agent plugin is asked — in one
// no-tools turn, like the task estimate (./estimate.ts) — to turn into a
// feature: a title and up to fifteen scenarios, which the dialog shows for
// review before any file is written. When the sources would justify more
// than fifteen the answer names the rest, and the dialog asks before going
// on. Node APIs only: this runs under Electron.

import { agents } from "../plugins/host/agents";
import type { OneShotResult } from "../plugins/host/agents";
import { ConfluenceError, getPageBody, resolveParent } from "./confluence";
import { confluenceToken } from "./confluenceTokens";
import { htmlToMarkdown } from "./html";
import { getJiraIssue, JiraError } from "./jira";
import { jiraToken } from "./jiraTokens";
import { MAX_SCENARIOS, sourcesProblem, type SourceRef } from "./importSources";
import { parseJiraIssueUrl } from "./jiraUrl";
import { dedupeTicketLinks, formatExternalLink, MAX_FEATURE_TICKETS, type ExternalLink } from "./parser";

/** Why an import could not go on, with the HTTP status the route answers. */
export class ImportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export { classifySource, MAX_JIRA_SOURCES, MAX_SCENARIOS, MAX_WIKI_SOURCES, sourcesProblem } from "./importSources";
export type { SourceRef } from "./importSources";

/** The refusal when no agent answers one-shot turns here. */
export const IMPORT_AGENT_MISSING = "No agent can read the sources — install the Claude or Codex agent plugin";

/** How long the agent gets before the turn is abandoned: ten sources make a long read. */
export const IMPORT_TIMEOUT_MS = 180_000;

/** One source's text is cut here, and all of them together there. */
export const SOURCE_MAX = 12_000;
export const TOTAL_MAX = 60_000;

// --- Sources -----------------------------------------------------------------------

/** One source, read and converted: what the agent is shown. */
export interface SourceText {
  kind: "jira" | "wiki";
  url: string;
  /** The issue key, or the page title. */
  title: string;
  /** Markdown, cut to SOURCE_MAX. */
  text: string;
}

function cut(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** An issue as a reader would want it: its facts, then every text it holds, as markdown. */
function issueText(issue: Awaited<ReturnType<typeof getJiraIssue>>): string {
  const parts: string[] = [];
  const facts = [
    issue.type && `Type: ${issue.type}`,
    issue.status && `Status: ${issue.status}`,
    issue.labels.length > 0 && `Labels: ${issue.labels.join(", ")}`,
  ].filter(Boolean);
  parts.push(`Summary: ${issue.summary}`);
  if (facts.length) parts.push(facts.join(" · "));
  const md = (html: string) => htmlToMarkdown(html).trim();
  if (issue.descriptionHtml.trim()) parts.push(`Description:\n${md(issue.descriptionHtml)}`);
  for (const f of issue.fields) parts.push(`${f.name}:\n${md(f.html)}`);
  if (issue.subtasks.length) {
    parts.push(`Sub-tasks:\n${issue.subtasks.map((s) => `- ${s.key} ${s.summary}`.trimEnd()).join("\n")}`);
  }
  if (issue.comments.length) {
    parts.push(
      `Comments:\n${issue.comments
        .map((c) => `${c.author ? `${c.author}: ` : ""}${md(c.html)}`)
        .join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Read every source with the token this device holds for its site. A site
 * without a token, or a source the service refuses, stops the import with
 * one sentence naming the url.
 */
export async function readSources(refs: SourceRef[]): Promise<SourceText[]> {
  const problem = sourcesProblem(refs);
  if (problem) throw new ImportError(400, problem);
  const one = async (ref: SourceRef): Promise<SourceText> => {
    try {
      if (ref.kind === "jira") {
        const record = await jiraToken(ref.base);
        if (!record) throw new ImportError(401, `No Jira token for ${ref.base} — add one in Settings → Jira.`);
        const issue = await getJiraIssue(ref.base, record.token, ref.key);
        return { kind: "jira", url: issue.url, title: issue.key, text: cut(issueText(issue), SOURCE_MAX) };
      }
      const record = await confluenceToken(ref.base);
      if (!record) {
        throw new ImportError(401, `No Confluence token for ${ref.base} — add one in Settings → Confluence.`);
      }
      const { id } = await resolveParent(ref.base, record.token, ref.page);
      const page = await getPageBody(ref.base, record.token, id);
      return { kind: "wiki", url: page.url, title: page.title, text: cut(htmlToMarkdown(page.html), SOURCE_MAX) };
    } catch (e) {
      if (e instanceof ImportError) throw e;
      if (e instanceof JiraError || e instanceof ConfluenceError) {
        throw new ImportError(e.status, `${ref.url}: ${e.message}`);
      }
      throw new ImportError(502, `${ref.url}: ${(e as Error).message}`);
    }
  };
  const texts = await Promise.all(refs.map(one));
  // Ten long sources together are cut to what one turn can hold, each
  // losing the same share.
  const total = texts.reduce((n, t) => n + t.text.length, 0);
  if (total <= TOTAL_MAX) return texts;
  const share = TOTAL_MAX / total;
  return texts.map((t) => ({ ...t, text: cut(t.text, Math.max(200, Math.floor(t.text.length * share))) }));
}

// --- The turn ----------------------------------------------------------------------

export const SYSTEM_PROMPT =
  "You turn requirements — Jira issues and Confluence pages — into a specification: one feature " +
  "title and a set of scenarios in the Given/When/Then style. Each scenario has a short name, a " +
  "sentence or two, naming one behaviour, and a body of markdown bullets: `- Given: …`, `- When: …`, " +
  "`- Then: …`, with `- and: …` for further conditions or outcomes. Write what the system does for " +
  "whom, in the present tense, in plain English; never copy ticket boilerplate, never invent what " +
  "the sources do not say, never use headings, tables, status words or links in a body. Keep each " +
  "scenario to one behaviour; split a ticket into several when it describes several. Prefer the " +
  `sources' own words for names. Propose at most ${MAX_SCENARIOS} scenarios in order of importance. ` +
  "When the sources would justify more, list the names of the rest in `more`, without bodies, and " +
  "leave `more` empty when they would not. Do not explain, do not ask questions, do not use any tools. " +
  "Answer with JSON only.";

/** The one user turn: each source with its text, what has been proposed already, and what to answer with. */
export function proposePrompt(sources: SourceText[], exclude: string[] = []): string {
  const lines: string[] = [];
  sources.forEach((s, i) => {
    const what = s.kind === "jira" ? `Jira issue ${s.title}` : `Confluence page “${s.title}”`;
    lines.push(`### Source ${i + 1}: ${what}`, s.url, "", s.text || "(empty)", "");
  });
  if (exclude.length > 0) {
    lines.push(
      "These scenarios have been proposed already; do not repeat them, propose the next ones:",
      ...exclude.map((n) => `- ${n}`),
      "",
    );
  }
  lines.push(
    "Answer with one JSON object: " +
      '{"title": string, "scenarios": [{"name": string, "body": string, "sources": [string]}], "more": [string]}' +
      ` — at most ${MAX_SCENARIOS} scenarios, each naming the source keys or page titles it rests on.`,
  );
  return lines.join("\n");
}

/** The answer the agent is held to. */
export const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    scenarios: {
      type: "array",
      maxItems: MAX_SCENARIOS,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          body: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
        required: ["name", "body"],
      },
    },
    more: { type: "array", items: { type: "string" } },
  },
  required: ["title", "scenarios", "more"],
};

export interface ProposedScenario {
  name: string;
  body: string;
  /** The source keys or page titles the scenario rests on, as the agent named them. */
  sources: string[];
}

export interface Proposal {
  title: string;
  scenarios: ProposedScenario[];
  /** Names of scenarios the sources would justify beyond those proposed. */
  more: string[];
  /** Who answered, for the dialog. */
  agent: string;
}

/** A line of text, with what the spec syntax would misread taken out, cut to 200 characters. */
export function cleanName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^S\d+:\s*/i, "")
    .replace(/\s*@v\d+\b/gi, "")
    .replace(/\s*\[(published|proposed|draft)\]/gi, "")
    .replace(/\//g, "-")
    .trim()
    .slice(0, 200)
    .trim();
}

/** The first JSON object in a text, when the agent wrapped it in words or a fence. */
function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];

/** What the agent answered, as a proposal, or null when it is not one. */
export function proposalFromResult(
  result: Pick<OneShotResult, "text" | "structured" | "isError">,
): Omit<Proposal, "agent"> | null {
  if (result.isError) return null;
  const raw = (result.structured ?? firstJson(result.text)) as
    | { title?: unknown; scenarios?: unknown; more?: unknown }
    | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.title !== "string" || !Array.isArray(raw.scenarios)) return null;
  const seen = new Set<string>();
  const scenarios: ProposedScenario[] = [];
  for (const s of raw.scenarios as { name?: unknown; body?: unknown; sources?: unknown }[]) {
    if (!s || typeof s.name !== "string" || typeof s.body !== "string") continue;
    const name = cleanName(s.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    scenarios.push({ name, body: s.body.trim(), sources: strings(s.sources) });
    if (scenarios.length === MAX_SCENARIOS) break;
  }
  const title = cleanName(raw.title);
  if (!title || scenarios.length === 0) return null;
  return { title, scenarios, more: strings(raw.more).map(cleanName).filter(Boolean) };
}

/**
 * Ask the agent once for the feature the sources describe. Throws an
 * ImportError with the status the route answers: 503 without an agent that
 * can, 502 when the agent fails or answers with something else.
 */
export async function proposeFeature(
  sources: SourceText[],
  cwd: string,
  options: { agent?: string; model?: string; exclude?: string[]; timeoutMs?: number } = {},
): Promise<Proposal> {
  const provider = agents.oneShot(options.agent);
  if (!provider?.oneShot) throw new ImportError(503, IMPORT_AGENT_MISSING);
  const who = provider.label;
  try {
    const result = await provider.oneShot({
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      prompt: proposePrompt(sources, options.exclude ?? []),
      schema: PROPOSAL_SCHEMA,
      ...(options.model ? { model: options.model } : {}),
      timeoutMs: options.timeoutMs ?? IMPORT_TIMEOUT_MS,
    });
    if (result.isError) {
      throw new ImportError(502, `${who} could not read the sources: ${result.text.trim() || "the turn failed"}`);
    }
    const proposal = proposalFromResult(result);
    if (!proposal) throw new ImportError(502, `${who} did not answer with a title and scenarios`);
    return { ...proposal, agent: who };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(502, `${who} could not read the sources: ${(e as Error).message}`);
  }
}

// --- The file ----------------------------------------------------------------------

/** A source as the created feature names it. */
export interface SourceLink {
  kind: "jira" | "wiki";
  url: string;
  title: string;
}

/** A body line that would read as the spec's own syntax is escaped, as html.ts does on import. */
function escapeBodyLine(line: string): string {
  if (/^(#|\[test:|\[(?:jira|github|linear|other|qtest|confluence):)/i.test(line)) return `\\${line}`;
  return line;
}

function sourcesLine(sources: SourceLink[]): string {
  const link = (s: SourceLink) => `[${s.title.replace(/[[\]]/g, "")}](${s.url})`;
  const jira = sources.filter((s) => s.kind === "jira").map(link);
  const wiki = sources.filter((s) => s.kind === "wiki").map(link);
  const parts = [jira.length ? `Jira ${jira.join(", ")}` : "", wiki.length ? `Confluence ${wiki.join(", ")}` : ""].filter(
    Boolean,
  );
  return parts.length ? `_Imported from ${parts.join(" and ")}._` : "";
}

/**
 * The Jira issues a feature was read from, as its tickets (specs/external-
 * links/project-management-jira-linear-etc.feature.md "Several tickets on a
 * feature"): one `[Jira:<key>](url)` line each, the key from the source's
 * title (the issue key) or, failing that, from its url; repeats dropped and
 * at most MAX_FEATURE_TICKETS of them — the import's own cap on Jira issues
 * is the same number.
 */
function ticketLines(sources: SourceLink[]): string[] {
  const links: ExternalLink[] = [];
  for (const s of sources) {
    if (s.kind !== "jira") continue;
    const key = /^[A-Z][A-Z0-9_]*-\d+$/i.test(s.title.trim())
      ? s.title.trim().toUpperCase()
      : parseJiraIssueUrl(s.url)?.key;
    if (key) links.push({ program: "Jira", ticket: key, url: s.url });
  }
  return dedupeTicketLinks(links).slice(0, MAX_FEATURE_TICKETS).map(formatExternalLink);
}

/**
 * The feature file the review step creates: the title, the Jira issues as
 * its tickets, where it came from, and each scenario as a proposed one —
 * `## S<n>: <name> @v1 [proposed]`, numbered in the order the agent gave
 * them — with its body, its sources named on a last line. Names are cleaned
 * of what the heading syntax would misread and repeats are told apart.
 */
export function planImportedFeature(
  title: string,
  scenarios: { name: string; body: string; sources?: string[] }[],
  sources: SourceLink[],
): { name: string; text: string } {
  const name = cleanName(title) || "Imported feature";
  const seen = new Map<string, number>();
  // Numbered headings: an unnumbered file is read in name order
  // (src/server/parser.ts sortScenarios), which would lose the order of
  // importance the agent gave the scenarios.
  const blocks = scenarios.map((s, i) => {
    let heading = cleanName(s.name) || "Scenario";
    const n = (seen.get(heading.toLowerCase()) ?? 0) + 1;
    seen.set(heading.toLowerCase(), n);
    if (n > 1) heading = `${heading} (${n})`;
    const body = s.body
      .split("\n")
      .map((l) => escapeBodyLine(l.trimEnd()))
      .join("\n")
      .trim();
    const from = (s.sources ?? []).filter(Boolean);
    const lines = [`## S${i + 1}: ${heading} @v1 [proposed]`, ""];
    if (body) lines.push(body, "");
    if (from.length) lines.push(`_From ${from.join(", ")}._`, "");
    return lines.join("\n");
  });
  const intro = sourcesLine(sources);
  const tickets = ticketLines(sources);
  const text = [`# ${name}`, "", ...(tickets.length ? [...tickets, ""] : []), ...(intro ? [intro, ""] : []), ...blocks]
    .join("\n")
    .replace(/\n+$/, "\n");
  return { name, text };
}
