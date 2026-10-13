// Automates specs/app/feature-flags.feature.md in the browser: the flag
// chips on a feature header and a scenario card, and the "Feature flags"
// field that adds, toggles and removes them.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FeatureFlagChips,
  FeatureFlagsField,
  addFeatureFlag,
  featureFlagNameError,
  removeFeatureFlag,
  setFeatureFlag,
} from "../src/frontend/FeatureFlagsField";
import { scenarioSignature } from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";

const FLAGS = [
  { name: "new-checkout", on: true },
  { name: "card-v2", on: false },
];

describe("the flag chips", () => {
  test("one chip per flag, saying whether it is on, an off flag red", () => {
    const html = renderToStaticMarkup(<FeatureFlagChips flags={FLAGS} />);
    expect(html).toContain('data-feature-flag="new-checkout"');
    expect(html).toContain('class="chip static feature-flag on"');
    expect(html).toContain('class="chip static feature-flag off"');
    expect(html).toContain('title="Feature flag card-v2: off"');
  });

  test("nothing when there are none", () => {
    expect(renderToStaticMarkup(<FeatureFlagChips flags={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<FeatureFlagChips flags={[]} />)).toBe("");
  });
});

describe("the Feature flags field", () => {
  test("a switch and a remove button per flag, and an add row", () => {
    const html = renderToStaticMarkup(<FeatureFlagsField flags={FLAGS} onChange={() => {}} />);
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-label="Feature flag new-checkout" checked=""/);
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-label="Feature flag card-v2"\/>/);
    expect(html).toContain('aria-label="Remove card-v2"');
    // An off flag's state reads red, like its chip.
    expect(html).toContain('<span class="feature-flag-state off">off</span>');
    expect(html).toContain('aria-label="Feature flag name"');
    // The add row sets the new flag on or off before it is added; on to start.
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-label="New flag on" checked=""/);
    // Nothing typed yet: Add is disabled.
    expect(html).toMatch(/<button type="submit" class="link" disabled="">Add<\/button>/);
  });

  test("adding appends the flag, on or off as set; toggling and removing touch only that flag", () => {
    expect(addFeatureFlag(FLAGS, " beta ")).toEqual([...FLAGS, { name: "beta", on: true }]);
    expect(addFeatureFlag(FLAGS, "beta", false)).toEqual([...FLAGS, { name: "beta", on: false }]);
    expect(setFeatureFlag(FLAGS, "card-v2", true)).toEqual([
      { name: "new-checkout", on: true },
      { name: "card-v2", on: true },
    ]);
    expect(removeFeatureFlag(FLAGS, "new-checkout")).toEqual([{ name: "card-v2", on: false }]);
  });

  test("a name the token cannot carry, or one already there, is refused", () => {
    expect(featureFlagNameError(FLAGS, "beta")).toBeNull();
    expect(featureFlagNameError(FLAGS, "  ")).toMatch(/name/);
    expect(featureFlagNameError(FLAGS, "two words")).toMatch(/letters, digits/);
    expect(featureFlagNameError(FLAGS, "a:b")).toMatch(/letters, digits/);
    expect(featureFlagNameError(FLAGS, "card-v2")).toMatch(/already/);
  });
});

test("a flag change is something for the editor's autosave to save", () => {
  const s: Scenario = { name: "Pay", version: 1, status: "published", body: "x", tests: [] };
  expect(scenarioSignature({ ...s, flags: [{ name: "a", on: true }] }, 1)).not.toBe(
    scenarioSignature({ ...s, flags: [{ name: "a", on: false }] }, 1),
  );
});
