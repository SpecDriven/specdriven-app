// specs/ui/scenario-polarity.feature.md in the browser: the pure helpers
// behind the Positive / Negative pill, the pill itself, and the autosave
// signature that notices a flip.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { scenarioSignature, withPolarity, withScenarioPolarity } from "../src/frontend/App";
import { PolarityPill } from "../src/frontend/PolarityPill";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, negative = false): Scenario => ({
  name,
  version: 1,
  status: "proposed",
  body: "",
  tests: [],
  ...(negative ? { negative: true as const } : {}),
});

const feature = (...scenarios: Scenario[]): Feature => ({ name: "F", description: "", scenarios });

test("withScenarioPolarity marks one scenario and leaves the rest alone; positive drops the key", () => {
  const f = feature(sc("A"), sc("B", true), sc("C"));
  const marked = withScenarioPolarity(f, 0, true);
  expect(marked.scenarios.map((s) => s.negative)).toEqual([true, true, undefined]);
  expect(marked.scenarios[1]).toBe(f.scenarios[1]);
  const cleared = withScenarioPolarity(marked, 1, false);
  expect(cleared.scenarios.map((s) => s.negative)).toEqual([true, undefined, undefined]);
  expect("negative" in cleared.scenarios[1]!).toBe(false);
  expect(withScenarioPolarity(f, 5, true)).toBe(f);
  expect(withPolarity(sc("A", true), false)).toEqual(sc("A"));
});

test("the pill reads Positive in green or Negative in red and says what a click does", () => {
  const positive = renderToStaticMarkup(<PolarityPill negative={false} onToggle={() => {}} />);
  expect(positive).toContain('class="chip polarity-pill positive"');
  expect(positive).toContain('aria-label="Mark negative"');
  expect(positive).toContain(">Positive</button>");
  const negative = renderToStaticMarkup(<PolarityPill negative onToggle={() => {}} disabled />);
  expect(negative).toContain('class="chip polarity-pill negative"');
  expect(negative).toContain('aria-label="Mark positive"');
  expect(negative).toContain(">Negative</button>");
  expect(negative).toContain("disabled=");
});

test("on a card the polarity is only a dot, coloured the same and still saying what a click does", () => {
  const dot = renderToStaticMarkup(<PolarityPill compact negative={false} onToggle={() => {}} />);
  expect(dot).toContain('class="polarity-dot-button positive"');
  expect(dot).toContain('aria-label="Mark negative"');
  expect(dot).not.toContain("Positive<");
  expect(dot).toContain('<span class="polarity-dot"');
  expect(renderToStaticMarkup(<PolarityPill compact negative onToggle={() => {}} />)).toContain(
    'class="polarity-dot-button negative"',
  );
});

test("the autosave signature follows the marker", () => {
  expect(scenarioSignature(sc("A"), 1)).not.toBe(scenarioSignature(sc("A", true), 1));
  expect(scenarioSignature(withPolarity(sc("A", true), false), 1)).toBe(scenarioSignature(sc("A"), 1));
});
