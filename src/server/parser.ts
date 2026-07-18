// Feature file format per specs/crud-feature.spec.md:
//
//   Feature: <name of the feature>
//
//   Scenario: <name of scenario> @vNNN   (NNN is a positive integer)
//   <scenario body> (any text, may include Gherkin tables)
//
// Scenarios are atomic, immutable, and versioned.

export interface Scenario {
  name: string;
  version: number;
  body: string;
}

export interface Feature {
  name: string;
  scenarios: Scenario[];
}

const FEATURE_RE = /^(?:Feature|name):\s*(.+)\s*$/;
const SCENARIO_RE = /^Scenario:\s*(.+?)\s*@v([1-9]\d*)\s*$/;

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
      current = { name: scenarioMatch[1]!, version: Number(scenarioMatch[2]), body: "" };
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
    parts.push(`Scenario: ${s.name} @v${s.version}\n${s.body}`.trimEnd());
  }
  return parts.join("\n\n") + "\n";
}
