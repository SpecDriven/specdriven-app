// Deep-link urls (specs/navigation.spec.md):
//
//   /                                               home
//   /features/<feature>                             feature page
//   /features/<feature>/scenarios/<scenario>        latest version of the scenario
//   /features/<feature>/scenarios/<scenario>/v<N>   exactly version N
//
// <feature> is the file stem (file name minus `.feature.md`); <scenario> is
// slugify(scenario name). Parsing is longest-valid-prefix: unrecognized
// trailing segments are ignored, and a path that doesn't start with a known
// shape is home.

import { slugify } from "../server/parser";
import type { Scenario } from "../server/parser";

export interface ScenarioRef {
  slug: string;
  /** Absent means "latest version of this name". */
  version?: number;
}

export interface Route {
  /** Feature file name, with the `.feature.md` suffix restored. */
  feature?: string;
  scenario?: ScenarioRef;
}

const VERSION_SEG = /^v([1-9]\d*)$/;

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== "features" || !segs[1]) return {};
  // Accept a stem that already carries the `.feature.md` (or legacy
  // `.feature`) suffix — hand-edited links shouldn't double it up.
  const stem = segs[1].replace(/\.feature(\.md)?$/, "");
  const route: Route = { feature: `${stem}.feature.md` };
  if (segs[2] !== "scenarios" || !segs[3]) return route;
  route.scenario = { slug: segs[3] };
  const version = segs[4]?.match(VERSION_SEG);
  if (version) route.scenario.version = Number(version[1]);
  return route;
}

export function featurePath(fileName: string): string {
  return `/features/${fileName.replace(/\.feature\.md$/, "")}`;
}

export function scenarioPath(fileName: string, scenario: Scenario): string {
  return `${featurePath(fileName)}/scenarios/${slugify(scenario.name)}/v${scenario.version}`;
}

/**
 * Resolve a scenario ref against a parsed feature: exact version when the ref
 * has one, otherwise the highest version of that name. On slug collisions the
 * first match in file order wins (specs/navigation.spec.md). Returns the
 * scenario's list index, or null if nothing matches.
 */
export function resolveScenario(scenarios: Scenario[], ref: ScenarioRef): number | null {
  let best: number | null = null;
  scenarios.forEach((s, i) => {
    if (slugify(s.name) !== ref.slug) return;
    if (ref.version !== undefined) {
      if (s.version === ref.version && best === null) best = i;
    } else if (best === null || s.version > scenarios[best]!.version) {
      best = i;
    }
  });
  return best;
}
