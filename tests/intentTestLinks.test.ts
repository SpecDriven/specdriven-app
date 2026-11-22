// Automates specs/app/extract-specs-from-code.feature.md "Tests are linked
// in a pass of their own": the pure side of linking a code project's tests
// to the scenarios extracted from it — which tests a feature is shown, what
// the agent is asked, what of its answer is kept, and what is added to the
// feature — and where a project's test links point.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testedStem } from "../src/server/intentDigest";
import { extractedRoots, planExtractedFeature, sourceFiles } from "../src/server/intentDraft";
import {
  addTestLinks,
  linkPrompt,
  linkScenarios,
  linksFromResult,
  MAX_LINKS_PER_SCENARIO,
  rankTestFiles,
  tokenName,
  type CandidateTest,
} from "../src/server/intentTestLinks";
import { NO_GITHUB_REMOTE, testLinkBase, testUrl } from "../src/server/intentTestUrl";
import { parseFeature, parseTestRef, serializeFeature } from "../src/server/parser";

const drafted = planExtractedFeature(
  {
    title: "Quotes",
    description: "What quoting does.",
    scenarios: [
      { name: "A quote is priced", body: "- Given: a home\n- Then: a price", files: ["src/quote.ts", "tests/quote.test.ts"] },
      { name: "A bad address is refused", body: "- Given: no address\n- Then: an error", files: ["src/address.ts"] },
    ],
    skipped: "",
  },
  ["packages/api", ""],
).text;

const tests: CandidateTest[] = [
  { id: "T1", path: "tests/quote.test.ts", name: "prices a quote", line: 12 },
  { id: "T2", path: "tests/quote.test.ts", name: "refuses a missing address", line: 30 },
  { id: "T3", path: "tests/other.test.ts", name: "something else", line: 4 },
];

const answer = (links: unknown) => ({ text: JSON.stringify({ links }), isError: false });

describe("what a feature says of its code", () => {
  test("the directories a feature was extracted from are read back from its first line", () => {
    expect(extractedRoots(drafted)).toEqual(["packages/api", ""]);
  });

  test("a feature with no extracted-from line names no directories", () => {
    expect(extractedRoots("# Quotes\n\nWritten by hand.\n\n## S1: A quote @v1 [proposed]\n\n- Given: x\n")).toBeNull();
    // A line of that shape inside a scenario is the scenario's own text.
    expect(extractedRoots("# Quotes\n\n## S1: A quote @v1 [proposed]\n\n_Extracted from `src`._\n")).toBeNull();
  });

  test("the files a scenario rests on are read back from its source line", () => {
    const feature = parseFeature(drafted);
    expect(sourceFiles(feature.scenarios[0]!.body)).toEqual(["src/quote.ts", "tests/quote.test.ts"]);
    expect(sourceFiles("- Given: nothing named")).toEqual([]);
  });
});

describe("which tests a feature is shown", () => {
  test("tests a scenario names come first, then tests named after its source files, then the rest", () => {
    const ranked = rankTestFiles(
      ["tests/zeta.test.ts", "tests/address.test.ts", "tests/quote.test.ts", "tests/alpha.test.ts"],
      parseFeature(drafted),
    );
    expect(ranked).toEqual(["tests/quote.test.ts", "tests/address.test.ts", "tests/alpha.test.ts", "tests/zeta.test.ts"]);
    // What a test's file name says it tests, in each language's habit.
    expect(["tests/address.test.ts", "tests/test_billing.py", "src/test/QuoteServiceTest.java"].map(testedStem)).toEqual([
      "address",
      "billing",
      "quoteservice",
    ]);
  });

  test("every scenario in the file is offered for linking by its number", () => {
    expect(linkScenarios(parseFeature(drafted)).map((s) => [s.id, s.name])).toEqual([
      ["S1", "A quote is priced"],
      ["S2", "A bad address is refused"],
    ]);
  });
});

describe("what the agent is asked", () => {
  test("the prompt lists the scenarios and every test by id and marks tests whose text is not shown", () => {
    const prompt = linkPrompt(
      { project: "shop", feature: "Quotes" },
      linkScenarios(parseFeature(drafted)),
      "=== tests/quote.test.ts ===\ntest(…)\n",
      tests,
      ["tests/quote.test.ts"],
    );
    expect(prompt).toContain("Feature: Quotes");
    expect(prompt).toContain("S1: A quote is priced");
    expect(prompt).toContain("S2: A bad address is refused");
    expect(prompt).toContain("=== tests/quote.test.ts ===");
    expect(prompt).toContain("T1 tests/quote.test.ts — prices a quote\n");
    expect(prompt).toContain("T3 tests/other.test.ts — something else (text not shown)");
  });
});

describe("what of the agent's answer is kept", () => {
  const scenarios = linkScenarios(parseFeature(drafted));

  test("links to scenarios and tests the agent was shown are kept", () => {
    const links = linksFromResult(answer([{ scenario: "S1", tests: ["T1"] }, { scenario: "S2", tests: ["T2", "T3"] }]), scenarios, tests);
    expect([...links!]).toEqual([
      ["S1", ["T1"]],
      ["S2", ["T2", "T3"]],
    ]);
  });

  test("a scenario or a test the agent made up is dropped", () => {
    const links = linksFromResult(
      answer([{ scenario: "S9", tests: ["T1"] }, { scenario: "S1", tests: ["T77", "tests/quote.test.ts", "T1", "T1"] }, { scenario: "S2", tests: ["T404"] }]),
      scenarios,
      tests,
    );
    expect([...links!]).toEqual([["S1", ["T1"]]]);
  });

  test("a scenario keeps no more tests than the cap", () => {
    const many: CandidateTest[] = Array.from({ length: 12 }, (_, i) => ({ id: `T${i + 1}`, path: "t.test.ts", name: `test ${i}`, line: i + 1 }));
    const links = linksFromResult(answer([{ scenario: "S1", tests: many.map((t) => t.id) }]), scenarios, many);
    expect(links!.get("S1")).toHaveLength(MAX_LINKS_PER_SCENARIO);
  });

  test("an answer wrapped in words is read and an answer that is no answer is refused", () => {
    const wrapped = { text: 'Here you go:\n```json\n{"links": [{"scenario": "s2", "tests": ["t2"]}]}\n```', isError: false };
    expect([...linksFromResult(wrapped, scenarios, tests)!]).toEqual([["S2", ["T2"]]]);
    expect(linksFromResult({ text: "I could not tell.", isError: false }, scenarios, tests)).toBeNull();
    expect(linksFromResult({ text: '{"links": []}', isError: true }, scenarios, tests)).toBeNull();
    // No test checks anything: an answer all the same.
    expect(linksFromResult(answer([]), scenarios, tests)!.size).toBe(0);
  });
});

describe("what is added to the feature", () => {
  const url = (line: number) => `https://github.com/acme/shop/blob/main/tests/quote.test.ts#L${line}`;

  test("a linked scenario gets a named test link and the feature still parses the same", () => {
    const { feature, added } = addTestLinks(parseFeature(drafted), [
      { name: "A quote is priced", version: 1, tests: [{ name: "prices a quote", url: url(12) }] },
    ]);
    expect(added).toBe(1);
    const text = serializeFeature(feature);
    expect(text).toContain(`[test: prices a quote : ${url(12)} ]`);
    const again = parseFeature(text);
    expect(again.scenarios[0]!.tests.map(parseTestRef)).toEqual([{ name: "prices a quote", url: url(12) }]);
    expect(again.scenarios[0]!.body).toBe(parseFeature(drafted).scenarios[0]!.body);
    expect(again.scenarios[1]!.tests).toEqual([]);
  });

  test("links a scenario already has are kept and the same test is not added twice", () => {
    const before = parseFeature(drafted);
    before.scenarios[0]!.tests = [`prices a quote : ${url(10)}`, "https://github.com/acme/shop/blob/main/tests/hand.test.ts#L3"];
    const { feature, added } = addTestLinks(before, [
      {
        name: "A quote is priced",
        version: 1,
        // The same test two lines further down, a link it has by url, and a new one.
        tests: [
          { name: "prices a quote", url: url(12) },
          { name: "by hand", url: "https://github.com/acme/shop/blob/main/tests/hand.test.ts#L3" },
          { name: "refuses a missing address", url: url(30) },
        ],
      },
    ]);
    expect(added).toBe(1);
    expect(feature.scenarios[0]!.tests).toEqual([
      `prices a quote : ${url(10)}`,
      "https://github.com/acme/shop/blob/main/tests/hand.test.ts#L3",
      `refuses a missing address : ${url(30)}`,
    ]);
  });

  test("a scenario renamed since the agent read the feature gets no link", () => {
    const before = parseFeature(drafted);
    const { feature, added } = addTestLinks(before, [{ name: "A quote was priced", version: 1, tests: [{ name: "prices a quote", url: url(12) }] }]);
    expect(added).toBe(0);
    expect(feature).toBe(before);
  });

  test("a test title a token cannot carry is written without its colons and brackets", () => {
    expect(tokenName("bookkeeping: no new [version]")).toBe("bookkeeping no new [version");
    const { feature } = addTestLinks(parseFeature(drafted), [
      { name: "A quote is priced", version: 1, tests: [{ name: "pricing: the [base] rate", url: url(12) }] },
    ]);
    const again = parseFeature(serializeFeature(feature));
    expect(again.scenarios[0]!.tests.map(parseTestRef)).toEqual([{ name: "pricing the [base rate", url: url(12) }]);
  });
});

describe("where a project's test links point", () => {
  let root: string;
  const noGit = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const repo = async (origin: string | null) => {
    await mkdir(join(root, "shop", ".git"), { recursive: true });
    await writeFile(join(root, "shop", ".git", "config"), origin ? `[remote "origin"]\n\turl = ${origin}\n` : "[core]\n\tbare = false\n");
    await mkdir(join(root, "shop", "services", "api"), { recursive: true });
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "specdriven-testurl-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a project on github.com links to its repository's default branch", async () => {
    await repo("git@github.com:acme/shop.git");
    const git = async (_cwd: string, args: string[]) =>
      args[0] === "remote"
        ? { exitCode: 0, stdout: "origin\n", stderr: "" }
        : args[0] === "symbolic-ref"
          ? { exitCode: 0, stdout: "origin/develop\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
    expect(await testLinkBase(join(root, "shop"), git)).toEqual({
      base: "https://github.com/acme/shop/blob/develop/",
      repo: "acme/shop",
      branch: "develop",
    });
  });

  test("a project that is a folder inside its repository links with the folder in the path", async () => {
    await repo("https://github.com/acme/shop.git");
    const target = await testLinkBase(join(root, "shop", "services", "api"), noGit);
    expect(target.base).toBe("https://github.com/acme/shop/blob/main/services/api/");
    expect(testUrl(target.base!, "src/test/My Test.java", 32)).toBe(
      "https://github.com/acme/shop/blob/main/services/api/src/test/My%20Test.java#L32",
    );
  });

  test("a project with no repository on github.com has nowhere for links to point", async () => {
    await repo("https://github.example.com/acme/shop.git");
    expect(await testLinkBase(join(root, "shop"), noGit)).toEqual({ base: null, problem: NO_GITHUB_REMOTE });
    await rm(join(root, "shop"), { recursive: true });
    await repo(null);
    expect(await testLinkBase(join(root, "shop"), noGit)).toEqual({ base: null, problem: NO_GITHUB_REMOTE });
    await mkdir(join(root, "plain"), { recursive: true });
    expect((await testLinkBase(join(root, "plain"), noGit)).base).toBeNull();
  });
});
