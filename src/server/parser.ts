// Feature file format per specs/crud-feature.spec.md:
//
//   Feature: <name of the feature>
//
//   Scenario: <name of scenario> @vNNN   (NNN is a positive integer)
//   Scenario: <name of scenario> @vNNN [pub]   (published scenario)
//   Scenario: <name of scenario> @vNNN [saved]   (saved, not yet published)
//   <scenario body> (any text, may include Gherkin tables)
//
// Scenarios are atomic, immutable, and versioned. A published scenario is
// marked with [pub] after the version and may no longer change. [saved]
// marks a scenario that was auto-saved but not published.

export interface Scenario {
  name: string;
  version: number;
  published: boolean;
  saved: boolean;
  body: string;
}

export interface Feature {
  name: string;
  scenarios: Scenario[];
}

const FEATURE_RE = /^(?:Feature|name):\s*(.+)\s*$/;
const SCENARIO_RE = /^Scenario:\s*(.+?)\s*@v([1-9]\d*)\s*(\[pub\]|\[saved\])?\s*$/;

export function parseFeature(text: string): Feature {
  let name = "";
  const scenarios: Scenario[] = [];
  let current: Scenario | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      scenarios.push(current);
      bodyLines.length = 0;
    }
  };

  for (const line of text.split("\n")) {
    const featureMatch = line.match(FEATURE_RE);
    if (featureMatch && !name && !current) {
      name = featureMatch[1]!;
      continue;
    }
    const scenarioMatch = line.match(SCENARIO_RE);
    if (scenarioMatch) {
      flush();
      current = {
        name: scenarioMatch[1]!,
        version: Number(scenarioMatch[2]),
        published: scenarioMatch[3] === "[pub]",
        saved: scenarioMatch[3] === "[saved]",
        body: "",
      };
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();

  return { name, scenarios };
}

export function serializeFeature(feature: Feature): string {
  const parts = [`Feature: ${feature.name}`];
  for (const s of feature.scenarios) {
    const marker = s.published ? " [pub]" : s.saved ? " [saved]" : "";
    const header = `Scenario: ${s.name} @v${s.version}${marker}`;
    parts.push(`${header}\n${s.body}`.trimEnd());
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Mark every scenario header as published by appending [pub]. Works on the
 * raw text line-by-line so content that doesn't fit the parse model survives
 * untouched; already-published headers are left as they are, and a [saved]
 * marker is upgraded to [pub].
 */
export function markPublished(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(Scenario:\s*.+?\s*@v[1-9]\d*)(?:\s*\[saved\])?\s*$/);
      return m ? `${m[1]} [pub]` : line;
    })
    .join("\n");
}

/**
 * Mark every unmarked scenario header as saved-but-not-published by appending
 * [saved] (specs/crud-feature.spec.md, "Scenario is automatically saved
 * locally and pushed to GitHub"). [pub] and [saved] headers are untouched.
 */
export function markSaved(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(Scenario:\s*.+?\s*@v[1-9]\d*)\s*$/);
      return m ? `${m[1]} [saved]` : line;
    })
    .join("\n");
}
