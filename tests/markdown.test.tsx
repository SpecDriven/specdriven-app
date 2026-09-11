import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  imageRefs,
  insertImage,
  insertLink,
  renderMarkdown,
  setImageWidth,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "../src/frontend/markdown";

// React's server renderer hoists a preload <link> for every image in the
// markup; only the content is under test here.
const html = (src: string) =>
  renderToStaticMarkup(<>{renderMarkdown(src)}</>).replace(/<link rel="preload"[^>]*\/>/g, "");

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

  // specs/images.spec.md: `![alt](url)` is what a paste inserts; the sized
  // form the Preview tab's handle writes is the one HTML tag rendered.
  describe("images", () => {
    test("markdown image", () => {
      expect(html("![shot](/api/images/shot-1a2b3c4d.png)")).toBe(
        '<p><img src="/api/images/shot-1a2b3c4d.png" alt="shot"/></p>',
      );
    });

    test("an <img> tag renders with its src, alt, width and height", () => {
      expect(html('<img src="/x.png" alt="shot" width="320">')).toBe(
        '<p><img src="/x.png" alt="shot" width="320"/></p>',
      );
      expect(html("see <img src='/x.png' width=50% height=\"20\" /> here")).toBe(
        '<p>see <img src="/x.png" alt="" width="50%" height="20"/> here</p>',
      );
      expect(html('<img SRC="/x.png" ALT="a &amp; b">')).toBe('<p><img src="/x.png" alt="a &amp; b"/></p>');
    });

    test("anything else on the tag is dropped; a bad size is no size", () => {
      expect(html('<img src="/x.png" onerror="alert(1)" style="x" class="y" width="wide">')).toBe(
        '<p><img src="/x.png" alt=""/></p>',
      );
      // A hand-typed "px" is read the way browsers read it.
      expect(html('<img src="/x.png" width="320px">')).toBe('<p><img src="/x.png" alt="" width="320"/></p>');
    });

    test("an unsafe or missing src leaves the tag as text", () => {
      for (const src of ['<img src="javascript:alert(1)">', '<img src="data:x">', '<img alt="no src">', "<img>"]) {
        const out = html(src);
        expect(out).not.toContain("<img");
        expect(out).toContain("&lt;img");
      }
      const md = html("![x](javascript:alert(1))");
      expect(md).not.toContain("<img");
    });

    test("other html stays escaped", () => {
      const out = html('<image src="/x.png"><script>x</script>');
      expect(out).not.toContain("<image");
      expect(out).not.toContain("<script");
      expect(out).toContain("&lt;script&gt;");
    });
  });
});

// specs/images.spec.md: the preview finds every image and where it sits in
// the source, in the order it shows them — through quotes, tables and
// formatting, but not inside code, which the preview does not render.
describe("imageRefs", () => {
  test("places each image in the source", () => {
    const text = "Given ![shot](/api/images/shot-1a2b3c4d.png) here";
    const refs = imageRefs(text);
    expect(refs).toHaveLength(1);
    const r = refs[0]!;
    expect(text.slice(r.start, r.end)).toBe("![shot](/api/images/shot-1a2b3c4d.png)");
    expect(r).toMatchObject({ src: "/api/images/shot-1a2b3c4d.png", alt: "shot", width: null, height: null });
  });

  test("follows the preview's order and skips code", () => {
    const text = [
      "```",
      "![in code](/nope.png)",
      "```",
      "> quoted ![one](/1.png)",
      "| a | b |",
      "| --- | --- |",
      '| ![two](/2.png) | <img src="/3.png" alt="three" width="120"> |',
      "`![inline code](/nope.png)` and **bold ![four](/4.png)**",
      "- [ ] task ![five](/5.png)",
    ].join("\n");
    const refs = imageRefs(text);
    expect(refs.map((r) => r.alt)).toEqual(["one", "two", "three", "four", "five"]);
    expect(refs.map((r) => text.slice(r.start, r.end))).toEqual([
      "![one](/1.png)",
      "![two](/2.png)",
      '<img src="/3.png" alt="three" width="120">',
      "![four](/4.png)",
      "![five](/5.png)",
    ]);
    expect(refs[2]!.width).toBe("120");
  });

  test("reads the tag's attributes back, entities decoded", () => {
    const [r] = imageRefs('<img alt="say &quot;hi&quot; &amp; bye" src="/x.png" height="40">');
    expect(r).toMatchObject({ src: "/x.png", alt: 'say "hi" & bye', width: null, height: "40" });
  });

  test("an image whose url is refused is not one", () => {
    expect(imageRefs("![x](javascript:alert(1)) ![y](/y.png)").map((r) => r.alt)).toEqual(["y"]);
  });
});

// specs/images.spec.md: the Preview tab's handle writes the width into the
// source as an <img> tag; the natural size puts the markdown form back.
describe("setImageWidth", () => {
  test("turns the markdown form into a sized tag", () => {
    expect(setImageWidth("a ![shot](/x.png) b", 0, 320)).toBe('a <img src="/x.png" alt="shot" width="320"> b');
  });

  test("targets the nth image only", () => {
    expect(setImageWidth("![a](/1.png) ![b](/2.png)", 1, 200)).toBe(
      '![a](/1.png) <img src="/2.png" alt="b" width="200">',
    );
  });

  test("re-sizes a tag, dropping a height so the proportions hold", () => {
    expect(setImageWidth('<img src="/x.png" alt="s" width="320" height="200">', 0, 100.4)).toBe(
      '<img src="/x.png" alt="s" width="100">',
    );
  });

  test("the natural size is the markdown form again", () => {
    expect(setImageWidth('<img src="/x.png" alt="shot" width="320">', 0, null)).toBe("![shot](/x.png)");
    expect(setImageWidth("![shot](/x.png)", 0, null)).toBe("![shot](/x.png)");
  });

  test("an alt or url the markdown form cannot carry keeps the tag", () => {
    expect(setImageWidth('<img src="/x.png" alt="a]b" width="1">', 0, null)).toBe('<img src="/x.png" alt="a]b">');
    expect(setImageWidth('<img src="/x(1).png" alt="a" width="1">', 0, null)).toBe('<img src="/x(1).png" alt="a">');
  });

  test("quotes in the alt survive the round trip", () => {
    const sized = setImageWidth('![say "hi"](/x.png)', 0, 50);
    expect(sized).toBe('<img src="/x.png" alt="say &quot;hi&quot;" width="50">');
    expect(html(sized)).toBe('<p><img src="/x.png" alt="say &quot;hi&quot;" width="50"/></p>');
    expect(setImageWidth(sized, 0, null)).toBe('![say "hi"](/x.png)');
  });

  test("a width is whole pixels, at least one", () => {
    expect(setImageWidth("![a](/x.png)", 0, 0)).toContain('width="1"');
    expect(setImageWidth("![a](/x.png)", 0, 99.5)).toContain('width="100"');
  });

  test("leaves the text alone when there is no such image, or no such width", () => {
    expect(setImageWidth("no images", 0, 100)).toBe("no images");
    expect(setImageWidth("![a](/x.png)", 1, 100)).toBe("![a](/x.png)");
    expect(setImageWidth("![a](/x.png)", 0, NaN)).toBe("![a](/x.png)");
    expect(setImageWidth("![a](/x.png)", 0, Infinity)).toBe("![a](/x.png)");
  });

  test("reads CRLF as the preview does", () => {
    expect(setImageWidth("x\r\n![a](/1.png)", 0, 10)).toBe('x\n<img src="/1.png" alt="a" width="10">');
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

// specs/images.spec.md: uploads insert `![alt](url)` at the caret.
describe("insertImage", () => {
  test("inserts at the caret and leaves the caret after it", () => {
    const r = insertImage("before after", 7, 7, "shot", "/api/images/shot-1a2b3c4d.png");
    expect(r.text).toBe("before ![shot](/api/images/shot-1a2b3c4d.png)after");
    expect(r.start).toBe(r.end);
    expect(r.text.slice(0, r.start)).toBe("before ![shot](/api/images/shot-1a2b3c4d.png)");
  });

  test("a selection becomes the alt text", () => {
    const r = insertImage("the diagram", 4, 11, "ignored", "/api/images/d-1.png");
    expect(r.text).toBe("the ![diagram](/api/images/d-1.png)");
  });
});
