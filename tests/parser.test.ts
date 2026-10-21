import { test, expect } from "bun:test";
import {
  extractScenarios,
  featureTextError,
  parseFeature,
  serializeFeature,
  markPublished,
  markProposed,
  markScenarioPublished,
  renameFeatureName,
  titleFromFileName,
  unclosedFence,
} from "../src/server/parser";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1

- **Given** a potential customer has an account
- **When** the customer requests a quote
- **Then** a quote is provided

## Declined Quote @v2

- **Given** the customer has no account
- **Then** the quote is declined
`;

// specs/ui/ui.feature.md "Main page": show the feature name, not the file name
// — files without a `# <name>` heading fall back to a stem-derived name.
test("titleFromFileName derives a display name from the file stem", () => {
  expect(titleFromFileName("specs/quote-policy.feature.md")).toBe("Quote Policy");
  expect(titleFromFileName("legacy.feature")).toBe("Legacy");
  expect(titleFromFileName("specs/a.feature.md")).toBe("A");
});

// crud-feature.md "Feature file format": a feature file opens with
// `# ` followed by the feature name, and nothing above it.
test("featureTextError accepts a well-formed feature file", () => {
  expect(featureTextError(SAMPLE)).toBeNull();
  expect(featureTextError("# Onboard Employee\n")).toBeNull();
  expect(featureTextError("\n\n# Onboard Employee\n")).toBeNull();
  expect(featureTextError("# Onboard Employee")).toBeNull();
});

test("featureTextError names what is wrong with a malformed feature file", () => {
  expect(featureTextError("")).toBe("the file is empty");
  expect(featureTextError("\n \n")).toBe("the file is empty");
  expect(featureTextError("# \n\n## Basic @v1\n")).toBe("the feature heading has no name");
  expect(featureTextError("git diff# Quote Policy\n")).toContain('"git diff# Quote Policy"');
  expect(featureTextError("## Basic @v1\n\nbody\n")).toContain("must start with");
  expect(featureTextError("#Onboard Employee\n")).toContain("must start with");
});

// specs/editor/editor-autosave.feature.md "Autosave Waits While a Code Fence
// Is Open": text ending inside a fence swallows every scenario heading after
// the fence into the body above it, so it is not a feature the app may write.
test("unclosedFence reports the line of a fence left open at the end", () => {
  expect(unclosedFence(SAMPLE)).toBeNull();
  expect(unclosedFence("# X\n\n## A @v1\n\n```gherkin\nGiven x\n```\n")).toBeNull();
  expect(unclosedFence("# X\n\n## A @v1\n\n```gherkin\nGiven x\n")).toBe(5);
  expect(unclosedFence("# X\n\n~~~\na\n~~~\n\n## B @v1\n\n   ```\n")).toBe(9);
  expect(unclosedFence("")).toBeNull();
});

test("featureTextError refuses a feature whose last code fence is never closed", () => {
  const open = "# X\n\n## A @v1\n\n```gherkin\nGiven x\n\n## B @v1\n\nbody\n";
  expect(featureTextError(open)).toBe("the code fence opened on line 5 is never closed");
  expect(featureTextError(open.replace("Given x\n", "Given x\n```\n"))).toBeNull();
  // The reason the check exists: parsed as is, the fence swallows scenario B.
  expect(parseFeature(open).scenarios.map((s) => s.name)).toEqual(["A"]);
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

// A name that itself ends in a version-like word still parses: the `@` marks
// where the version starts, so the name keeps its own "v2".
test("a version-like word inside the name is not the scenario version", () => {
  const feature = parseFeature("# X\n\n## Migrate to v2 API @v1 [published]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({
    name: "Migrate to v2 API",
    version: 1,
    status: "published",
  });
});

// ui.spec.md / crud-feature.spec.md: a published scenario is marked with a
// [published] chip after the version.
test("parses the published chip", () => {
  const feature = parseFeature(
    "# X\n\n## Done @v1 [published]\n\nbody\n\n## Draft @v2\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, status: "published" });
  expect(feature.scenarios[1]).toMatchObject({ name: "Draft", version: 2, status: "draft" });
});

// crud-feature.spec.md "Feature file format": a [proposed] chip marks a
// saved, not-yet-published scenario.
test("parses and serializes the proposed chip", () => {
  const text = "# X\n\n## Draft @v2 [proposed]\n\nbody\n";
  const feature = parseFeature(text);
  expect(feature.scenarios[0]).toMatchObject({
    name: "Draft",
    version: 2,
    status: "proposed",
  });
  expect(serializeFeature(feature)).toBe(text);
});

// Files written before the state was renamed still read: [saved] is the old
// name of [proposed], normalized when the file is next written.
test("legacy [saved] chips parse as proposed and normalize on write", () => {
  const feature = parseFeature("# X\n\n## Kept @v3 [saved]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({ name: "Kept", version: 3, status: "proposed" });
  expect(serializeFeature(feature)).toContain("## Kept @v3 [proposed]");
});

// Feature files written before the `@` version prefix still read, and are
// normalized to `@vN` when they are next written. The `@` is what keeps a name
// that itself ends in a version apart from the scenario's own version — the
// un-prefixed form has to guess, and takes the trailing one.
test("legacy un-prefixed versions still parse and normalize on write", () => {
  const feature = parseFeature(
    "# X\n\n## Done v1 [published]\n\nbody\n\n## Kept v3 [saved]\n\nbody\n\n## Draft v2\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, status: "published" });
  expect(feature.scenarios[1]).toMatchObject({ name: "Draft", version: 2, status: "draft" });
  expect(feature.scenarios[2]).toMatchObject({ name: "Kept", version: 3, status: "proposed" });
  const text = serializeFeature(feature);
  expect(text).toContain("## Done @v1 [published]");
  expect(text).toContain("## Kept @v3 [proposed]");
  expect(text).toContain("## Draft @v2 [draft]");
});

// Feature files written before the bracket syntax still read, and are
// normalized to the bracket syntax when they are next written.
test("legacy backtick headings still parse and normalize on write", () => {
  const feature = parseFeature(
    "# X\n\n## Done `v1` `published`\n\nbody\n\n## Kept `v3` `saved`\n\nbody\n\n## Draft `v2`\n\nbody\n",
  );
  expect(feature.scenarios[0]).toMatchObject({ name: "Done", version: 1, status: "published" });
  expect(feature.scenarios[1]).toMatchObject({ name: "Draft", version: 2, status: "draft" });
  expect(feature.scenarios[2]).toMatchObject({ name: "Kept", version: 3, status: "proposed" });
  const text = serializeFeature(feature);
  expect(text).toContain("## Done @v1 [published]");
  expect(text).toContain("## Kept @v3 [proposed]");
  expect(text).toContain("## Draft @v2 [draft]");
  expect(text).not.toContain("`v");
});

test("extra spaces before the version and chip are tolerated", () => {
  const feature = parseFeature("# X\n\n## Talks to a live agent  @v1 [published]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({
    name: "Talks to a live agent",
    version: 1,
    status: "published",
  });
});

// specs/ui/ui.feature.md: "Scenarios are ordered by name, then by version" —
// regardless of the order they appear in the file.
test("scenarios are ordered by name, then by version", () => {
  const feature = parseFeature(
    "# X\n\n## Hotline @v1 [published]\n\nbody\n\n## Decline @v1 [published]\n\nbody\n\n## Hotline @v2 [published]\n\nbody\n",
  );
  expect(feature.scenarios.map((s) => `${s.name} v${s.version}`)).toEqual([
    "Decline v1",
    "Hotline v1",
    "Hotline v2",
  ]);
});

test("serialize emits the markdown format and round-trips exactly", () => {
  const feature = parseFeature(SAMPLE);
  // Chipless headings are drafts; serializing writes the status back as an
  // explicit [draft] chip — the editor wire format. (The on-disk projection
  // filters drafts out before serializing, so the chip never hits a file.)
  const chipped = SAMPLE.replace(
    "## Basic Quote @v1",
    "## Basic Quote @v1 [draft]",
  ).replace("## Declined Quote @v2", "## Declined Quote @v2 [draft]");
  expect(serializeFeature(feature)).toBe(chipped);
  expect(parseFeature(serializeFeature(feature))).toEqual(feature);
});

test("a scenario with an empty body serializes as a bare heading", () => {
  const text = "# X\n\n## Empty @v1 [draft]\n";
  expect(serializeFeature(parseFeature("# X\n\n## Empty @v1\n"))).toBe(text);
  expect(serializeFeature(parseFeature(text))).toBe(text);
});

test("markdown headings and tables in the body belong to the scenario", () => {
  const body =
    "### Notes\n\n## An H2 without a version\n\n| plan | mobile UI |\n| ---- | --------- |\n| Gold | yes |";
  const feature = parseFeature(`# X\n\n## Rich @v1\n\n${body}\n`);
  expect(feature.scenarios).toHaveLength(1);
  expect(feature.scenarios[0]!.body).toBe(body);
});

// Scenario headings inside fenced code blocks are body text, not boundaries.
test("scenario headings inside code fences are not scenario boundaries", () => {
  const text = "# X\n\n## Real @v1\n\n```markdown\n## Example @v9\n```\n";
  const feature = parseFeature(text);
  expect(feature.scenarios).toHaveLength(1);
  expect(feature.scenarios[0]!.body).toContain("## Example @v9");
});

test("markPublished adds the published chip to unpublished headings only", () => {
  const marked = markPublished(
    "# X\n\n## Draft @v2\n\nbody\n\n## Done @v1 [published]\n\nbody\n",
  );
  expect(marked).toContain("## Draft @v2 [published]");
  expect(marked).toContain("## Done @v1 [published]");
  expect(marked).not.toContain("[published] [published]");
});

test("markProposed adds the proposed chip to unmarked headings only", () => {
  const marked = markProposed(
    "# X\n\n## Draft @v2\n\nbody\n\n## Done @v1 [published]\n\nbody\n\n## Kept @v3 [proposed]\n\nbody\n",
  );
  expect(marked).toContain("## Draft @v2 [proposed]");
  expect(marked).toContain("## Done @v1 [published]");
  expect(marked).toContain("## Kept @v3 [proposed]");
  expect(marked).not.toContain("[proposed] [proposed]");
});

// crud-feature.md "publish each scenario individually"
test("markScenarioPublished flips only the named scenario version", () => {
  const marked = markScenarioPublished(
    "# X\n\n## Basic @v1 [proposed]\n\nold\n\n## Basic @v2\n\nnew\n\n## Other @v1\n\nbody\n",
    "Basic",
    2,
  );
  expect(marked).toContain("## Basic @v1 [proposed]");
  expect(marked).toContain("## Basic @v2 [published]");
  expect(marked).toContain("## Other @v1 [draft]");
});

test("markPublished upgrades proposed to published", () => {
  const marked = markPublished("# X\n\n## Draft @v2 [proposed]\n\nbody\n");
  expect(marked).toContain("## Draft @v2 [published]");
  expect(marked).not.toContain("[proposed]");
});

// crud-feature.spec.md "Scenario status": an explicit [draft] chip is the
// editor asking for the scenario to stay a draft — save must not promote it,
// and a whole-feature publish must not publish it.
test("parses the draft chip", () => {
  const feature = parseFeature("# X\n\n## Idea @v1 [draft]\n\nbody\n");
  expect(feature.scenarios[0]).toMatchObject({ name: "Idea", version: 1, status: "draft" });
});

test("markProposed keeps an explicit [draft] chip while promoting chipless headings", () => {
  const marked = markProposed("# X\n\n## Idea @v1 [draft]\n\nbody\n\n## New @v1\n\nbody\n");
  expect(marked).toContain("## Idea @v1 [draft]");
  expect(marked).toContain("## New @v1 [proposed]");
});

test("markPublished leaves an explicit [draft] chip alone", () => {
  const marked = markPublished(
    "# X\n\n## Idea @v1 [draft]\n\nbody\n\n## Ready @v1 [proposed]\n\nbody\n",
  );
  expect(marked).toContain("## Idea @v1 [draft]");
  expect(marked).toContain("## Ready @v1 [published]");
});

// Publishing a draft from its own card is an explicit action on that
// scenario, and that door stays open.
test("markScenarioPublished publishes a targeted draft", () => {
  const marked = markScenarioPublished("# X\n\n## Idea @v1 [draft]\n\nbody\n", "Idea", 1);
  expect(marked).toContain("## Idea @v1 [published]");
});

test("mark helpers leave headings inside code fences alone", () => {
  const text = "# X\n\n## Real @v1\n\n```\n## Example @v9\n```\n";
  const marked = markProposed(text);
  expect(marked).toContain("## Real @v1 [proposed]");
  expect(marked).toContain("\n## Example @v9\n");
});

// specs/ui/ui.feature.md "Main page": the Edit link edits the feature name —
// the
// `# <name>` heading — leaving everything else in the file untouched.
test("renameFeatureName rewrites only the feature heading", () => {
  const text = "# Old\n\ndesc\n\n## Basic @v1 [published]\n\nbody\n";
  expect(renameFeatureName(text, "New Name")).toBe(
    "# New Name\n\ndesc\n\n## Basic @v1 [published]\n\nbody\n",
  );
});

test("renameFeatureName inserts a heading when the file has none", () => {
  expect(renameFeatureName("just text\n", "Named")).toBe("# Named\n\njust text\n");
  expect(renameFeatureName("", "Named")).toBe("# Named\n");
});

test("renameFeatureName ignores `#` lines in fences or after scenarios", () => {
  const fenced = "```\n# comment\n```\n\n## S @v1\n\nbody\n";
  const renamed = renameFeatureName(fenced, "Named");
  expect(renamed.startsWith("# Named\n\n```\n# comment\n```")).toBe(true);
  const inBody = "## S @v1\n\n# heading in body\n";
  expect(renameFeatureName(inBody, "Named")).toBe("# Named\n\n## S @v1\n\n# heading in body\n");
});

// Scenario-level code gen selection (specs/agents/claude.feature.md): a session
// can take a whole spec or a subset of its scenarios — extractScenarios
// keeps the heading and description and drops every unpicked scenario.
test("extractScenarios keeps only the picked scenarios", () => {
  const text = extractScenarios(SAMPLE, [{ name: "Declined Quote", version: 2 }]);
  expect(text).toBe(
    "# Quote Policy\n\nQuotes for potential customers.\n\n" +
      "## Declined Quote @v2 [draft]\n\n" +
      "- **Given** the customer has no account\n- **Then** the quote is declined\n",
  );
});

test("extractScenarios distinguishes versions of the same scenario name", () => {
  const text = "# F\n\n## S @v1\n\nold\n\n## S @v2\n\nnew\n";
  expect(extractScenarios(text, [{ name: "S", version: 2 }])).toBe(
    "# F\n\n## S @v2 [draft]\n\nnew\n",
  );
});

test("extractScenarios throws when a pick names a missing scenario", () => {
  expect(() => extractScenarios(SAMPLE, [{ name: "Basic Quote", version: 9 }])).toThrow(
    "scenario not found: Basic Quote @v9",
  );
  expect(() => extractScenarios(SAMPLE, [{ name: "Nope", version: 1 }])).toThrow(
    "scenario not found: Nope @v1",
  );
});
