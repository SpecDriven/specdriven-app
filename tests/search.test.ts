// Automates specs/search.spec.md: indexed full-text search over the data
// repo's feature files — ranking, prefix/fuzzy matching, snippets, and the
// stat-fingerprint invalidation that follows external file changes — and the
// roadmap scope the sidebar's Roadmap tab searches (specs/app/roadmap
// .feature.md): the roadmap folder's pages, apart from the specs.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSearchScope,
  makeSnippet,
  resetSearchCache,
  searchRoadmap,
  searchSpecs,
} from "../src/server/search";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-search-"));
  resetSearchCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const QUOTES = `# Quotes

Pricing specs for the quoting engine.

## Basic quote @v1 [published]

- Given: a standard customer
- Then: the monthly premium is computed from the base rate

## Basic quote @v2

- Given: a standard customer
- Then: the monthly premium is computed from the base rate and a rider

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/tests/blob/main/quote.test.ts |
`;

// Scenario: a body match is found with a snippet
test("a body-only word returns scenario hits with a snippet", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  const results = await searchSpecs(root, "premium");
  expect(results.length).toBe(2); // each version is its own row
  for (const r of results) {
    expect(r.kind).toBe("scenario");
    expect(r.fileName).toBe("quotes.feature.md");
    expect(r.featureName).toBe("Quotes");
    expect(r.scenario!.name).toBe("Basic quote");
    expect(r.snippet.toLowerCase()).toContain("premium");
    expect(r.terms).toContain("premium");
  }
  expect(results.map((r) => r.scenario!.version).sort()).toEqual([1, 2]);
});

test("a feature-name match returns a feature hit", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  const results = await searchSpecs(root, "quotes");
  const feature = results.find((r) => r.kind === "feature");
  expect(feature).toBeDefined();
  expect(feature!.featureName).toBe("Quotes");
  expect(feature!.scenario).toBeUndefined();
});

// Scenario: name matches rank above body matches
test("a scenario named for the term outranks a body-only mention", async () => {
  await Bun.write(
    join(root, "rules.feature.md"),
    `# Rules

## Premium rules @v1

- Then: name-boosted scenarios rank first

## Discounts @v1

- Then: a discount reduces the premium a little
`,
  );
  const results = await searchSpecs(root, "premium");
  expect(results.length).toBe(2);
  expect(results[0]!.scenario!.name).toBe("Premium rules");
});

// Scenario: prefix and fuzzy matches hit
test("prefix and typo queries find the word, terms carry the expansion", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  for (const q of ["prem", "premum"]) {
    const results = await searchSpecs(root, q);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.terms).toContain("premium");
  }
});

test("features in nested folders are found with folder-relative paths", async () => {
  await mkdir(join(root, "billing"), { recursive: true });
  await Bun.write(join(root, "billing/quotes.feature.md"), QUOTES);
  const results = await searchSpecs(root, "premium");
  expect(results.length).toBe(2);
  expect(results[0]!.fileName).toBe("billing/quotes.feature.md");
});

test("the tests table is not indexed", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  // "github" appears only in the ### Tests table, which the parser strips.
  expect(await searchSpecs(root, "github")).toEqual([]);
});

// Scenario: the index follows external file changes
test("an overwritten file is reindexed", async () => {
  const file = join(root, "a.feature.md");
  await Bun.write(file, "# A\n\n## S @v1\n\nthe old banana paragraph\n");
  expect((await searchSpecs(root, "banana")).length).toBe(1);
  await Bun.write(file, "# A\n\n## S @v1\n\na brand new cucumber sentence instead\n");
  expect(await searchSpecs(root, "banana")).toEqual([]);
  expect((await searchSpecs(root, "cucumber")).length).toBe(1);
});

test("a deleted file drops out of the results", async () => {
  await Bun.write(join(root, "a.feature.md"), "# A\n\n## S @v1\n\nshared target word\n");
  await Bun.write(join(root, "b.feature.md"), "# B\n\n## S @v1\n\nshared target word\n");
  expect((await searchSpecs(root, "target")).length).toBe(2);
  await rm(join(root, "a.feature.md"));
  const results = await searchSpecs(root, "target");
  expect(results.length).toBe(1);
  expect(results[0]!.fileName).toBe("b.feature.md");
});

test("an empty or whitespace query returns no results", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  expect(await searchSpecs(root, "")).toEqual([]);
  expect(await searchSpecs(root, "   ")).toEqual([]);
});

test("the limit caps the result list", async () => {
  for (const stem of ["a", "b", "c"]) {
    await Bun.write(join(root, `${stem}.feature.md`), `# ${stem}\n\n## S @v1\n\ncommon word\n`);
  }
  expect((await searchSpecs(root, "common")).length).toBe(3);
  expect((await searchSpecs(root, "common", 2)).length).toBe(2);
});

test("makeSnippet windows around the first hit with ellipses", () => {
  const text = `${"x".repeat(95)} ${"y".repeat(95)} premium ${"tail words ".repeat(30)}`;
  const snippet = makeSnippet(text, ["premium"]);
  // The left edge lands mid-run and snaps forward to the word start.
  expect(snippet.startsWith("…premium")).toBe(true);
  expect(snippet.endsWith("…")).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(184);
});

test("makeSnippet collapses whitespace", () => {
  const snippet = makeSnippet("the  monthly\n\npremium   is computed", ["premium"]);
  expect(snippet).toBe("the monthly premium is computed");
});

test("makeSnippet falls back to the head when no term occurs in the text", () => {
  expect(makeSnippet("short text", ["zzz"])).toBe("short text");
  const long = makeSnippet("word ".repeat(60), ["zzz"]);
  expect(long.endsWith("…")).toBe(true);
  expect(long.length).toBeLessThanOrEqual(181);
});

test("makeSnippet of empty text is empty", () => {
  expect(makeSnippet("", ["x"])).toBe("");
  expect(makeSnippet("   \n  ", ["x"])).toBe("");
});

// The Roadmap tab's search: the roadmap folder's pages, and only those.
const PRICING = `# Pricing plans

**Assigned:** David

Move every premium tier to annual billing by Q3.
`;

test("the roadmap scope finds a page by a word in its body, with a snippet", async () => {
  await mkdir(join(root, "roadmap"), { recursive: true });
  await Bun.write(join(root, "roadmap/pricing.md"), PRICING);
  const results = await searchRoadmap(root, "annual");
  expect(results.length).toBe(1);
  const [hit] = results;
  expect(hit!.kind).toBe("roadmap");
  expect(hit!.fileName).toBe("roadmap/pricing.md");
  expect(hit!.featureName).toBe("Pricing plans");
  expect(hit!.scenario).toBeUndefined();
  expect(hit!.snippet.toLowerCase()).toContain("annual");
  expect(hit!.terms).toContain("annual");
});

test("the roadmap scope finds a page by its heading, and names a headless page by its file", async () => {
  await mkdir(join(root, "roadmap/later"), { recursive: true });
  await Bun.write(join(root, "roadmap/pricing.md"), PRICING);
  await Bun.write(join(root, "roadmap/later/mobile-app.md"), "just a stub for the pricing work\n");
  const byName = await searchRoadmap(root, "pricing");
  expect(byName.length).toBe(2);
  // The heading match ranks above the body-only mention.
  expect(byName[0]!.fileName).toBe("roadmap/pricing.md");
  expect(byName[1]!.fileName).toBe("roadmap/later/mobile-app.md");
  expect(byName[1]!.featureName).toBe("Mobile App");
});

test("the two scopes do not see each other's files", async () => {
  await mkdir(join(root, "roadmap"), { recursive: true });
  await Bun.write(join(root, "roadmap/pricing.md"), PRICING);
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  // "annual" is only in the roadmap page, "rider" only in the spec.
  expect(await searchSpecs(root, "annual")).toEqual([]);
  expect(await searchRoadmap(root, "rider")).toEqual([]);
  // A word in both: each scope reports only its own kind.
  expect((await searchSpecs(root, "premium")).every((r) => r.kind !== "roadmap")).toBe(true);
  expect((await searchRoadmap(root, "premium")).map((r) => r.kind)).toEqual(["roadmap"]);
});

test("the roadmap index follows page edits and deletions", async () => {
  await mkdir(join(root, "roadmap"), { recursive: true });
  const file = join(root, "roadmap/pricing.md");
  await Bun.write(file, PRICING);
  expect((await searchRoadmap(root, "annual")).length).toBe(1);
  await Bun.write(file, "# Pricing plans\n\nmonthly billing stays\n");
  expect(await searchRoadmap(root, "annual")).toEqual([]);
  expect((await searchRoadmap(root, "monthly")).length).toBe(1);
  await rm(file);
  expect(await searchRoadmap(root, "monthly")).toEqual([]);
});

test("without a roadmap folder the roadmap scope is simply empty", async () => {
  await Bun.write(join(root, "quotes.feature.md"), QUOTES);
  expect(await searchRoadmap(root, "premium")).toEqual([]);
});

test("isSearchScope accepts the two scopes only", () => {
  expect(isSearchScope("specs")).toBe(true);
  expect(isSearchScope("roadmap")).toBe(true);
  expect(isSearchScope("features")).toBe(false);
  expect(isSearchScope(null)).toBe(false);
});
