// What an OpenSpec spec becomes in the spec tree (specs/external-links/
// openspec-import.feature.md): OpenSpec (openspec.dev) keeps a project's
// current behaviour as `openspec/specs/<capability>/spec.md` in the code
// repository — a `## Purpose`, then `### Requirement: <name>` sections each
// holding a SHALL statement and `#### Scenario: <name>` sections of
// GIVEN/WHEN/THEN bullets. One capability becomes one feature: the purpose
// its description, each OpenSpec scenario a proposed scenario named after
// its requirement and itself, the requirement's statement quoted on top.
//
// Only `openspec/specs` is read. `openspec/changes` — proposals, delta specs
// and the archive — is work in flight, not the current behaviour, and is
// never looked at.
//
// The parser and planner are pure; findOpenSpecSpecs reads the folder with
// Node APIs only, so this also runs under Electron (src/server/run.ts).

import { readdir, stat } from "node:fs/promises";
import { cleanName } from "./jiraWikiImport";
import { repoPath } from "./files";

/** Where OpenSpec keeps the current specs, relative to the repository. */
export const OPENSPEC_SPECS_DIR = "openspec/specs";
/** The file name of each capability's spec. */
const SPEC_FILE = "spec.md";
/** How deep capability folders are looked for (they rarely nest at all). */
const MAX_DEPTH = 6;

export interface OpenSpecScenario {
  name: string;
  /** The scenario's markdown, as written under its heading. */
  body: string;
}

export interface OpenSpecRequirement {
  /** "" for scenarios written before any requirement. */
  name: string;
  /** The requirement's own text — its SHALL statement — before its first scenario. */
  statement: string;
  scenarios: OpenSpecScenario[];
}

export interface OpenSpecDoc {
  /** The `# ` title, if any. */
  title: string;
  /** The `## Purpose` text. */
  purpose: string;
  /** Other top-level sections (not Purpose, not Requirements), heading and text. */
  sections: { heading: string; text: string }[];
  requirements: OpenSpecRequirement[];
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const REQUIREMENT_RE = /^requirement\s*:\s*(.*)$/i;
const SCENARIO_RE = /^scenario\s*:\s*(.*)$/i;

/** Text lines with the blank lines at either end dropped. */
function trimLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .join("\n");
}

/**
 * An OpenSpec spec.md, read into its parts. Lenient: a spec without a
 * `## Requirements` heading still has its `### Requirement:` sections read,
 * a heading inside a code fence is text, and a heading that is neither a
 * requirement nor a scenario stays in the text it sits in.
 */
export function parseOpenSpec(text: string): OpenSpecDoc {
  const doc: OpenSpecDoc = { title: "", purpose: "", sections: [], requirements: [] };
  type Sink = { lines: string[]; done: (text: string) => void };
  let sink: Sink | null = null;
  /** Inside `## Requirements`, where any `###` heading starts a requirement. */
  let inRequirements = false;
  let requirement: OpenSpecRequirement | null = null;
  let fence: string | null = null;

  const flush = () => {
    if (sink) sink.done(trimLines(sink.lines));
    sink = null;
  };
  const startRequirement = (name: string) => {
    flush();
    requirement = { name, statement: "", scenarios: [] };
    doc.requirements.push(requirement);
    const r = requirement;
    sink = { lines: [], done: (t) => (r.statement = t) };
  };
  const startScenario = (name: string) => {
    flush();
    if (!requirement) {
      requirement = { name: "", statement: "", scenarios: [] };
      doc.requirements.push(requirement);
    }
    const s: OpenSpecScenario = { name, body: "" };
    requirement.scenarios.push(s);
    sink = { lines: [], done: (t) => (s.body = t) };
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMark = FENCE_RE.exec(raw)?.[1];
    if (fence) {
      if (fenceMark === fence) fence = null;
      sink?.lines.push(raw);
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      sink?.lines.push(raw);
      continue;
    }
    const h = HEADING_RE.exec(raw);
    if (!h) {
      sink?.lines.push(raw);
      continue;
    }
    const level = h[1]!.length;
    const heading = h[2]!.trim();
    const asRequirement = REQUIREMENT_RE.exec(heading);
    const asScenario = SCENARIO_RE.exec(heading);
    if (level === 1 && !doc.title) {
      flush();
      doc.title = heading;
      continue;
    }
    if (level === 2) {
      flush();
      requirement = null;
      inRequirements = /^requirements$/i.test(heading);
      if (inRequirements) continue;
      if (/^purpose$/i.test(heading)) {
        sink = { lines: [], done: (t) => (doc.purpose = doc.purpose ? `${doc.purpose}\n\n${t}` : t) };
      } else {
        const section = { heading, text: "" };
        doc.sections.push(section);
        sink = { lines: [], done: (t) => (section.text = t) };
      }
      continue;
    }
    if (level === 3 && (asRequirement || inRequirements)) {
      startRequirement(asRequirement ? asRequirement[1]!.trim() : heading);
      continue;
    }
    if (level >= 3 && asScenario) {
      startScenario(asScenario[1]!.trim());
      continue;
    }
    // Any other heading is part of the text it sits in.
    sink?.lines.push(raw);
  }
  flush();
  return doc;
}

/** How many scenarios the feature will hold: one per OpenSpec scenario, one per requirement without any. */
export function scenarioCount(doc: OpenSpecDoc): number {
  return doc.requirements.reduce((n, r) => n + (r.scenarios.length || (r.name || r.statement ? 1 : 0)), 0);
}

// --- Markdown that the feature parser takes as written --------------------------

/** Lines of `**Assigned:**` and the like that the feature parser lifts out of a body. */
const META_LINE_RE =
  /^\s{0,3}\*\*(Assigned|Created by|Updated by|Status|Kind|Author|Date|Supersedes):\*\*/i;
/** `[test: …]`, `[ff:…]`, `[br:…]`, `[Jira:…](…)`, `[negative]`: lines the parser reads as metadata. */
const BRACKET_LINE_RE = /^\s*\[(?:[^\]\n]*:|negative\])/i;

/**
 * OpenSpec markdown as a body or description the feature parser leaves
 * alone: a heading becomes bold text (a `##` line would start a scenario),
 * and lines it would lift out as test links, flags, attributes, tickets or
 * authorship are escaped. Fenced code is left as it is.
 */
export function safeMarkdown(text: string): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const mark = FENCE_RE.exec(line)?.[1];
      if (fence) {
        if (mark === fence) fence = null;
        return line;
      }
      if (mark) {
        fence = mark;
        return line;
      }
      const h = HEADING_RE.exec(line);
      if (h) return h[2] ? `**${h[2]}**` : "";
      if (BRACKET_LINE_RE.test(line)) return line.replace(/^(\s*)\[/, "$1\\[");
      if (META_LINE_RE.test(line)) return line.replace(/^(\s*)\*/, "$1\\*");
      return line;
    })
    .join("\n");
}

/** A statement as a markdown quote. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

// --- The plan ----------------------------------------------------------------------

/**
 * A capability folder's name as a feature name: "user-auth" → "User Auth".
 * Its slug is the folder's own, so the same capability always lands on the
 * same file — which is how a second import knows it is already there.
 */
export function featureNameFromCapability(capability: string): string {
  const last = capability.split("/").filter(Boolean).pop() ?? "";
  const words = last.split(/[-_\s]+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Imported spec";
}

export interface OpenSpecImportPlan {
  /** Where createFeature puts it, relative to the chosen folder: the capability's parent folders and the name. */
  name: string;
  /** The whole `.feature.md`. */
  text: string;
  /** The scenario headings, in order. */
  scenarios: string[];
}

/**
 * The feature file one capability becomes. `relPath` is the spec's path in
 * the code repository, named in the line that says where it came from.
 */
export function planOpenSpecImport(capability: string, relPath: string, specText: string): OpenSpecImportPlan {
  const doc = parseOpenSpec(specText);
  const name = featureNameFromCapability(capability);
  const parents = capability.split("/").filter(Boolean).slice(0, -1);
  const parts = [`# ${name}`, `_Imported from OpenSpec \`${relPath}\`._`];
  const description = [
    doc.purpose,
    ...doc.sections.filter((s) => s.text).map((s) => `**${s.heading}**\n\n${s.text}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (description) parts.push(safeMarkdown(description));

  const scenarios: string[] = [];
  const taken = new Map<string, number>();
  const heading = (raw: string) => {
    let h = cleanName(raw) || `Scenario ${scenarios.length + 1}`;
    const n = (taken.get(h.toLowerCase()) ?? 0) + 1;
    taken.set(h.toLowerCase(), n);
    if (n > 1) h = `${h} (${n})`;
    scenarios.push(h);
    // Numbered, so the file keeps OpenSpec's order (an unnumbered file is
    // read in name order — parser.ts sortScenarios).
    return `## S${scenarios.length}: ${h} @v1 [proposed]`;
  };
  for (const req of doc.requirements) {
    const reqName = cleanName(req.name);
    if (req.scenarios.length === 0) {
      if (!reqName && !req.statement) continue;
      parts.push(heading(reqName || "Requirement"));
      if (req.statement) parts.push(safeMarkdown(req.statement));
      continue;
    }
    for (const s of req.scenarios) {
      const scenarioName = cleanName(s.name);
      parts.push(heading([reqName, scenarioName].filter(Boolean).join(" - ")));
      if (req.statement) parts.push(quote(safeMarkdown(req.statement)));
      if (s.body) parts.push(safeMarkdown(s.body));
    }
  }
  return {
    name: [...parents, name].join("/"),
    text: parts.join("\n\n") + "\n",
    scenarios,
  };
}

// --- The folder --------------------------------------------------------------------

/** One capability's spec in the code repository. */
export interface OpenSpecFile {
  /** The capability folder under openspec/specs, `/` separated ("auth", "billing/invoices"). */
  capability: string;
  /** The spec's path relative to the repository. */
  path: string;
}

/**
 * Every capability spec under `<root>/openspec/specs`, in name order: each
 * folder holding a `spec.md`. Hidden folders and links are not followed.
 * Empty when the repository has no OpenSpec specs folder.
 */
export async function findOpenSpecSpecs(root: string): Promise<OpenSpecFile[]> {
  const base = repoPath(root, OPENSPEC_SPECS_DIR);
  const info = await stat(base).catch(() => null);
  if (!info?.isDirectory()) return [];
  const found: OpenSpecFile[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(rel ? `${base}/${rel}` : base, { withFileTypes: true }).catch(() => []);
    if (rel && entries.some((e) => e.isFile() && e.name === SPEC_FILE)) {
      found.push({ capability: rel, path: `${OPENSPEC_SPECS_DIR}/${rel}/${SPEC_FILE}` });
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk("", 0);
  return found.sort((a, b) => a.capability.localeCompare(b.capability));
}
