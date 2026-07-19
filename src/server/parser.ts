// Feature files are markdown, named `<slug>.feature.md`
// (specs/crud-feature.spec.md):
//
//   # <name of the feature>
//
//   <optional feature description — any markdown>
//
//   ## <name of scenario> vNNN              (draft, editable; NNN positive int)
//   ## <name of scenario> vNNN [saved]      (auto-saved, not yet published)
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
  saved: boolean;
  body: string;
}

export interface Feature {
  name: string;
  /** Free markdown between the feature heading and the first scenario. */
  description: string;
  scenarios: Scenario[];
}

const FEATURE_RE = /^#\s+(.+?)\s*$/;
const SCENARIO_RE = /^##\s+(.+?)\s+v([1-9]\d*)(?:\s+\[(published|saved)\])?\s*$/;
/** Feature files written before the bracket syntax: ``## <name> `v1` `published` ``. */
const LEGACY_SCENARIO_RE = /^##\s+(.+?)\s+`v([1-9]\d*)`(?:\s+`(published|saved)`)?\s*$/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

type Status = "published" | "saved" | null;

interface HeadingMatch {
  name: string;
  version: number;
  status: Status;
}

/** Read a scenario heading in either the current or the legacy chip syntax. */
function matchScenario(line: string): HeadingMatch | null {
  const m = line.match(LEGACY_SCENARIO_RE) ?? line.match(SCENARIO_RE);
  if (!m) return null;
  return {
    name: m[1]!,
    version: Number(m[2]),
    status: m[3] === "published" || m[3] === "saved" ? m[3] : null,
  };
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
          saved: scenarioMatch.status === "saved",
          body: "",
        };
        continue;
      }
    }
    if (current) bodyLines.push(line);
    else preamble.push(line);
  }
  flush();

  return { name, description: preamble.join("\n").trim(), scenarios };
}

function header(name: string, version: number, status: Status): string {
  const chip = status ? ` [${status}]` : "";
  return `## ${name} v${version}${chip}`;
}

export function serializeFeature(feature: Feature): string {
  const parts = [`# ${feature.name}`];
  if (feature.description) parts.push(feature.description);
  for (const s of feature.scenarios) {
    const h = header(s.name, s.version, s.published ? "published" : s.saved ? "saved" : null);
    parts.push(s.body ? `${h}\n\n${s.body}` : h);
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Rewrite every scenario heading's status chip with the value chosen by
 * `next`. Works on the raw text line-by-line so body content that doesn't fit
 * the parse model survives untouched, and headings inside fenced code blocks
 * are left alone. Legacy headings are normalized to the bracket syntax.
 */
function rewriteHeaders(text: string, next: (status: Status) => Status): string {
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
      return header(m.name, m.version, next(m.status));
    })
    .join("\n");
}

/**
 * Mark every scenario heading as published: a [saved] chip is upgraded and
 * already-[published] headings stay as they are.
 */
export function markPublished(text: string): string {
  return rewriteHeaders(text, () => "published");
}

/**
 * Mark every unmarked scenario heading with a [saved] chip
 * (specs/crud-feature.spec.md, "Scenario is automatically saved locally and
 * pushed to GitHub"). [published] and [saved] headings are untouched.
 */
export function markSaved(text: string): string {
  return rewriteHeaders(text, (status) => status ?? "saved");
}
