// Automates specs/ui/navigation.feature.md "reorder scenarios by dragging
// them in the tree": where a scenario dropped on another row of its feature's
// outline lands, as the from / to pair the save moves it by.
import { expect, test } from "bun:test";
import { withScenarioMoved } from "../src/frontend/App";
import { scenarioDrop } from "../src/frontend/tree";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version = 1, status: Scenario["status"] = "proposed"): Scenario => ({
  name,
  version,
  status,
  body: "",
  tests: [],
});
const ref = (name: string, version = 1) => ({ name, version });

const feature = (...scenarios: Scenario[]): Feature => ({ name: "F", description: "", scenarios });
const dropped = (f: Feature, dragged: string, target: string, after: boolean) => {
  const move = scenarioDrop(f.scenarios, ref(dragged), ref(target), after);
  return move ? withScenarioMoved(f, move.from, move.to).scenarios.map((s) => s.name) : null;
};

test("a scenario dropped on the upper half of a row lands just before it", () => {
  const f = feature(sc("A"), sc("B"), sc("C"), sc("D"));
  expect(dropped(f, "D", "B", false)).toEqual(["A", "D", "B", "C"]);
  expect(dropped(f, "A", "C", false)).toEqual(["B", "A", "C", "D"]);
  expect(dropped(f, "C", "A", false)).toEqual(["C", "A", "B", "D"]);
});

test("a scenario dropped on the lower half of a row lands just after it", () => {
  const f = feature(sc("A"), sc("B"), sc("C"), sc("D"));
  expect(dropped(f, "A", "C", true)).toEqual(["B", "C", "A", "D"]);
  expect(dropped(f, "A", "D", true)).toEqual(["B", "C", "D", "A"]);
  expect(dropped(f, "D", "A", true)).toEqual(["A", "D", "B", "C"]);
});

test("a drop that leaves the scenario where it was is no move", () => {
  const f = feature(sc("A"), sc("B"), sc("C"));
  expect(scenarioDrop(f.scenarios, ref("B"), ref("B"), false)).toBeNull();
  expect(scenarioDrop(f.scenarios, ref("B"), ref("B"), true)).toBeNull();
  // Just after the row above it, or just before the row below it.
  expect(scenarioDrop(f.scenarios, ref("B"), ref("A"), true)).toBeNull();
  expect(scenarioDrop(f.scenarios, ref("B"), ref("C"), false)).toBeNull();
});

test("scenarios are found by name and version, so a draft between them keeps its place", () => {
  // Another feature's outline lists no drafts; its server copy does.
  const f = feature(sc("A"), sc("A", 2), sc("Wip", 1, "draft"), sc("B"));
  expect(dropped(f, "B", "A", false)).toEqual(["B", "A", "A", "Wip"]);
  const move = scenarioDrop(f.scenarios, ref("A", 2), ref("B"), true);
  expect(move).toEqual({ from: 1, to: 3 });
  expect(withScenarioMoved(f, move!.from, move!.to).scenarios.map((s) => `${s.name} v${s.version}`)).toEqual([
    "A v1",
    "Wip v1",
    "B v1",
    "A v2",
  ]);
});

test("a scenario no longer in the feature moves nothing", () => {
  const f = feature(sc("A"), sc("B"));
  expect(scenarioDrop(f.scenarios, ref("Gone"), ref("A"), false)).toBeNull();
  expect(scenarioDrop(f.scenarios, ref("A"), ref("B", 2), true)).toBeNull();
});
