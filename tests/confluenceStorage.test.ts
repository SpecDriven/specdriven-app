// Automates specs/external-links/confluence-wiki.feature.md "What the page
// contains": a feature becomes Confluence storage format — its description,
// then each scenario under its name with its steps and its tests, but not its
// status or version — with everything taken from the feature escaped.

import { test, expect, describe } from "bun:test";
import {
  escapeXml,
  renderFeatureStorage,
  renderInlineStorage,
  renderMarkdownStorage,
  scenariosInScope,
} from "../src/server/confluenceStorage";
import { parseFeature } from "../src/server/parser";

/** The number a scenario heading leads with: an anchor and a link to it. */
const anchored = (n: number) =>
  `<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">S${n}</ac:parameter></ac:structured-macro>` +
  `<ac:link ac:anchor="S${n}"><ac:plain-text-link-body><![CDATA[S${n}]]></ac:plain-text-link-body></ac:link> · `;

const TEST_URL = "https://github.com/acme/app/blob/main/tests/quote.test.ts#L12";

const SAMPLE = `# Quote Policy

Quotes for **potential** customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided

[test: gives a quote : ${TEST_URL} ]

## Declined Quote @v2 [published]

Given the customer has no account
Then the quote is declined
`;

describe("inline", () => {
  test("escapes text, attributes included", () => {
    expect(escapeXml(`<script>"a" & 'b'</script>`)).toBe("&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;");
    expect(renderInlineStorage("a < b & <b>c</b>")).toBe("a &lt; b &amp; &lt;b&gt;c&lt;/b&gt;");
  });

  test("bold, italic, strike and code", () => {
    expect(renderInlineStorage("**b** *i* _u_ ~~s~~ `x<y`")).toBe(
      "<strong>b</strong> <em>i</em> <em>u</em> <del>s</del> <code>x&lt;y</code>",
    );
  });

  test("links only to safe destinations; a javascript url stays text", () => {
    expect(renderInlineStorage("[docs](https://acme.com/a?b=1&c=2)")).toBe(
      '<a href="https://acme.com/a?b=1&amp;c=2">docs</a>',
    );
    expect(renderInlineStorage("[bad](javascript:alert(1))")).not.toContain("<a");
  });

  test("a bare url is a link, its trailing punctuation left outside", () => {
    expect(renderInlineStorage("see https://acme.com/x.")).toBe('see <a href="https://acme.com/x">https://acme.com/x</a>.');
    expect(renderInlineStorage("<https://acme.com>")).toBe('<a href="https://acme.com">https://acme.com</a>');
  });

  test("a test reference is a link named after the test", () => {
    expect(renderInlineStorage(`[test: gives a quote : ${TEST_URL} ]`)).toBe(
      `<a href="${TEST_URL}" title="${TEST_URL}">gives a quote</a>`,
    );
  });

  test("an image on the web is embedded; one the app stores is its alt text", () => {
    expect(renderInlineStorage("![chart](https://acme.com/c.png)")).toBe(
      '<ac:image ac:alt="chart"><ri:url ri:value="https://acme.com/c.png" /></ac:image>',
    );
    expect(renderInlineStorage("![diagram](/api/images/abc.png)")).toBe("<em>diagram</em>");
    expect(renderInlineStorage('<img src="https://acme.com/d.png" alt="d" width="200">')).toContain(
      '<ri:url ri:value="https://acme.com/d.png" />',
    );
  });
});

describe("blocks", () => {
  test("paragraphs keep their soft breaks", () => {
    expect(renderMarkdownStorage("one\ntwo\n\nthree")).toBe("<p>one<br />two</p><p>three</p>");
  });

  test("headings are shifted under the heading they sit in, at most h6", () => {
    expect(renderMarkdownStorage("# A\n#### B", 2)).toBe("<h3>A</h3><h6>B</h6>");
  });

  test("lists, task items, quotes and rules", () => {
    expect(renderMarkdownStorage("- a\n- [x] done\n- [ ] todo")).toBe("<ul><li>a</li><li>☑ done</li><li>☐ todo</li></ul>");
    expect(renderMarkdownStorage("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(renderMarkdownStorage("> quoted\n> **too**")).toBe("<blockquote><p>quoted<br /><strong>too</strong></p></blockquote>");
    expect(renderMarkdownStorage("---")).toBe("<hr />");
  });

  test("tables, with a header row", () => {
    expect(renderMarkdownStorage("| age | rate |\n|---|---|\n| 17 | **high** |")).toBe(
      "<table><tbody><tr><th>age</th><th>rate</th></tr><tr><td>17</td><td><strong>high</strong></td></tr></tbody></table>",
    );
  });

  test("fenced code is a code macro, CDATA kept whole", () => {
    expect(renderMarkdownStorage("```json\n{\"a\": \"]]>\"}\n```")).toBe(
      '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">json</ac:parameter>' +
        '<ac:plain-text-body><![CDATA[{"a": "]]]]><![CDATA[>"}]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(renderMarkdownStorage("```\n<b>x</b>\n```")).toBe(
      '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:plain-text-body><![CDATA[<b>x</b>]]></ac:plain-text-body></ac:structured-macro>',
    );
  });
});

describe("the feature", () => {
  test("description, then each scenario with its steps and tests, no status or version", () => {
    const xhtml = renderFeatureStorage(parseFeature(SAMPLE), "all");
    expect(xhtml).toBe(
      "<p>Quotes for <strong>potential</strong> customers.</p>" +
        `<h2>${anchored(1)}Basic Quote</h2>` +
        "<ul><li><strong>Given</strong> a potential customer has an account</li><li><strong>Then</strong> a quote is provided</li></ul>" +
        `<p><strong>Tests</strong></p><ul><li><a href="${TEST_URL}" title="${TEST_URL}">gives a quote</a></li></ul>` +
        `<h2>${anchored(2)}Declined Quote</h2>` +
        "<p>Given the customer has no account<br />Then the quote is declined</p>",
    );
  });

  test("published only leaves the rest out", () => {
    const feature = parseFeature(SAMPLE);
    expect(scenariosInScope(feature, "published").map((s) => s.name)).toEqual(["Declined Quote"]);
    expect(scenariosInScope(feature, "all")).toHaveLength(2);
    const xhtml = renderFeatureStorage(feature, "published");
    expect(xhtml).toContain(`<h2>${anchored(2)}Declined Quote</h2>`);
    expect(xhtml).not.toContain("Basic Quote");
  });

  test("each scenario leads with its number, an anchor linking to itself, as in the app", () => {
    const feature = parseFeature(SAMPLE);
    feature.scenarios.splice(1, 0, { name: "Idea", version: 1, status: "draft", body: "", tests: [] });
    const headings = renderFeatureStorage(feature, "all").match(/<h2>.*?<\/h2>/g);
    expect(headings).toEqual([
      `<h2>${anchored(1)}Basic Quote</h2>`,
      "<h2>Idea</h2>",
      `<h2>${anchored(2)}Declined Quote</h2>`,
    ]);
    // A page of the published alone keeps the numbers, so a deep link reads the same.
    expect(renderFeatureStorage(feature, "published")).toContain(`<h2>${anchored(2)}Declined Quote</h2>`);
  });

  test("a draft shows no status or version, and a scenario name is escaped", () => {
    const feature = parseFeature("# F\n");
    feature.scenarios.push({ name: "A <b> & B", version: 3, status: "draft", body: "", tests: [] });
    const xhtml = renderFeatureStorage(feature, "all");
    expect(xhtml).toContain("<h2>A &lt;b&gt; &amp; B</h2>");
    expect(xhtml).toBe("<h2>A &lt;b&gt; &amp; B</h2>");
  });

  test("says so when no scenario is in scope", () => {
    expect(renderFeatureStorage(parseFeature("# F\n"), "published")).toBe("<p><em>No published scenarios yet.</em></p>");
  });
});

// specs/ui/scenario-polarity.feature.md "The Confluence page groups
// scenarios by polarity".
describe("polarity", () => {
  const POSITIVE = '<h1><span style="color: rgb(0,135,90);">Positive</span></h1>';
  const NEGATIVE = '<h1><span style="color: rgb(222,53,11);">Negative</span></h1>';
  const MIXED = SAMPLE.replace(
    "## Declined Quote @v2 [published]\n",
    "## Declined Quote @v2 [published]\n\n[negative]\n",
  );

  test("with the setting off the page is unchanged, marker or not", () => {
    expect(renderFeatureStorage(parseFeature(MIXED), "all")).toBe(renderFeatureStorage(parseFeature(SAMPLE), "all"));
    expect(renderFeatureStorage(parseFeature(MIXED), "all", { polarity: false })).not.toContain("Negative");
  });

  test("with it on, a green Positive section then a red Negative one, and no marker on the scenarios", () => {
    const xhtml = renderFeatureStorage(parseFeature(MIXED), "all", { polarity: true });
    expect(xhtml).toBe(
      "<p>Quotes for <strong>potential</strong> customers.</p>" +
        POSITIVE +
        `<h2>${anchored(1)}Basic Quote</h2>` +
        "<ul><li><strong>Given</strong> a potential customer has an account</li><li><strong>Then</strong> a quote is provided</li></ul>" +
        `<p><strong>Tests</strong></p><ul><li><a href="${TEST_URL}" title="${TEST_URL}">gives a quote</a></li></ul>` +
        NEGATIVE +
        `<h2>${anchored(2)}Declined Quote</h2>` +
        "<p>Given the customer has no account<br />Then the quote is declined</p>",
    );
  });

  test("a section with no scenario in scope is left out, and the numbers stay the feature's", () => {
    const feature = parseFeature(MIXED);
    const published = renderFeatureStorage(feature, "published", { polarity: true });
    expect(published).not.toContain("Positive");
    expect(published).toContain(`${NEGATIVE}<h2>${anchored(2)}Declined Quote</h2>`);
    const all = renderFeatureStorage(parseFeature(SAMPLE), "all", { polarity: true });
    expect(all).toContain(POSITIVE);
    expect(all).not.toContain("Negative");
    // A draft has no number; an empty scope still says so.
    feature.scenarios.push({ name: "Idea", version: 1, status: "draft", body: "", tests: [], negative: true });
    expect(renderFeatureStorage(feature, "all", { polarity: true })).toContain("<h2>Idea</h2>");
    expect(renderFeatureStorage(parseFeature("# F\n"), "all", { polarity: true })).toBe("<p><em>No scenarios yet.</em></p>");
  });
});
