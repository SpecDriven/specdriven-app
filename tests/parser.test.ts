import { test, expect } from "bun:test";
import { parseFeature, serializeFeature, markPublished, markSaved } from "../src/server/parser";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote v1

- **Given** a potential customer has an account
- **When** the customer requests a quote
- **Then** a quote is provided

## Declined Quote v2

- **Given** the customer has no account
- **Then** the quote is declined
`;

test("parses feature name, description, and versioned scenarios", () => {
  const feature = parseFeature(SAMPLE);
  expect(feature.name).toBe("Quote Policy");
  expect(feature.description).toBe("Quotes for potential customers.");
  expect(feature.scenarios).toHaveLength(2);
  expect(feature.scenarios[0]).toMatchObject({ name: "Basic Quote", version: 1 });
  expect(feature.scenarios[0]!.body).toContain("the customer requests a quote");
  expect(feature.scenarios[1]).toMatchObject({ name: "Declined Quote", version: 2 });
});

test("scenario versions must be positive integers", () => {
  const feature = parseFeature("# X\n\n## Bad v0\n\nbody\n");
  expect(feature.scenarios).toHaveLength(0);
});

// A name that itself ends in a version-like word still parses: the trailing
// version wins and the rest stays part of the name.
test("a version-like word inside the name is not the scenario version", () => {
  const feature = parseFeature("# X\n\n## Migrate to v2 API v1 [published]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({
    name: "Migrate to v2 API",
    version: 1,
    published: true,
  });
});

// ui.spec.md / crud-feature.spec.md: a published scenario is marked with a
// [published] chip after the version.
test("parses the published chip", () => {
  const feature = parseFeature(
    "# X\n\n## Done v1 [published]\n\nbody\n\n## Draft v2\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, published: true });
  expect(feature.scenarios[1]).toMatchObject({ name: "Draft", version: 2, published: false });
});

// crud-feature.spec.md "Scenario is automatically saved locally and pushed to
// GitHub": a [saved] chip marks a saved, not-yet-published scenario.
test("parses and serializes the saved chip", () => {
  const text = "# X\n\n## Draft v2 [saved]\n\nbody\n";
  const feature = parseFeature(text);
  expect(feature.scenarios[0]).toMatchObject({
    name: "Draft",
    version: 2,
    published: false,
    saved: true,
  });
  expect(serializeFeature(feature)).toBe(text);
});

// Feature files written before the bracket syntax still read, and are
// normalized to the bracket syntax when they are next written.
test("legacy backtick headings still parse and normalize on write", () => {
  const feature = parseFeature(
    "# X\n\n## Done `v1` `published`\n\nbody\n\n## Kept `v3` `saved`\n\nbody\n\n## Draft `v2`\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, published: true });
  expect(feature.scenarios[1]).toMatchObject({ name: "Kept", version: 3, saved: true });
  expect(feature.scenarios[2]).toMatchObject({ name: "Draft", version: 2, published: false });
  const text = serializeFeature(feature);
  expect(text).toContain("## Done v1 [published]");
  expect(text).toContain("## Kept v3 [saved]");
  expect(text).toContain("## Draft v2\n");
  expect(text).not.toContain("`v");
});

test("extra spaces before the version and chip are tolerated", () => {
  const feature = parseFeature("# X\n\n## Talks to a live agent  v1 [published]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({
    name: "Talks to a live agent",
    version: 1,
    published: true,
  });
});

test("serialize emits the markdown format and round-trips exactly", () => {
  const feature = parseFeature(SAMPLE);
  expect(serializeFeature(feature)).toBe(SAMPLE);
  expect(parseFeature(serializeFeature(feature))).toEqual(feature);
});

test("a scenario with an empty body serializes as a bare heading", () => {
  const text = "# X\n\n## Empty v1\n";
  expect(serializeFeature(parseFeature(text))).toBe(text);
});

test("markdown headings and tables in the body belong to the scenario", () => {
  const body =
    "### Notes\n\n## An H2 without a version\n\n| plan | mobile UI |\n| ---- | --------- |\n| Gold | yes |";
  const feature = parseFeature(`# X\n\n## Rich v1\n\n${body}\n`);
  expect(feature.scenarios).toHaveLength(1);
  expect(feature.scenarios[0]!.body).toBe(body);
});

// Scenario headings inside fenced code blocks are body text, not boundaries.
test("scenario headings inside code fences are not scenario boundaries", () => {
  const text = "# X\n\n## Real v1\n\n```markdown\n## Example v9\n```\n";
  const feature = parseFeature(text);
  expect(feature.scenarios).toHaveLength(1);
  expect(feature.scenarios[0]!.body).toContain("## Example v9");
});

test("markPublished adds the published chip to unpublished headings only", () => {
  const marked = markPublished(
    "# X\n\n## Draft v2\n\nbody\n\n## Done v1 [published]\n\nbody\n",
  );
  expect(marked).toContain("## Draft v2 [published]");
  expect(marked).toContain("## Done v1 [published]");
  expect(marked).not.toContain("[published] [published]");
});

test("markSaved adds the saved chip to unmarked headings only", () => {
  const marked = markSaved(
    "# X\n\n## Draft v2\n\nbody\n\n## Done v1 [published]\n\nbody\n\n## Kept v3 [saved]\n\nbody\n",
  );
  expect(marked).toContain("## Draft v2 [saved]");
  expect(marked).toContain("## Done v1 [published]");
  expect(marked).toContain("## Kept v3 [saved]");
  expect(marked).not.toContain("[saved] [saved]");
});

test("markPublished upgrades saved to published", () => {
  const marked = markPublished("# X\n\n## Draft v2 [saved]\n\nbody\n");
  expect(marked).toContain("## Draft v2 [published]");
  expect(marked).not.toContain("[saved]");
});

test("mark helpers leave headings inside code fences alone", () => {
  const text = "# X\n\n## Real v1\n\n```\n## Example v9\n```\n";
  const marked = markSaved(text);
  expect(marked).toContain("## Real v1 [saved]");
  expect(marked).toContain("\n## Example v9\n");
});
