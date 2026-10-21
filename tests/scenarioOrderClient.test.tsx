// specs/ui/ui.feature.md "Number scenarios and move them up or down": the
// editor's pure helpers behind the numbers and Move up / Move down.
import { expect, test } from "bun:test";
import { scenarioNumbers, withScenario, withScenarioMoved } from "../src/frontend/App";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, status: Scenario["status"] = "proposed"): Scenario => ({
  name,
  version: 1,
  status,
  body: "",
  tests: [],
});

const feature = (...scenarios: Scenario[]): Feature => ({ name: "F", description: "", scenarios });
const names = (f: Feature) => f.scenarios.map((s) => s.name);

test("withScenario keeps the order, replacing in place, inserting at insertAt, else appending", () => {
  const f = feature(sc("Zed"), sc("Alpha"));
  expect(names(withScenario(f, null, sc("Mid")))).toEqual(["Zed", "Alpha", "Mid"]);
  expect(names(withScenario(f, null, sc("Mid"), 1))).toEqual(["Zed", "Mid", "Alpha"]);
  expect(names(withScenario(f, null, sc("Mid"), 99))).toEqual(["Zed", "Alpha", "Mid"]);
  expect(names(withScenario(f, 0, sc("Zed renamed")))).toEqual(["Zed renamed", "Alpha"]);
});

test("withScenarioMoved moves one scenario and leaves the rest in order", () => {
  const f = feature(sc("A"), sc("B"), sc("C"));
  expect(names(withScenarioMoved(f, 2, 1))).toEqual(["A", "C", "B"]);
  expect(names(withScenarioMoved(f, 0, 1))).toEqual(["B", "A", "C"]);
  expect(withScenarioMoved(f, 0, -1)).toBe(f);
  expect(withScenarioMoved(f, 2, 3)).toBe(f);
  expect(withScenarioMoved(f, 1, 1)).toBe(f);
});

test("scenarioNumbers counts the scenarios the file holds and skips drafts", () => {
  expect(scenarioNumbers([sc("A"), sc("D", "draft"), sc("B", "published"), sc("E", "draft")])).toEqual([
    1,
    null,
    2,
    null,
  ]);
  expect(scenarioNumbers([])).toEqual([]);
});
