// Automates specs/external-links/jira-wiki-import.feature.md where no
// service is involved: which urls are sources, what the agent is asked and
// held to, how its answer is read, and the feature file the review step
// writes.

import { describe, expect, test } from "bun:test";
import { parseFeature } from "../src/server/parser";
import {
  classifySource,
  cleanName,
  MAX_SCENARIOS,
  planImportedFeature,
  proposalFromResult,
  proposePrompt,
  PROPOSAL_SCHEMA,
  sourcesProblem,
  type SourceRef,
} from "../src/server/jiraWikiImport";

const jira = (n: number): SourceRef => ({
  kind: "jira",
  url: `https://jira.acme.com/browse/ABC-${n}`,
  base: "https://jira.acme.com",
  key: `ABC-${n}`,
});
const wiki = (n: number): SourceRef => ({
  kind: "wiki",
  url: `https://wiki.acme.com/pages/${n}`,
  base: "https://wiki.acme.com",
  page: { base: "https://wiki.acme.com", pageId: String(n) },
});

describe("a source url", () => {
  test("is a Jira issue, a Confluence page, or nothing", () => {
    expect(classifySource(" https://jira.acme.com/browse/ABC-1 ")).toEqual(jira(1));
    expect(classifySource("https://wiki.acme.com/spaces/ABC/pages/5/Home")).toMatchObject({
      kind: "wiki",
      base: "https://wiki.acme.com",
      page: { pageId: "5", spaceKey: "ABC" },
    });
    expect(classifySource("https://wiki.acme.com/display/ABC/Home+Page")).toMatchObject({
      kind: "wiki",
      page: { spaceKey: "ABC", title: "Home Page" },
    });
    expect(classifySource("https://acme.aha.io/features/APP-1")).toBeNull();
    expect(classifySource("")).toBeNull();
  });

  test("at most five of each kind, and at least one", () => {
    expect(sourcesProblem([])).toMatch(/at least one/);
    expect(sourcesProblem([1, 2, 3, 4, 5].map(jira))).toBeNull();
    expect(sourcesProblem([1, 2, 3, 4, 5, 6].map(jira))).toMatch(/At most 5 Jira/);
    expect(sourcesProblem([...[1, 2, 3, 4, 5].map(jira), ...[1, 2, 3, 4, 5].map(wiki)])).toBeNull();
    expect(sourcesProblem([1, 2, 3, 4, 5, 6].map(wiki))).toMatch(/At most 5 Confluence/);
  });
});

describe("the agent's turn", () => {
  const sources = [
    { kind: "jira" as const, url: "https://jira.acme.com/browse/ABC-1", title: "ABC-1", text: "Summary: Quotes" },
    { kind: "wiki" as const, url: "https://wiki.acme.com/pages/5", title: "Quote Policy", text: "Quotes are **free**." },
  ];

  test("shows each source with its url and text, and what has been proposed already", () => {
    const prompt = proposePrompt(sources, ["Basic quote", "Declined quote"]);
    expect(prompt).toContain("### Source 1: Jira issue ABC-1\nhttps://jira.acme.com/browse/ABC-1\n\nSummary: Quotes");
    expect(prompt).toContain("### Source 2: Confluence page “Quote Policy”");
    expect(prompt).toContain("do not repeat them");
    expect(prompt).toContain("- Basic quote\n- Declined quote");
    expect(prompt).toContain(`at most ${MAX_SCENARIOS} scenarios`);
    expect(proposePrompt(sources)).not.toContain("do not repeat");
  });

  test("is held to a title, at most fifteen scenarios and the names of the rest", () => {
    expect(PROPOSAL_SCHEMA).toMatchObject({
      required: ["title", "scenarios", "more"],
      properties: { scenarios: { maxItems: MAX_SCENARIOS } },
    });
  });

  test("a structured answer, or JSON in the words, is a proposal; anything else is none", () => {
    const answer = {
      title: "Quote Policy",
      scenarios: [
        { name: "Basic quote", body: "- Given: an account\n- Then: a quote", sources: ["ABC-1"] },
        { name: "basic quote", body: "a repeat" },
        { name: "", body: "nameless" },
        { name: "Declined quote", body: "- Given: no account" },
      ],
      more: ["Renewal", "", "Expiry"],
    };
    const fromStructured = proposalFromResult({ text: "", structured: answer, isError: false });
    expect(fromStructured).toEqual({
      title: "Quote Policy",
      scenarios: [
        { name: "Basic quote", body: "- Given: an account\n- Then: a quote", sources: ["ABC-1"] },
        { name: "Declined quote", body: "- Given: no account", sources: [] },
      ],
      more: ["Renewal", "Expiry"],
    });
    const fromText = proposalFromResult({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, isError: false });
    expect(fromText).toEqual(fromStructured);
    expect(proposalFromResult({ text: "I cannot", isError: false })).toBeNull();
    expect(proposalFromResult({ text: '{"title":"T","scenarios":[]}', isError: false })).toBeNull();
    expect(proposalFromResult({ text: "", structured: answer, isError: true })).toBeNull();
  });

  test("more than fifteen scenarios in one answer are cut to fifteen", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `S ${i}`, body: "b" }));
    const proposal = proposalFromResult({ text: "", structured: { title: "T", scenarios: many, more: [] }, isError: false });
    expect(proposal?.scenarios).toHaveLength(MAX_SCENARIOS);
  });
});

describe("a proposed name", () => {
  test("loses what the heading syntax would misread, and is one line", () => {
    expect(cleanName("S3: Basic   quote @v2 [published]")).toBe("Basic quote");
    expect(cleanName("## Quotes / Renewals\n")).toBe("Quotes - Renewals");
    expect(cleanName("x".repeat(300))).toHaveLength(200);
    expect(cleanName("  ")).toBe("");
  });
});

describe("the feature file", () => {
  const sources = [
    { kind: "jira" as const, url: "https://jira.acme.com/browse/ABC-1", title: "ABC-1" },
    { kind: "jira" as const, url: "https://jira.acme.com/browse/ABC-2", title: "ABC-2" },
    { kind: "wiki" as const, url: "https://wiki.acme.com/pages/5", title: "Quote [Policy]" },
  ];

  test("names the sources under the title, each scenario proposed and numbered in the agent's order, with its body and where it came from", () => {
    const { name, text } = planImportedFeature(
      "Quote Policy",
      [
        { name: "Declined quote", body: "- Given: no account" },
        { name: "Basic quote", body: "- Given: an account\n- Then: a quote", sources: ["ABC-1"] },
      ],
      sources,
    );
    expect(name).toBe("Quote Policy");
    expect(text).toBe(
      [
        "# Quote Policy",
        "",
        "_Imported from Jira [ABC-1](https://jira.acme.com/browse/ABC-1), [ABC-2](https://jira.acme.com/browse/ABC-2) and Confluence [Quote Policy](https://wiki.acme.com/pages/5)._",
        "",
        "## S1: Declined quote @v1 [proposed]",
        "",
        "- Given: no account",
        "",
        "## S2: Basic quote @v1 [proposed]",
        "",
        "- Given: an account",
        "- Then: a quote",
        "",
        "_From ABC-1._",
        "",
      ].join("\n"),
    );
    const feature = parseFeature(text);
    expect(feature.name).toBe("Quote Policy");
    expect(feature.link).toBeUndefined();
    // Numbered, so the agent's order survives the parser's name sort.
    expect(feature.scenarios.map((s) => [s.name, s.status])).toEqual([
      ["Declined quote", "proposed"],
      ["Basic quote", "proposed"],
    ]);
  });

  test("names are cleaned and repeats told apart; a body keeps nothing the parser would lift out", () => {
    const { text } = planImportedFeature(
      "S1: Quotes @v3 [draft]",
      [
        { name: "Same", body: "# not a heading\n[test: nope : https://x ]\n[Jira:ABC-1](https://j)\nplain" },
        { name: "same", body: "" },
        { name: "", body: "" },
      ],
      [],
    );
    expect(text.startsWith("# Quotes\n\n## S1: Same @v1 [proposed]\n")).toBe(true);
    expect(text).toContain("\\# not a heading\n\\[test: nope : https://x ]\n\\[Jira:ABC-1](https://j)\nplain");
    expect(text).toContain("## S2: same (2) @v1 [proposed]");
    expect(text).toContain("## S3: Scenario @v1 [proposed]");
    const feature = parseFeature(text);
    expect(feature.scenarios).toHaveLength(3);
    expect(feature.scenarios[0]!.tests).toEqual([]);
    expect(feature.scenarios[0]!.link).toBeUndefined();
  });
});
