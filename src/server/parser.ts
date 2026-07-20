// Feature files are markdown, named `<slug>.feature.md`
// (specs/crud-feature.spec.md):
//
//   # <name of the feature>
//
//   <optional feature description — any markdown>
//
//   ## <name of scenario> vNNN              (draft, editable; NNN positive int)
//   ## <name of scenario> vNNN [proposed]   (saved, not yet published)
//   ## <name of scenario> vNNN [published]  (published, immutable)
//
//   <scenario body — any markdown up to the next scenario heading;
//    Gherkin tables are written as markdown tables>
//
// The first `#` heading is the feature name; a `##` heading that ends with a
// version starts a scenario. Scenarios are atomic, immutable, and versioned.
// `##` headings without a version, and headings inside fenced code blocks
// (``` or ~~~), are ordinary content, not scenario boundaries.

export interface Scenario {
  name: string;
  version: number;
  published: boolean;
  proposed: boolean;
  body: string;
}

export interface Feature {
  name: string;
  /** Free markdown between the feature heading and the first scenario. */
  description: string;
  scenarios: Scenario[];
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

const FEATURE_RE = /^#\s+(.+?)\s*$/;
const SCENARIO_RE = /^##\s+(.+?)\s+v([1-9]\d*)(?:\s+\[(published|proposed|saved)\])?\s*$/;
/** Feature files written before the bracket syntax: ``## <name> `v1` `published` ``. */
const LEGACY_SCENARIO_RE = /^##\s+(.+?)\s+`v([1-9]\d*)`(?:\s+`(published|proposed|saved)`)?\s*$/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

type Status = "published" | "proposed" | null;

interface HeadingMatch {
  name: string;
  version: number;
  status: Status;
}

/**
 * Read a scenario heading in either the current or the legacy chip syntax.
 * `saved` is the old name of the proposed state — still read, written back
 * as `proposed` (specs/crud-feature.spec.md "Feature file format").
 */
function matchScenario(line: string): HeadingMatch | null {
  const m = line.match(LEGACY_SCENARIO_RE) ?? line.match(SCENARIO_RE);
  if (!m) return null;
  return {
    name: m[1]!,
    version: Number(m[2]),
    status:
      m[3] === "published"
        ? "published"
        : m[3] === "proposed" || m[3] === "saved"
          ? "proposed"
          : null,
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

export function parseFeature(text: string): Feature {
  let name = "";
  const preamble: string[] = [];
  const scenarios: Scenario[] = [];
  let current: Scenario | null = null;
  const bodyLines: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
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
          published: scenarioMatch.status === "published",
          proposed: scenarioMatch.status === "proposed",
          body: "",
        };
        continue;
      }
    }
    if (current) bodyLines.push(line);
    else preamble.push(line);
  }
  flush();

  return { name, description: preamble.join("\n").trim(), scenarios: sortScenarios(scenarios) };
}

function header(name: string, version: number, status: Status): string {
  const chip = status ? ` [${status}]` : "";
  return `## ${name} v${version}${chip}`;
}

export function serializeFeature(feature: Feature): string {
  const parts = [`# ${feature.name}`];
  if (feature.description) parts.push(feature.description);
  for (const s of feature.scenarios) {
    const h = header(s.name, s.version, s.published ? "published" : s.proposed ? "proposed" : null);
    parts.push(s.body ? `${h}\n\n${s.body}` : h);
  }
  return parts.join("\n\n") + "\n";
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
 * are left alone. Legacy headings are normalized to the bracket syntax, and
 * old [saved] chips to [proposed].
 */
function rewriteHeaders(text: string, next: (m: HeadingMatch) => Status): string {
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
 * already-[published] headings stay as they are.
 */
export function markPublished(text: string): string {
  return rewriteHeaders(text, () => "published");
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
 * pushed to GitHub"). [published] and [proposed] headings are untouched.
 */
export function markProposed(text: string): string {
  return rewriteHeaders(text, (m) => m.status ?? "proposed");
}
