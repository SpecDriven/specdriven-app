// specs/external-links/qtest-test-cases.feature.md "Each scenario becomes one
// test case": the Given lines are the precondition, each When a step, the
// Then lines after it the step's expected result.

import { describe, expect, test } from "bun:test";
import type { Scenario } from "../src/server/parser";
import { scenarioBlocks, scenarioToTestCase } from "../src/server/qtestSteps";

const scenario = (body: string, name = "Basic Quote"): Scenario => ({
  name,
  version: 1,
  status: "proposed",
  body,
  tests: [],
});
const source = { featureName: "Quote Policy", file: "specs/quote-policy.feature.md" };

describe("a scenario's blocks", () => {
  test("read bold keywords, colon keywords, and And lines alike", () => {
    const blocks = scenarioBlocks(`- **Given** a customer
- **And** an account
- When: the quote is asked for
- and the customer confirms
- Then: a quote is provided
- but no email is sent`);
    expect(blocks).toEqual([
      { kind: "given", lines: ["Given a customer", "and an account"] },
      { kind: "when", lines: ["When the quote is asked for", "and the customer confirms"] },
      { kind: "then", lines: ["Then a quote is provided", "but no email is sent"] },
    ]);
  });

  test("a wrapped line continues the line before; a plain list item joins the block", () => {
    const blocks = scenarioBlocks(`- Given: a feature is open and qTest test cases are
  switched on
- the parent module is known
- When: the user presses Create`);
    expect(blocks[0]).toEqual({
      kind: "given",
      lines: ["Given a feature is open and qTest test cases are switched on", "the parent module is known"],
    });
    expect(blocks[1]).toEqual({ kind: "when", lines: ["When the user presses Create"] });
  });

  test("text before any keyword counts as Given", () => {
    expect(scenarioBlocks("Some context.\n- and more")).toEqual([
      { kind: "given", lines: ["Some context.", "and more"] },
    ]);
  });
});

describe("the test case a scenario makes", () => {
  test("has the Given lines as precondition, a step per When, and the Then lines as expected", () => {
    const tc = scenarioToTestCase(
      scenario(`- **Given** a customer has an account
- **When** the customer asks for a quote
- **Then** a quote is provided
- **And** it is emailed
- **When** the customer declines it
- **Then** the quote is closed`),
      1,
      source,
    );
    expect(tc).toEqual({
      name: "S1: Basic Quote",
      description: "Scenario of the SpecDriven feature “Quote Policy” (specs/quote-policy.feature.md).",
      precondition: "Given a customer has an account",
      test_steps: [
        { description: "When the customer asks for a quote", expected: "Then a quote is provided\nand it is emailed" },
        { description: "When the customer declines it", expected: "Then the quote is closed" },
      ],
    });
  });

  test("a Then with no When before it becomes a check step; a Given between steps sets the next one up", () => {
    const tc = scenarioToTestCase(
      scenario(`- Given: the customer has no account
- Then: no quote is provided
- Given: the customer signs up
- When: they ask again
- Then: a quote is provided`),
      2,
      source,
    );
    expect(tc.precondition).toBe("Given the customer has no account");
    expect(tc.test_steps).toEqual([
      { description: "Check the outcome", expected: "Then no quote is provided" },
      { description: "Given the customer signs up\nWhen they ask again", expected: "Then a quote is provided" },
    ]);
  });

  test("with a Confluence page, the description links the scenario's anchor there; a draft links the page", () => {
    const page = { url: "https://wiki.acme.com/spaces/QA/pages/99/Quote+Policy", title: "Quote Policy" };
    expect(scenarioToTestCase(scenario(""), 3, { ...source, confluencePage: page }).description).toBe(
      "Scenario of the SpecDriven feature “Quote Policy” (https://wiki.acme.com/spaces/QA/pages/99/Quote+Policy#QuotePolicy-S3).",
    );
    expect(scenarioToTestCase(scenario(""), null, { ...source, confluencePage: page }).description).toBe(
      "Scenario of the SpecDriven feature “Quote Policy” (https://wiki.acme.com/spaces/QA/pages/99/Quote+Policy).",
    );
  });

  test("a scenario with no steps gets one step so qTest accepts it", () => {
    expect(scenarioToTestCase(scenario(""), 3, source).test_steps).toEqual([
      { description: "Basic Quote", expected: "" },
    ]);
    expect(scenarioToTestCase(scenario("- Given: only context"), 3, source).test_steps).toEqual([
      { description: "Check the outcome", expected: "" },
    ]);
  });

  test("a draft, which has no number, is named as is; a long name is cut to what qTest keeps", () => {
    expect(scenarioToTestCase(scenario("", "Draft idea"), null, source).name).toBe("Draft idea");
    const long = scenarioToTestCase(scenario("", "x".repeat(300)), 9, source).name;
    expect(long.length).toBe(255);
    expect(long.startsWith("S9: xxx")).toBe(true);
  });
});
