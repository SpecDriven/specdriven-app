// Automates specs/ui/navigation.feature.md "Scenario navigation": the sidebar
// tree lists a feature's scenarios under it, so a scenario editor pane can
// switch to another scenario without going back to the feature view.
//
// The listing already carries every feature's scenarios, so the outline needs
// no fetch of its own — but the listing only refreshes on start and on the
// reload cron, while a save lands in the open feature first. Which of the two
// a row reads from is what `scenarioRows` decides.
import { describe, expect, test } from "bun:test";
import {
  buildTree,
  scenarioNeighbors,
  scenarioRows,
  scenarioSequence,
  withOpenScenarios,
} from "../src/frontend/tree";
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

// The scenario editor's `<` and `>` (and their keys) step through every
// scenario in the tree, in the order the sidebar lists them — crossing from
// the last scenario of one feature to the first of the next.
describe("stepping through every scenario from the editor", () => {
  const billing = listing("specs/billing/collect-premium.feature.md", [
    sc("autopay succeeds", 1),
    sc("failed autopay starts the grace period", 1, "published"),
  ]);
  const claims = listing("specs/claims.feature.md", [sc("file a claim", 1)]);
  // Listed out of order on purpose: the tree sorts folders before features.
  const tree = buildTree(["specs/billing"], [claims, billing, nav]);
  const seq = scenarioSequence(tree, null, null);
  const names = (s: ReturnType<typeof scenarioSequence>) => s.map((x) => x.scenario.name);

  test("the walk follows the tree: folders first, then features by name, each in file order", () => {
    expect(names(seq)).toEqual([
      "autopay succeeds",
      "failed autopay starts the grace period",
      "file a claim",
      "open a feature link",
      "open a scenario link",
      "share a link",
    ]);
    expect(seq[2]!.file).toBe(claims.fileName);
  });

  test("the open feature contributes its live scenarios, drafts included", () => {
    const live = openFeature([sc("file a claim", 1), sc("a new draft", 1, "draft")]);
    expect(names(scenarioSequence(tree, claims.fileName, live))).toContain("a new draft");
  });

  test("the neighbours cross from one feature into the next", () => {
    const { prev, next } = scenarioNeighbors(seq, claims.fileName, { name: "file a claim", version: 1 });
    expect(prev).toEqual({ file: billing.fileName, scenario: billing.scenarios[1]! });
    expect(next).toEqual({ file: nav.fileName, scenario: nav.scenarios[0]! });
  });

  test("the first scenario has no previous, the last no next", () => {
    expect(scenarioNeighbors(seq, billing.fileName, { name: "autopay succeeds", version: 1 }).prev).toBeNull();
    expect(scenarioNeighbors(seq, nav.fileName, { name: "share a link", version: 2 }).next).toBeNull();
  });

  test("a scenario that isn't in the tree yet — new, never saved — has neither", () => {
    expect(scenarioNeighbors(seq, nav.fileName, { name: "untitled", version: 1 })).toEqual({
      prev: null,
      next: null,
    });
  });

  test("a scenario is told apart from its other versions", () => {
    const versions = buildTree([], [
      listing("specs/v.feature.md", [sc("x", 1, "published"), sc("x", 2)]),
    ]);
    const s = scenarioSequence(versions, null, null);
    expect(scenarioNeighbors(s, "specs/v.feature.md", { name: "x", version: 2 }).prev?.scenario.version).toBe(1);
  });
});
