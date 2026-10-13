// Automates specs/app/custom-attributes.feature.md "Filter features and
// scenarios by attribute": the sidebar filter (src/frontend/treeFilter.ts)
// by custom attribute, a scenario inheriting its feature's, alongside the
// status and assignee filters.

import { describe, expect, test } from "bun:test";
import {
  NO_FILTER,
  attributeFilterGroups,
  attributeFilterLabel,
  featureMatches,
  isFiltering,
  sameAttributeFilter,
  scenarioMatches,
  type TreeFilter,
} from "../src/frontend/treeFilter";
import { EXAMPLE_ATTRIBUTE_DEFINITIONS, parseAttributeDefinitions } from "../src/server/customAttributes";
import type { SpecAttribute } from "../src/server/parser";

const DEFS = parseAttributeDefinitions(`${EXAMPLE_ATTRIBUTE_DEFINITIONS}\n[line:auto|home]\n  label: Line of business\n`);
const good = (value: string): SpecAttribute => ({ key: "br", names: ["good-driver-discount"], value });

const QUOTE = {
  attributes: [{ key: "line", names: [], value: "auto" }],
  scenarios: [
    { status: "published" as const, attributes: [good("on")] },
    { status: "proposed" as const, attributes: [good("off")] },
    { status: "proposed" as const },
  ],
};
const BIND = { assigned: "Ada", scenarios: [{ status: "published" as const }] };

const by = (attribute: TreeFilter["attribute"], more: Partial<TreeFilter> = {}): TreeFilter => ({
  ...NO_FILTER,
  attribute,
  ...more,
});

describe("filtering by attribute", () => {
  test("a scenario matches by its own attributes or its feature's", () => {
    const on = by({ key: "br", names: ["good-driver-discount"], value: "on" });
    expect(QUOTE.scenarios.map((s) => scenarioMatches(s, QUOTE, on))).toEqual([true, false, false]);
    const anyRule = by({ key: "br", names: [] });
    expect(QUOTE.scenarios.map((s) => scenarioMatches(s, QUOTE, anyRule))).toEqual([true, true, false]);
    // The feature's line of business is every scenario's.
    const auto = by({ key: "line", names: [], value: "auto" });
    expect(QUOTE.scenarios.every((s) => scenarioMatches(s, QUOTE, auto))).toBe(true);
    // With a status too, both must hold.
    const proposedOn = by({ key: "br", names: ["good-driver-discount"], value: "on" }, { status: "proposed" });
    expect(QUOTE.scenarios.map((s) => scenarioMatches(s, QUOTE, proposedOn))).toEqual([false, false, false]);
  });

  test("a feature matches when it or a scenario of it carries the attribute, and by assignee", () => {
    const on = by({ key: "br", names: ["good-driver-discount"], value: "on" });
    expect(featureMatches(QUOTE, on)).toBe(true);
    expect(featureMatches(BIND, on)).toBe(false);
    expect(featureMatches({ attributes: QUOTE.attributes, scenarios: [] }, by({ key: "line", names: [] }))).toBe(true);
    expect(featureMatches(BIND, { ...NO_FILTER, assignee: "Ada" })).toBe(true);
    expect(featureMatches(QUOTE, { ...NO_FILTER, assignee: "Ada" })).toBe(false);
    expect(featureMatches(QUOTE, NO_FILTER)).toBe(true);
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering(on)).toBe(true);
  });

  test("the menu has an entry per key with any, each attribute, and each with its value", () => {
    const groups = attributeFilterGroups([QUOTE, BIND], DEFS);
    expect(groups.map((g) => g.label)).toEqual(["Business rule", "Line of business"]);
    expect(groups[0]!.items.map((i) => i.label)).toEqual([
      "Any business rule",
      "good-driver-discount",
      "good-driver-discount = off",
      "good-driver-discount = on",
    ]);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(["Any line of business", "auto"]);
    expect(groups[0]!.items[3]!.filter).toEqual({ key: "br", names: ["good-driver-discount"], value: "on" });
    expect(sameAttributeFilter(groups[0]!.items[3]!.filter, { key: "br", names: ["good-driver-discount"], value: "on" })).toBe(true);
    expect(sameAttributeFilter(groups[0]!.items[1]!.filter, groups[0]!.items[3]!.filter)).toBe(false);
  });

  test("the active filter reads by its label", () => {
    expect(attributeFilterLabel({ key: "br", names: ["good-driver-discount"], value: "on" }, DEFS)).toBe(
      "Business rule good-driver-discount = on",
    );
    expect(attributeFilterLabel({ key: "br", names: [] }, DEFS)).toBe("Any business rule");
    expect(attributeFilterLabel({ key: "x", names: ["a"] })).toBe("x a");
  });
});
