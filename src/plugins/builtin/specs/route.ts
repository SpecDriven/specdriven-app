// The Specs tab's urls (specs/ui/navigation.feature.md "URL scheme"):
//
//   /features/<path>                                   a feature's page
//   /features/<path>/scenarios/<slug>[/v<N>]           a scenario's page
//
// parsed by src/frontend/route.ts, which stays core: a desktop link's folder
// is told apart from its page by it whether Specs is on or not.

import { featurePath, parseRoute, type ScenarioRef } from "../../../frontend/route";

/** A Specs view: the feature open in the pane, and the scenario a link named. */
export interface SpecsView {
  /** The feature's file name, `specs/<path>.feature.md`. */
  feature: string;
  /** The scenario a link opens on its page; absent for the feature's page. */
  scenario?: ScenarioRef | null;
}

/** The view a url names, or null when it is not a feature's url. */
export function matchSpecsRoute(pathname: string): SpecsView | null {
  const route = parseRoute(pathname);
  if (!route.feature) return null;
  return route.scenario ? { feature: route.feature, scenario: route.scenario } : { feature: route.feature };
}

/** The url of a view — the inverse of matchSpecsRoute. */
export function specsPath(view: SpecsView): string {
  const base = featurePath(view.feature);
  if (!view.scenario) return base;
  const { slug, version } = view.scenario;
  return `${base}/scenarios/${slug}${version === undefined ? "" : `/v${version}`}`;
}
