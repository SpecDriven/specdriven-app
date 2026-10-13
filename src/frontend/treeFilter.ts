// The sidebar's filter (specs/ui/ui.feature.md "Design system",
// specs/app/custom-attributes.feature.md "Filter features and scenarios by
// attribute"): features by scenario status, by assignee and by custom
// attribute. Pure, so it can be tested without the app.
//
// A scenario inherits its feature's attributes, as a Gherkin scenario
// inherits its feature's tags: filtering by a business rule the feature
// carries shows all of the feature's scenarios.

import { attributeLabel, type AttributeDefinitions } from "../server/customAttributes";
import type { Scenario, SpecAttribute } from "../server/parser";

/** An attribute to filter by: its key, a leading run of its names, and its value if one is chosen. */
export interface AttributeFilter {
  key: string;
  names: string[];
  value?: string;
}

export interface TreeFilter {
  status: Scenario["status"] | null;
  assignee: string | null;
  attribute: AttributeFilter | null;
}

export const NO_FILTER: TreeFilter = { status: null, assignee: null, attribute: null };

/** What a filter looks at on a scenario and on a feature — a listing entry or the open feature. */
interface Carrier {
  attributes?: readonly SpecAttribute[];
}
interface ScenarioLike extends Carrier {
  status: Scenario["status"];
}
interface FeatureLike extends Carrier {
  assigned?: string;
  scenarios: readonly ScenarioLike[];
}

/** Whether a list holds an attribute the filter names. */
export function carriesAttribute(list: readonly SpecAttribute[] | undefined, f: AttributeFilter): boolean {
  return (list ?? []).some(
    (a) =>
      a.key === f.key &&
      f.names.every((n, i) => a.names[i] === n) &&
      (f.value === undefined || a.value === f.value),
  );
}

/** Whether a filter is narrowing anything. */
export function isFiltering(filter: TreeFilter): boolean {
  return filter.status !== null || filter.assignee !== null || filter.attribute !== null;
}

/**
 * Whether a scenario card shows: its status matches, and it or its feature
 * carries the attribute. The assignee is the feature's, so it never hides a
 * card.
 */
export function scenarioMatches(s: ScenarioLike, feature: Carrier, filter: TreeFilter): boolean {
  if (filter.status !== null && s.status !== filter.status) return false;
  if (filter.attribute === null) return true;
  return carriesAttribute(s.attributes, filter.attribute) || carriesAttribute(feature.attributes, filter.attribute);
}

/**
 * Whether a feature reads as a match in the tree: its assignee matches, and
 * a scenario of it matches — or, with no status chosen, the feature itself
 * carries the attribute.
 */
export function featureMatches(f: FeatureLike, filter: TreeFilter): boolean {
  if (filter.assignee !== null && f.assigned !== filter.assignee) return false;
  if (filter.status === null && filter.attribute === null) return true;
  if (filter.status === null && carriesAttribute(f.attributes, filter.attribute!)) return true;
  return f.scenarios.some((s) => scenarioMatches(s, f, filter));
}

export interface AttributeFilterItem {
  id: string;
  label: string;
  filter: AttributeFilter;
}

export interface AttributeFilterGroup {
  key: string;
  label: string;
  items: AttributeFilterItem[];
}

const filterId = (f: AttributeFilter) =>
  [f.key, ...f.names].join(":") + (f.value === undefined ? "" : `=${f.value}`);

/**
 * The Filter menu's attribute entries: one per key used in the listing,
 * labelled by its definition, holding "Any …", each attribute the repo uses
 * by its names, and each of those with each value it is set to.
 */
export function attributeFilterGroups(
  features: readonly FeatureLike[],
  defs?: AttributeDefinitions,
): AttributeFilterGroup[] {
  const byKey = new Map<string, Map<string, { names: string[]; values: Set<string> }>>();
  const add = (list: readonly SpecAttribute[] | undefined) => {
    for (const a of list ?? []) {
      const identities = byKey.get(a.key) ?? new Map();
      const identity = a.names.join(":");
      const entry = identities.get(identity) ?? { names: a.names, values: new Set<string>() };
      entry.values.add(a.value);
      identities.set(identity, entry);
      byKey.set(a.key, identities);
    }
  };
  for (const f of features) {
    add(f.attributes);
    for (const s of f.scenarios) add(s.attributes);
  }
  const byText = (a: string, b: string) => a.localeCompare(b);
  return [...byKey.keys()].sort(byText).map((key) => {
    const label = attributeLabel(defs, key);
    const items: AttributeFilterItem[] = [{ id: key, label: `Any ${label.toLowerCase()}`, filter: { key, names: [] } }];
    const identities = [...byKey.get(key)!.values()].sort((a, b) => byText(a.names.join(" "), b.names.join(" ")));
    for (const { names, values } of identities) {
      const shown = names.join(" · ");
      if (names.length > 0) items.push({ id: filterId({ key, names }), label: shown, filter: { key, names } });
      for (const value of [...values].sort(byText)) {
        const filter = { key, names, value };
        items.push({ id: filterId(filter), label: names.length > 0 ? `${shown} = ${value}` : value, filter });
      }
    }
    return { key, label, items };
  });
}

/** Whether two attribute filters are the same. */
export function sameAttributeFilter(a: AttributeFilter | null, b: AttributeFilter | null): boolean {
  return a === b || (a !== null && b !== null && filterId(a) === filterId(b));
}

/** How the active filter chip reads: "Business rule young-driver-surcharge = on". */
export function attributeFilterLabel(f: AttributeFilter, defs?: AttributeDefinitions): string {
  const label = attributeLabel(defs, f.key);
  if (f.names.length === 0 && f.value === undefined) return `Any ${label.toLowerCase()}`;
  return [label, ...f.names].join(" ") + (f.value === undefined ? "" : ` = ${f.value}`);
}
