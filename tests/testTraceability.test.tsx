import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/frontend/markdown";
import { TEST_REF_RE, renderTestInEditor, testName } from "../src/frontend/testref";
import type { RenderTestInEditor } from "../src/frontend/testref";
import { parseFeature, serializeFeature } from "../src/server/parser";

// specs/external-links/test-traceability.feature.md: a test is traced to an
// individual spec (a scenario or one of its rules) by writing `[test:<url>]`
// in the feature markdown; the RenderTestInEditor interface formats it for
// display as the test's name — `QuoteHomeownersPolicyTest`.

const URL =
  "https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/QuoteHomeownersPolicyTest.java#L32";

const html = (src: string) => renderToStaticMarkup(<>{renderMarkdown(src)}</>);

describe("testName", () => {
  test("is the file name without extension, line anchor or query", () => {
    expect(testName(URL)).toBe("QuoteHomeownersPolicyTest");
    expect(testName("https://github.com/o/r/blob/main/t/bind.test.ts")).toBe("bind.test");
    expect(testName("https://github.com/o/r/blob/main/t/Spec.java?plain=1#L3")).toBe("Spec");
    expect(testName("  https://github.com/o/r/blob/main/t/Spec.java  ")).toBe("Spec");
  });

  test("keeps a segment with no extension and decodes an escaped one", () => {
    expect(testName("https://github.com/o/r/blob/main/t/Makefile")).toBe("Makefile");
    expect(testName("https://github.com/o/r/blob/main/t/Quote%20Test.java")).toBe("Quote Test");
  });

  test("falls back to the url when there is no path", () => {
    expect(testName("https://github.com")).toBe("https://github.com");
    expect(testName("https://github.com/")).toBe("https://github.com/");
  });
});

describe("RenderTestInEditor", () => {
  test("the default renders the name, the full url as href and title", () => {
    expect(renderTestInEditor.render(URL)).toEqual({
      label: "QuoteHomeownersPolicyTest",
      href: URL,
      title: URL,
    });
  });

  test("a url the preview may not follow gets no href", () => {
    expect(renderTestInEditor.render("javascript:alert(1)").href).toBeNull();
    expect(renderTestInEditor.render("src/test/Foo.java").href).toBeNull();
  });

  test("the interface admits another display rule", () => {
    const short: RenderTestInEditor = {
      render: (url) => ({ label: testName(url).slice(0, 5), href: url, title: url }),
    };
    expect(short.render(URL).label).toBe("Quote");
  });
});

describe("[test:<url>] in markdown", () => {
  test("matches the token and captures the url, with or without spaces around it", () => {
    expect(`[test:${URL}]`.match(TEST_REF_RE)?.groups?.url).toBe(URL);
    expect(`[test: ${URL} ]`.match(TEST_REF_RE)?.groups?.url).toBe(URL);
    expect("[test: two words ]".match(TEST_REF_RE)).toBeNull();
    expect("[tests:x]".match(TEST_REF_RE)).toBeNull();
  });

  test("the spaced form the feature files use renders the same link", () => {
    expect(html(`[test: ${URL} ]`)).toBe(
      `<p><a class="test-ref" href="${URL}" target="_blank" rel="noreferrer" title="${URL}">QuoteHomeownersPolicyTest</a></p>`,
    );
  });

  test("renders as a link named after the test, opening in a new tab", () => {
    expect(html(`Covered by [test:${URL}].`)).toBe(
      `<p>Covered by <a class="test-ref" href="${URL}" target="_blank" rel="noreferrer" title="${URL}">QuoteHomeownersPolicyTest</a>.</p>`,
    );
  });

  test("traces a single rule inside a scenario", () => {
    const out = html(`- **Then** the quote is priced [test:${URL}]\n- **And** it is logged`);
    expect(out).toContain("<li>");
    expect(out).toContain(">QuoteHomeownersPolicyTest</a></li>");
    expect(out).toContain("<li><strong>And</strong> it is logged</li>");
  });

  test("an unsafe url stays as literal text", () => {
    expect(html("[test:javascript:alert(1)]")).toBe("<p>[test:javascript:alert(1)]</p>");
  });

  test("inside inline code it is code, not a link", () => {
    expect(html(`\`[test:${URL}]\``)).toBe(`<p><code>[test:${URL}]</code></p>`);
  });

  test("an ordinary markdown link is unaffected", () => {
    expect(html("[test:x](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer">test:x</a></p>',
    );
  });
});

// `[test: <name> : <url> ]` names the test function the url's line anchor
// points at; the preview shows that name instead of the file's.

describe("[test:<name>:<url>] in markdown", () => {
  test("captures the name and the url, spaced or not", () => {
    const spaced = `[test: quotesAHomeownersPolicy : ${URL} ]`.match(TEST_REF_RE)?.groups;
    expect(spaced?.name).toBe("quotesAHomeownersPolicy");
    expect(spaced?.url).toBe(URL);
    const tight = `[test:quotesAHomeownersPolicy:${URL}]`.match(TEST_REF_RE)?.groups;
    expect(tight?.name).toBe("quotesAHomeownersPolicy");
    expect(tight?.url).toBe(URL);
    expect(`[test: a name with spaces : ${URL} ]`.match(TEST_REF_RE)?.groups?.name).toBe("a name with spaces");
  });

  test("a bare url has no name, and its scheme is never taken for one", () => {
    const g = `[test: ${URL} ]`.match(TEST_REF_RE)?.groups;
    expect(g?.name).toBeUndefined();
    expect(g?.url).toBe(URL);
  });

  test("renders as a link reading the test's name, the full url on the tooltip", () => {
    expect(html(`[test: quotesAHomeownersPolicy : ${URL} ]`)).toBe(
      `<p><a class="test-ref" href="${URL}" target="_blank" rel="noreferrer" title="${URL}">quotesAHomeownersPolicy</a></p>`,
    );
  });

  test("the default rule prefers the name and falls back to the file name", () => {
    expect(renderTestInEditor.render(URL, "quotesAHomeownersPolicy").label).toBe("quotesAHomeownersPolicy");
    expect(renderTestInEditor.render(URL, "  ").label).toBe("QuoteHomeownersPolicyTest");
    expect(renderTestInEditor.render(URL).label).toBe("QuoteHomeownersPolicyTest");
  });

  test("a name in front of something that is not a url is literal text", () => {
    expect(html("[test:javascript:alert(1)]")).toBe("<p>[test:javascript:alert(1)]</p>");
    expect(html("[test: name : ftp://x ]")).toBe("<p>[test: name : ftp://x ]</p>");
  });
});

test("a named reference inside a rule stays in the scenario body across a parse/serialize round trip", () => {
  const text = `# F\n\n## S @v1 [published]\n\n- **Then** the quote is priced [test: quotesAHomeownersPolicy : ${URL} ]\n`;
  const feature = parseFeature(text);
  expect(feature.scenarios[0]!.body).toContain(`[test: quotesAHomeownersPolicy : ${URL} ]`);
  expect(feature.scenarios[0]!.tests).toEqual([]);
  expect(serializeFeature(feature)).toBe(text);
});

test("a named reference on a line of its own is the scenario's test link, written back as that line", () => {
  const text = `# F\n\n## S @v1 [published]\n\n- **Then** the quote is priced\n\n[test: quotesAHomeownersPolicy : ${URL} ]\n`;
  const feature = parseFeature(text);
  expect(feature.scenarios[0]!.body).toBe("- **Then** the quote is priced");
  expect(feature.scenarios[0]!.tests).toEqual([`quotesAHomeownersPolicy : ${URL}`]);
  expect(serializeFeature(feature)).toBe(text);
});

test("a reference inside a rule stays in the scenario body across a parse/serialize round trip", () => {
  const text = `# F\n\n## S @v1 [published]\n\n- **Then** the quote is priced [test: ${URL} ]\n`;
  const feature = parseFeature(text);
  expect(feature.scenarios[0]!.body).toContain(`[test: ${URL} ]`);
  expect(feature.scenarios[0]!.tests).toEqual([]);
  expect(serializeFeature(feature)).toBe(text);
});

test("a reference on a line of its own is the scenario's test link, written back as that line", () => {
  const text = `# F\n\n## S @v1 [published]\n\n- **Then** the quote is priced\n\n[test: ${URL} ]\n`;
  const feature = parseFeature(text);
  expect(feature.scenarios[0]!.body).toBe("- **Then** the quote is priced");
  expect(feature.scenarios[0]!.tests).toEqual([URL]);
  expect(serializeFeature(feature)).toBe(text);
});
