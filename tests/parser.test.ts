import { test, expect } from "bun:test";
import { parseFeature, serializeFeature, markPublished, markSaved } from "../src/server/parser";

const SAMPLE = `Feature: Quote Policy

Scenario: Basic Quote @v1
Given:
  Potential customer has an account
When:
  Customer requests quote
Then:
  Quote is provided

Scenario: Declined Quote @v2
Given:
  Customer has no account
Then:
  Quote is declined
`;

test("parses feature name and versioned scenarios", () => {
  const feature = parseFeature(SAMPLE);
  expect(feature.name).toBe("Quote Policy");
  expect(feature.scenarios).toHaveLength(2);
  expect(feature.scenarios[0]).toMatchObject({ name: "Basic Quote", version: 1 });
  expect(feature.scenarios[0]!.body).toContain("Customer requests quote");
  expect(feature.scenarios[1]).toMatchObject({ name: "Declined Quote", version: 2 });
});

test("accepts the legacy 'name:' feature header", () => {
  const feature = parseFeature("name: Quote Policy\n\nScenario: Basic Quote @v1\nbody\n");
  expect(feature.name).toBe("Quote Policy");
  expect(feature.scenarios).toHaveLength(1);
});

test("scenario versions must be positive integers", () => {
  const feature = parseFeature("Feature: X\n\nScenario: Bad @v0\nbody\n");
  expect(feature.scenarios).toHaveLength(0);
});

// ui.spec.md / crud-feature.spec.md: a published scenario is marked with
// [pub] after the version.
test("parses the [pub] published marker", () => {
  const feature = parseFeature(
    "Feature: X\n\nScenario: Done @v1 [pub]\nbody\n\nScenario: Draft @v2\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, published: true });
  expect(feature.scenarios[1]).toMatchObject({ name: "Draft", version: 2, published: false });
});

test("serialize keeps the [pub] marker", () => {
  const text = "Feature: X\n\nScenario: Done @v1 [pub]\nbody\n";
  expect(serializeFeature(parseFeature(text))).toBe(text);
});

test("markPublished appends [pub] to unpublished scenario headers only", () => {
  const marked = markPublished(
    "Feature: X\n\nScenario: Draft @v2\nbody\n\nScenario: Done @v1 [pub]\nbody\n",
  );
  expect(marked).toContain("Scenario: Draft @v2 [pub]");
  expect(marked).toContain("Scenario: Done @v1 [pub]");
  expect(marked).not.toContain("[pub] [pub]");
});

// crud-feature.spec.md "Scenario is automatically saved locally and pushed to
// GitHub": [saved] after the version marks a saved, not-yet-published scenario.
test("parses and serializes the [saved] marker", () => {
  const text = "Feature: X\n\nScenario: Draft @v2 [saved]\nbody\n";
  const feature = parseFeature(text);
  expect(feature.scenarios[0]).toMatchObject({
    name: "Draft",
    version: 2,
    published: false,
    saved: true,
  });
  expect(serializeFeature(feature)).toBe(text);
});

test("markSaved appends [saved] to unmarked scenario headers only", () => {
  const marked = markSaved(
    "Feature: X\n\nScenario: Draft @v2\nbody\n\nScenario: Done @v1 [pub]\nbody\n\nScenario: Kept @v3 [saved]\nbody\n",
  );
  expect(marked).toContain("Scenario: Draft @v2 [saved]");
  expect(marked).toContain("Scenario: Done @v1 [pub]");
  expect(marked).toContain("Scenario: Kept @v3 [saved]");
  expect(marked).not.toContain("[saved] [saved]");
});

test("markPublished upgrades [saved] to [pub]", () => {
  const marked = markPublished("Feature: X\n\nScenario: Draft @v2 [saved]\nbody\n");
  expect(marked).toContain("Scenario: Draft @v2 [pub]");
  expect(marked).not.toContain("[saved]");
});

test("serialize then parse round-trips", () => {
  const feature = parseFeature(SAMPLE);
  const reparsed = parseFeature(serializeFeature(feature));
  expect(reparsed).toEqual(feature);
});
