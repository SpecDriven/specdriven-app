// Automates specs/editor/spec-editor.feature.md "Spec editor pane": the way
// back from the editor pane lands on the card of the scenario it held — found
// by identity, since the last save may have moved it — and the `<` control is
// a plain icon button that takes the bar's colour.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BackIcon } from "../src/frontend/BackIcon";
import { cardOfScenario, isCardControl, withScenario } from "../src/frontend/App";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version: number, status: Scenario["status"] = "proposed"): Scenario => ({
  name,
  version,
  status,
  body: "",
  tests: [],
});

const feature: Feature = {
  name: "Quote",
  description: "",
  scenarios: [sc("Alpha", 1), sc("Gamma", 1), sc("Gamma", 2, "published")],
};

describe("the way back lands on the scenario's card", () => {
  test("an opened, unedited scenario's card is where it was", () => {
    expect(cardOfScenario(feature.scenarios, { name: "Gamma", version: 2 })).toBe(2);
    expect(cardOfScenario(feature.scenarios, { name: "Alpha", version: 1 })).toBe(0);
  });

  test("a new scenario lands in canonical order and its card is found there", () => {
    const landed = withScenario(feature, null, sc("Beta", 1, "draft"));
    expect(landed.scenarios.map((s) => s.name)).toEqual(["Alpha", "Beta", "Gamma", "Gamma"]);
    expect(cardOfScenario(landed.scenarios, { name: "Beta", version: 1 })).toBe(1);
  });

  test("a renamed scenario is replaced, never duplicated, and found under its new name", () => {
    const landed = withScenario(feature, 0, sc("Zulu", 1));
    expect(landed.scenarios).toHaveLength(3);
    expect(landed.scenarios.map((s) => s.name)).toEqual(["Gamma", "Gamma", "Zulu"]);
    expect(cardOfScenario(landed.scenarios, { name: "Zulu", version: 1 })).toBe(2);
    expect(cardOfScenario(landed.scenarios, { name: "Alpha", version: 1 })).toBeNull();
  });

  test("the feature itself is left alone", () => {
    withScenario(feature, null, sc("Beta", 1));
    expect(feature.scenarios.map((s) => s.name)).toEqual(["Alpha", "Gamma", "Gamma"]);
  });

  test("a scenario the feature never received highlights nothing", () => {
    expect(cardOfScenario(feature.scenarios, { name: "", version: 1 })).toBeNull();
    expect(cardOfScenario(feature.scenarios, { name: "Gamma", version: 3 })).toBeNull();
  });
});

describe("the back button", () => {
  test("its icon is decorative and takes the button's colour", () => {
    const html = renderToStaticMarkup(<BackIcon />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain("<polyline");
  });
});

// A click on a scenario card highlights it and a double-click opens the editor
// pane — unless it landed on one of the card's controls. Modelled on the
// element's ancestry: `closest` answers for the selectors the card asks about.
describe("what counts as a card control", () => {
  const within = (...matches: string[]) => ({
    closest: (selector: string) =>
      selector.split(",").some((s) => matches.includes(s.trim())) ? {} : null,
  });

  test("the card body and its title link are the card", () => {
    expect(isCardControl(within())).toBe(false);
    expect(isCardControl(within("a", ".scenario-title > a"))).toBe(false);
  });

  test("buttons, checkboxes and other links are controls", () => {
    expect(isCardControl(within("button"))).toBe(true);
    expect(isCardControl(within("input"))).toBe(true);
    expect(isCardControl(within("a"))).toBe(true);
  });

  test("no element, no control", () => {
    expect(isCardControl(null)).toBe(false);
  });
});
