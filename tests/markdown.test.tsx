import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  insertLink,
  renderMarkdown,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "../src/frontend/markdown";

const html = (src: string) => renderToStaticMarkup(<>{renderMarkdown(src)}</>);

describe("renderMarkdown", () => {
  test("headings", () => {
    expect(html("## Given a policy")).toBe("<h2>Given a policy</h2>");
    expect(html("# H1\n### H3")).toBe("<h1>H1</h1><h3>H3</h3>");
  });

  test("paragraph keeps soft line breaks", () => {
    expect(html("Given a car\nWhen it crashes")).toBe("<p>Given a car<br/>When it crashes</p>");
  });

  test("blank input renders nothing", () => {
    expect(renderMarkdown("")).toBeNull();
    expect(renderMarkdown("  \n \n")).toBeNull();
  });

  test("inline bold, italic, strike and code", () => {
    expect(html("a **bold** move")).toBe("<p>a <strong>bold</strong> move</p>");
    expect(html("an *italic* word")).toBe("<p>an <em>italic</em> word</p>");
    expect(html("an _italic_ word")).toBe("<p>an <em>italic</em> word</p>");
    expect(html("~~gone~~")).toBe("<p><del>gone</del></p>");
    expect(html("run `bun test` now")).toBe("<p>run <code>bun test</code> now</p>");
  });

  test("snake_case identifiers are not italicized", () => {
    expect(html("record_car_accident feature")).toBe("<p>record_car_accident feature</p>");
  });

  test("nested emphasis inside bold", () => {
    expect(html("**bold *and* nested**")).toBe(
      "<p><strong>bold <em>and</em> nested</strong></p>",
    );
  });

  test("links: safe href kept, javascript: stripped", () => {
    expect(html("[docs](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer">docs</a></p>',
    );
    const evil = html("[x](javascript:alert(1))");
    expect(evil).not.toContain("javascript:");
    expect(evil).not.toContain("<a");
  });

  test("raw html is escaped, not injected", () => {
    expect(html("<script>alert(1)</script>")).not.toContain("<script>");
  });

  test("unordered and ordered lists", () => {
    expect(html("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(html("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  test("task list items render checkboxes", () => {
    const out = html("- [x] done\n- [ ] todo");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("checked");
  });

  test("fenced code block", () => {
    expect(html("```\nGiven <x>\n```")).toBe("<pre><code>Given &lt;x&gt;</code></pre>");
  });

  test("blockquote", () => {
    expect(html("> a note")).toBe("<blockquote><p>a note</p></blockquote>");
  });

  test("horizontal rule", () => {
    expect(html("---")).toBe("<hr/>");
  });

  test("table", () => {
    const out = html("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>2</td>");
  });
});

describe("toggleInline", () => {
  test("wraps a selection", () => {
    expect(toggleInline("hello world", 0, 5, "**")).toEqual({
      text: "**hello** world",
      start: 2,
      end: 7,
    });
  });

  test("unwraps when the selection includes the markers", () => {
    expect(toggleInline("**hello** world", 0, 9, "**")).toEqual({
      text: "hello world",
      start: 0,
      end: 5,
    });
  });

  test("unwraps when the markers surround the selection", () => {
    expect(toggleInline("**hello** world", 2, 7, "**")).toEqual({
      text: "hello world",
      start: 0,
      end: 5,
    });
  });

  test("empty selection inserts a marker pair with the caret inside", () => {
    expect(toggleInline("ab", 1, 1, "*")).toEqual({ text: "a**b", start: 2, end: 2 });
  });
});

describe("toggleLinePrefix", () => {
  test("prefixes every selected line", () => {
    const r = toggleLinePrefix("one\ntwo", 0, 7, () => "- ", /^[-*+] /);
    expect(r.text).toBe("- one\n- two");
    expect([r.start, r.end]).toEqual([0, 11]);
  });

  test("removes the prefix when all lines have it", () => {
    const r = toggleLinePrefix("- one\n- two", 0, 11, () => "- ", /^[-*+] /);
    expect(r.text).toBe("one\ntwo");
  });

  test("numbered prefix counts per line", () => {
    const r = toggleLinePrefix("a\nb", 0, 3, (i) => `${i + 1}. `, /^\d+[.)] /);
    expect(r.text).toBe("1. a\n2. b");
  });

  test("expands a mid-line caret to whole lines", () => {
    const r = toggleLinePrefix("one\ntwo", 5, 5, () => "> ", /^> /);
    expect(r.text).toBe("one\n> two");
  });
});

describe("toggleHeading", () => {
  test("adds a heading", () => {
    expect(toggleHeading("title", 0, 5).text).toBe("## title");
  });

  test("replaces a different level", () => {
    expect(toggleHeading("# title", 0, 7).text).toBe("## title");
  });

  test("removes the same level", () => {
    expect(toggleHeading("## title", 0, 8).text).toBe("title");
  });
});

describe("insertLink", () => {
  test("wraps the selection and selects the url placeholder", () => {
    const r = insertLink("see docs", 4, 8);
    expect(r.text).toBe("see [docs](url)");
    expect(r.text.slice(r.start, r.end)).toBe("url");
  });

  test("empty selection inserts a template", () => {
    const r = insertLink("", 0, 0);
    expect(r.text).toBe("[text](url)");
    expect(r.text.slice(r.start, r.end)).toBe("url");
  });
});
