import { test, expect } from "bun:test";
import { parseFeature, serializeFeature } from "../src/server/parser";

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

test("serialize then parse round-trips", () => {
  const feature = parseFeature(SAMPLE);
  const reparsed = parseFeature(serializeFeature(feature));
  expect(reparsed).toEqual(feature);
});
