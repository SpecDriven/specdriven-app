// specs/search.feature.md: the words a hit matched on are marked where the hit
// lands — in the palette's snippet and in the editor the hit opens, source
// and preview alike — and the marks agree because one helper makes them.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { markNodes, markText, termsPattern } from "../src/frontend/highlight";
import { renderMarkdown } from "../src/frontend/markdown";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("markText", () => {
  test("wraps every occurrence, whatever its case", () => {
    expect(html(markText("Premium rules the premium", ["premium"]))).toBe(
      "<mark>Premium</mark> rules the <mark>premium</mark>",
    );
  });

  test("several terms mark independently", () => {
    expect(html(markText("a quote for a policy", ["quote", "policy"]))).toBe(
      "a <mark>quote</mark> for a <mark>policy</mark>",
    );
  });

  test("a prefix search's stem and its longer form mark the whole word", () => {
    expect(html(markText("our agents ask an agent", ["agent", "agents"]))).toBe(
      "our <mark>agents</mark> ask an <mark>agent</mark>",
    );
  });

  test("terms are literal text, not patterns", () => {
    expect(html(markText("a.b or axb", ["a.b"]))).toBe("<mark>a.b</mark> or axb");
    expect(termsPattern([])).toBeNull();
    expect(termsPattern([""])).toBeNull();
  });

  test("text without a match is returned as it was", () => {
    expect(markText("nothing here", ["premium"])).toBe("nothing here");
    expect(markText("nothing here", [])).toBe("nothing here");
  });
});

describe("markNodes", () => {
  test("marks inside rendered markdown, through inline formatting", () => {
    const rendered = renderMarkdown("Given a **premium** policy\n\n- the premium is due");
    expect(html(markNodes(rendered, ["premium"]))).toBe(
      "<p>Given a <strong><mark>premium</mark></strong> policy</p><ul><li>the <mark>premium</mark> is due</li></ul>",
    );
  });

  test("attributes are left alone — only what is read is marked", () => {
    const rendered = renderMarkdown("[premium](https://example.com/premium)");
    expect(html(markNodes(rendered, ["premium"]))).toBe(
      '<p><a href="https://example.com/premium" target="_blank" rel="noreferrer"><mark>premium</mark></a></p>',
    );
  });

  test("no terms, no change", () => {
    const rendered = renderMarkdown("Given a premium policy");
    expect(markNodes(rendered, [])).toBe(rendered);
  });
});

describe("the editor opened from a hit", () => {
  test("the source carries the marks in a mirror behind the textarea", () => {
    const out = renderToStaticMarkup(
      <MarkdownEditor value="Given a premium policy" onChange={() => {}} highlight={["premium"]} />,
    );
    expect(out).toContain('class="md-write highlighted"');
    expect(out).toContain('<div class="md-highlights" aria-hidden="true">Given a <mark>premium</mark> policy\n</div>');
    // The textarea itself still holds the plain text.
    expect(out).toContain(">Given a premium policy</textarea>");
  });

  test("a published scenario's preview marks the rendered text", () => {
    const out = renderToStaticMarkup(
      <MarkdownEditor value="Given a premium policy" onChange={() => {}} readOnly highlight={["premium"]} />,
    );
    expect(out).toContain('<div class="md-preview"><p>Given a <mark>premium</mark> policy</p></div>');
  });

  test("without terms the editor is as it was — no mirror, no marks", () => {
    const out = renderToStaticMarkup(<MarkdownEditor value="Given a premium policy" onChange={() => {}} />);
    expect(out).toContain('class="md-write"');
    expect(out).not.toContain("md-highlights");
    expect(out).not.toContain("<mark>");
  });
});
