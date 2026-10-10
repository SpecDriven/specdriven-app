// Automates specs/ui/navigation.feature.md "Scenario navigation": the sidebar
// tree lists a feature's scenarios under it, so a scenario editor pane can
// switch to another scenario without going back to the feature view.
//
// The listing already carries every feature's scenarios, so the outline needs
// no fetch of its own — but the listing only refreshes on start and on the
// reload cron, while a save lands in the open feature first. Which of the two
// a row reads from is what `scenarioRows` decides.
import { describe, expect, test } from "bun:test";
import { scenarioRows, withOpenScenarios } from "../src/frontend/tree";
import type { FeatureListing } from "../src/server/features";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version: number, status: Scenario["status"] = "proposed"): Scenario => ({
  name,
  version,
  status,
  body: "",
  tests: [],
});

const listing = (fileName: string, scenarios: Scenario[]): FeatureListing => ({
  fileName,
  name: fileName,
  scenarios: scenarios.map(({ name, version, status }) => ({ name, version, status })),
});

const nav = listing("specs/navigation.feature.md", [
  sc("open a feature link", 1),
  sc("open a scenario link", 1),
  sc("share a link", 2, "published"),
]);
const other = listing("specs/search.feature.md", [sc("find a scenario", 1, "draft")]);

const openFeature = (scenarios: Scenario[]): Feature => ({
  name: "Navigation",
  description: "",
  scenarios,
});

describe("the scenarios a feature's outline expands to", () => {
  test("a feature nothing is open on reads its listing", () => {
    expect(scenarioRows(nav, null, null)).toEqual([
      { name: "open a feature link", version: 1, status: "proposed" },
      { name: "open a scenario link", version: 1, status: "proposed" },
      { name: "share a link", version: 2, status: "published" },
    ]);
  });

  test("a feature with no scenarios expands to nothing — its row shows no twisty", () => {
    expect(scenarioRows(listing("specs/empty.feature.md", []), null, null)).toEqual([]);
  });

  test("only the open feature reads the live state; the others keep the listing", () => {
    // The open feature has a scenario the listing has not caught up with.
    const live = openFeature([...nav.scenarios.map((s) => sc(s.name, s.version, s.status)), sc("a new draft", 1, "draft")]);
    expect(scenarioRows(nav, nav.fileName, live).map((s) => s.name)).toEqual([
      "open a feature link",
      "open a scenario link",
      "share a link",
      "a new draft",
    ]);
    // A different feature is unaffected by what is open.
    expect(scenarioRows(other, nav.fileName, live).map((s) => s.name)).toEqual([
      "find a scenario",
    ]);
  });

  test("a rename shows in the outline before the listing refreshes", () => {
    const live = openFeature([sc("renamed in the pane", 1), sc("share a link", 2, "published")]);
    expect(scenarioRows(nav, nav.fileName, live).map((s) => s.name)).toEqual([
      "renamed in the pane",
      "share a link",
    ]);
  });

  test("a new version shows as its own row, beside the one it came from", () => {
    const live = openFeature([sc("share a link", 2, "published"), sc("share a link", 3, "draft")]);
    expect(scenarioRows(nav, nav.fileName, live)).toEqual([
      { name: "share a link", version: 2, status: "published" },
      { name: "share a link", version: 3, status: "draft" },
    ]);
  });

  test("with no feature open at all, the open file matching changes nothing", () => {
    expect(scenarioRows(nav, nav.fileName, null)).toEqual(scenarioRows(nav, null, null));
  });

  test("rows carry only what a row renders — no body, no tests", () => {
    const live = openFeature([{ ...sc("open a feature link", 1), body: "text", tests: ["x"] }]);
    expect(scenarioRows(nav, nav.fileName, live)).toEqual([
      { name: "open a feature link", version: 1, status: "proposed" },
    ]);
  });
});

// A scenario deleted in the open feature came back in the tree as soon as
// another feature was opened: the tree then read the left feature from the
// listing, which had not refreshed since. What the open feature holds is
// written into its listing entry, so leaving it changes no rows.
describe("the listing keeps what the open feature holds", () => {
  const all = [nav, other];

  test("a scenario deleted in the open feature stays gone once it is left", () => {
    const live = openFeature([sc("open a feature link", 1), sc("share a link", 2, "published")]);
    const next = withOpenScenarios(all, nav.fileName, live);
    // Another feature is opened: the left one reads from the listing now.
    expect(scenarioRows(next[0]!, other.fileName, null).map((s) => s.name)).toEqual([
      "open a feature link",
      "share a link",
    ]);
    expect(next[1]).toBe(other);
  });

  test("a rename and a new version carry over the same way", () => {
    const live = openFeature([sc("renamed in the pane", 1), sc("share a link", 3)]);
    expect(withOpenScenarios(all, nav.fileName, live)[0]!.scenarios).toEqual([
      { name: "renamed in the pane", version: 1, status: "proposed" },
      { name: "share a link", version: 3, status: "proposed" },
    ]);
  });

  test("a draft stays out, as the server's listing leaves it out", () => {
    const live = openFeature([sc("open a feature link", 1), sc("a new draft", 1, "draft")]);
    expect(withOpenScenarios(all, nav.fileName, live)[0]!.scenarios).toEqual([
      { name: "open a feature link", version: 1, status: "proposed" },
    ]);
  });

  test("an entry that already agrees leaves the listing as it is", () => {
    const live = openFeature(nav.scenarios.map((s) => ({ ...sc(s.name, s.version, s.status), body: "b" })));
    expect(withOpenScenarios(all, nav.fileName, live)).toBe(all);
  });

  test("a file the listing does not hold yet leaves it as it is", () => {
    expect(withOpenScenarios(all, "specs/new.feature.md", openFeature([sc("x", 1)]))).toBe(all);
  });
});
