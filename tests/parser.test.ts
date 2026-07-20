import { test, expect } from "bun:test";
import {
  parseFeature,
  serializeFeature,
  markPublished,
  markProposed,
  markScenarioPublished,
  renameFeatureName,
  titleFromFileName,
} from "../src/server/parser";

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

// specs/ui.spec.md "Main page": show the feature name, not the file name —
// files without a `# <name>` heading fall back to a stem-derived name.
test("titleFromFileName derives a display name from the file stem", () => {
  expect(titleFromFileName("quote-policy.feature.md")).toBe("Quote Policy");
  expect(titleFromFileName("legacy.feature")).toBe("Legacy");
  expect(titleFromFileName("a.feature.md")).toBe("A");
});

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

// crud-feature.spec.md "Feature file format": a [proposed] chip marks a
// saved, not-yet-published scenario.
test("parses and serializes the proposed chip", () => {
  const text = "# X\n\n## Draft v2 [proposed]\n\nbody\n";
  const feature = parseFeature(text);
  expect(feature.scenarios[0]).toMatchObject({
    name: "Draft",
    version: 2,
    published: false,
    proposed: true,
  });
  expect(serializeFeature(feature)).toBe(text);
});

// Files written before the state was renamed still read: [saved] is the old
// name of [proposed], normalized when the file is next written.
test("legacy [saved] chips parse as proposed and normalize on write", () => {
  const feature = parseFeature("# X\n\n## Kept v3 [saved]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({ name: "Kept", version: 3, proposed: true });
  expect(serializeFeature(feature)).toContain("## Kept v3 [proposed]");
});

// Feature files written before the bracket syntax still read, and are
// normalized to the bracket syntax when they are next written.
test("legacy backtick headings still parse and normalize on write", () => {
  const feature = parseFeature(
    "# X\n\n## Done `v1` `published`\n\nbody\n\n## Kept `v3` `saved`\n\nbody\n\n## Draft `v2`\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, published: true });
  expect(feature.scenarios[1]).toMatchObject({ name: "Kept", version: 3, proposed: true });
  expect(feature.scenarios[2]).toMatchObject({ name: "Draft", version: 2, published: false });
  const text = serializeFeature(feature);
  expect(text).toContain("## Done v1 [published]");
  expect(text).toContain("## Kept v3 [proposed]");
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

test("markProposed adds the proposed chip to unmarked headings only", () => {
  const marked = markProposed(
    "# X\n\n## Draft v2\n\nbody\n\n## Done v1 [published]\n\nbody\n\n## Kept v3 [proposed]\n\nbody\n",
  );
  expect(marked).toContain("## Draft v2 [proposed]");
  expect(marked).toContain("## Done v1 [published]");
  expect(marked).toContain("## Kept v3 [proposed]");
  expect(marked).not.toContain("[proposed] [proposed]");
});

// specs/crud-feature.spec.md "publish each scenario individually"
test("markScenarioPublished flips only the named scenario version", () => {
  const marked = markScenarioPublished(
    "# X\n\n## Basic v1 [proposed]\n\nold\n\n## Basic v2\n\nnew\n\n## Other v1\n\nbody\n",
    "Basic",
    2,
  );
  expect(marked).toContain("## Basic v1 [proposed]");
  expect(marked).toContain("## Basic v2 [published]");
  expect(marked).toContain("## Other v1\n");
});

test("markPublished upgrades proposed to published", () => {
  const marked = markPublished("# X\n\n## Draft v2 [proposed]\n\nbody\n");
  expect(marked).toContain("## Draft v2 [published]");
  expect(marked).not.toContain("[proposed]");
});

test("mark helpers leave headings inside code fences alone", () => {
  const text = "# X\n\n## Real v1\n\n```\n## Example v9\n```\n";
  const marked = markProposed(text);
  expect(marked).toContain("## Real v1 [proposed]");
  expect(marked).toContain("\n## Example v9\n");
});

// specs/ui.spec.md "Main page": the Edit link edits the feature name — the
// `# <name>` heading — leaving everything else in the file untouched.
test("renameFeatureName rewrites only the feature heading", () => {
  const text = "# Old\n\ndesc\n\n## Basic v1 [published]\n\nbody\n";
  expect(renameFeatureName(text, "New Name")).toBe(
    "# New Name\n\ndesc\n\n## Basic v1 [published]\n\nbody\n",
  );
});

test("renameFeatureName inserts a heading when the file has none", () => {
  expect(renameFeatureName("just text\n", "Named")).toBe("# Named\n\njust text\n");
  expect(renameFeatureName("", "Named")).toBe("# Named\n");
});

test("renameFeatureName ignores `#` lines in fences or after scenarios", () => {
  const fenced = "```\n# comment\n```\n\n## S v1\n\nbody\n";
  const renamed = renameFeatureName(fenced, "Named");
  expect(renamed.startsWith("# Named\n\n```\n# comment\n```")).toBe(true);
  const inBody = "## S v1\n\n# heading in body\n";
  expect(renameFeatureName(inBody, "Named")).toBe("# Named\n\n## S v1\n\n# heading in body\n");
});
