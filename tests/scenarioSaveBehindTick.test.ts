// A save that meets an autosave tick still on its way — the pane's parting
// save on close or on a folder switch, Propose, or the dialog's Publish —
// goes out after that tick (specs/editor-autosave.feature.md "Autosave Never
// Adds the Same Scenario Twice"). It must be placed where the tick landed
// the scenario, not where the render that queued it thought it was: that
// render's index and (for a new scenario) its missing document id predate
// the tick's answer. Publish used to skip this and PUT from the render.
import { describe, expect, test } from "bun:test";
import { placeScenario, type Placement } from "../src/frontend/App";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version: number, extra: Partial<Scenario> = {}): Scenario => ({
  name,
  version,
  status: "proposed",
  body: "",
  tests: [],
  ...extra,
});

const names = (f: Feature) => f.scenarios.map((s) => `${s.name} v${s.version}`);

describe("a new scenario saved behind a tick still away", () => {
  const before: Feature = { name: "Quote", description: "", scenarios: [sc("Alpha", 1, { id: "a" })] };
  // What the tick sent, and what the render that queues the next save holds:
  // the scenario appended once, with no index and no id yet.
  const typed = sc("Beta", 1, { body: "Given more" });
  const optimistic = placeScenario(sc("Beta", 1), { feature: before, index: null }, true).next;

  test("placed from the render, it goes out a second time under the next version — the bug", () => {
    const { next, s } = placeScenario(typed, { feature: optimistic, index: null }, true);
    expect(names(next)).toEqual(["Alpha v1", "Beta v1", "Beta v2"]);
    expect(s.id).toBeUndefined();
  });

  test("placed where the tick landed, it is one scenario, under its version and its new id", () => {
    const saved: Feature = { ...before, scenarios: [sc("Alpha", 1, { id: "a" }), sc("Beta", 1, { id: "b" })] };
    const landed: Placement = { feature: saved, index: 1, id: "b" };
    const { next, s } = placeScenario(typed, landed, true);
    expect(names(next)).toEqual(["Alpha v1", "Beta v1"]);
    expect(s.id).toBe("b");
    expect(next.scenarios[1]!.body).toBe("Given more");
  });

  test("when the tick failed, it is placed where the scenario was before it, once", () => {
    const { next } = placeScenario(typed, { feature: before, index: null }, true);
    expect(names(next)).toEqual(["Alpha v1", "Beta v1"]);
  });
});

describe("a renamed scenario saved behind a tick still away", () => {
  const before: Feature = {
    name: "Quote",
    description: "",
    scenarios: [sc("Alpha", 1, { id: "a" }), sc("Gamma", 1, { id: "g" }), sc("Gamma", 2, { id: "g2" })],
  };
  // The tick renamed Alpha to Hotel: in canonical order it moved to the end,
  // while the editor's index still says 0.
  const renamed = sc("Hotel", 1, { id: "a", body: "Given more" });
  const optimistic = placeScenario(sc("Hotel", 1, { id: "a" }), { feature: before, index: 0 }, false).next;

  test("placed at the render's stale index, it writes over its neighbour — the bug", () => {
    const { next } = placeScenario(renamed, { feature: optimistic, index: 0 }, false);
    expect(names(next)).toEqual(["Gamma v2", "Hotel v1", "Hotel v1"]);
  });

  test("placed where the tick landed, it replaces its own entry and keeps every neighbour", () => {
    const landed: Placement = { feature: optimistic, index: 2, id: "a" };
    const { next, s } = placeScenario(renamed, landed, false);
    expect(names(next)).toEqual(["Gamma v1", "Gamma v2", "Hotel v1"]);
    expect(s.version).toBe(1);
    expect(next.scenarios[2]!.body).toBe("Given more");
  });
});
