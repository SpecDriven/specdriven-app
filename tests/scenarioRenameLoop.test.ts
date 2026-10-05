// Issue #173: renaming a scenario to a name with a stray space (a pasted
// title, a trailing blank) added the scenario again under the next version on
// every autosave tick. The server parses headings trimmed (parser.ts
// SCENARIO_RE), so the editor, looking its scenario up by the untrimmed name,
// lost it, went "new", derived the next version and appended — forever.
import { describe, expect, test } from "bun:test";
import {
  cardOfScenario,
  landedScenario,
  nextVersionIn,
  placeScenario,
  scenarioSignature,
} from "../src/frontend/App";
import { projectFeature } from "../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { type Feature, parseFeature, type Scenario, serializeFeature } from "../src/server/parser";

const sc = (name: string, version: number, extra: Partial<Scenario> = {}): Scenario => ({
  name,
  version,
  status: "proposed",
  body: "",
  tests: [],
  ...extra,
});

/**
 * Autosave ticks against the real reconciliation: each tick does what
 * App.tsx saveScenario/autosaveScenario do — derive the version, skip an
 * unchanged signature, place the scenario, save, and follow it into the
 * answer. Returns the feature's scenarios after `ticks` ticks.
 */
function renameAndTick(newName: string, ticks = 5, body?: string): string[] {
  let doc = importFeatureDoc(parseFeature("# F\n\n## Other @v1 [proposed]\n\nGiven y\n\n## Old @v1 [proposed]\n\nGiven x\n"));
  // The editor's view: the projection with each scenario's document id.
  const view = (): Feature => {
    const f = parseFeature(projectFeature(doc));
    const ids = new Map(doc.specs.map((s) => [`${s.name}@v${s.version}`, s.id]));
    return { ...f, scenarios: f.scenarios.map((s) => ({ ...s, id: ids.get(`${s.name}@v${s.version}`) })) };
  };
  let feature = view();
  const at = feature.scenarios.findIndex((s) => s.name === "Old");
  let editing = {
    index: at as number | null,
    scenario: { ...feature.scenarios[at]!, name: newName, ...(body ? { body } : {}) },
  };
  let autosaved: string | null = scenarioSignature(feature.scenarios[at]!, 1);
  for (let i = 0; i < ticks; i++) {
    const version =
      editing.index === null
        ? nextVersionIn(feature, editing.scenario.name)
        : editing.scenario.version;
    const signature = scenarioSignature(editing.scenario, version);
    if (signature === autosaved) continue;
    const placed = { feature, index: editing.index, id: editing.scenario.id };
    const { s, next } = placeScenario(editing.scenario, placed, false);
    doc = reconcile(doc, parseFeature(serializeFeature(next)), { scenario: s });
    feature = view();
    const moved = landedScenario(feature.scenarios, s, s.id);
    const id = moved === null ? undefined : feature.scenarios[moved]!.id;
    editing = { index: moved, scenario: id === undefined ? editing.scenario : { ...editing.scenario, id } };
    autosaved = signature;
  }
  return feature.scenarios.map((s) => `${s.name} v${s.version}`);
}

describe("renaming a scenario across autosave ticks (issue #173)", () => {
  test("a plain rename is one scenario", () => {
    expect(renameAndTick("New")).toEqual(["New v1", "Other v1"]);
  });

  test("a name with a trailing space is still one scenario, saved trimmed", () => {
    expect(renameAndTick("New ")).toEqual(["New v1", "Other v1"]);
  });

  test("leading and non-breaking spaces too", () => {
    expect(renameAndTick("  New")).toEqual(["New v1", "Other v1"]);
    expect(renameAndTick("New\u00a0")).toEqual(["New v1", "Other v1"]);
  });

  test("a rename with a retyped body is one scenario", () => {
    expect(renameAndTick("New ", 5, "Given z")).toEqual(["New v1", "Other v1"]);
  });
});

describe("finding the scenario a save landed", () => {
  const saved = [sc("New", 1, { id: "e" }), sc("Other", 1, { id: "o" })];

  test("by identity, names compared trimmed", () => {
    expect(cardOfScenario(saved, { name: "New ", version: 1 })).toBe(0);
    expect(landedScenario(saved, { name: "New ", version: 1 }, undefined)).toBe(0);
  });

  test("by document id when the identity is not there", () => {
    expect(landedScenario(saved, { name: "Renamed", version: 3 }, "e")).toBe(0);
  });

  test("identity wins over a stale id", () => {
    expect(landedScenario(saved, { name: "Other", version: 1 }, "e")).toBe(1);
  });

  test("lost only when neither identity nor id is there", () => {
    expect(landedScenario(saved, { name: "Gone", version: 1 }, "x")).toBeNull();
    expect(landedScenario(saved, { name: "Gone", version: 1 }, undefined)).toBeNull();
  });
});

test("a stray space alone is nothing new to save", () => {
  const s = sc("New", 1);
  expect(scenarioSignature({ ...s, name: "New " }, 1)).toBe(scenarioSignature(s, 1));
});

test("a placed scenario goes out under its trimmed name", () => {
  const feature: Feature = { name: "F", description: "", scenarios: [sc("Old", 1, { id: "e" })] };
  const { s, next } = placeScenario(sc(" New ", 1, { id: "e" }), { feature, index: 0 }, false);
  expect(s.name).toBe("New");
  expect(next.scenarios.map((x) => x.name)).toEqual(["New"]);
});
