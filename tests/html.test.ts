// Automates specs/external-links/aha-import.feature.md "The description
// becomes markdown": the HTML Aha! returns for a record becomes the markdown
// the spec editor reads — paragraphs, demoted headings, nested lists, marks,
// links, images as links, code, quotes and tables — with nothing that would
// read as a scenario heading, a block or a test link.

import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/server/html";

describe("paragraphs", () => {
  test("paragraphs are separated by a blank line, a br breaks the line inside one", () => {
    expect(htmlToMarkdown("<p>one</p><p>two<br>three</p>")).toBe("one\n\ntwo\nthree\n");
    expect(htmlToMarkdown("<div>a</div><div>b</div>")).toBe("a\n\nb\n");
  });

  test("whitespace collapses as in HTML, and an empty paragraph leaves no trace", () => {
    expect(htmlToMarkdown("<p>\n  a   b\n  c </p>\n<p><br></p>\n<p>&nbsp;</p><p>d</p>")).toBe("a b c\n\nd\n");
  });

  test("a rule is three dashes", () => {
    expect(htmlToMarkdown("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb\n");
  });

  test("plain text with no tags comes back as the same text, whitespace collapsed", () => {
    expect(htmlToMarkdown("Just   some\n text")).toBe("Just some text\n");
  });

  test("empty input is empty", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("<p></p><p> </p>")).toBe("");
  });
});

describe("headings", () => {
  test("every level is demoted to at least three hashes, deeper ones kept", () => {
    expect(htmlToMarkdown("<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>")).toBe(
      "### A\n\n### B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n",
    );
  });

  test("an h2 named like a scenario never becomes a scenario heading", () => {
    expect(htmlToMarkdown("<h2>Name @v1</h2>")).toBe("### Name @v1\n");
  });
});

describe("lists", () => {
  test("nested bullet lists indent by two spaces per level", () => {
    expect(htmlToMarkdown("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>")).toBe(
      "- a\n  - b\n    - c\n- d\n",
    );
  });

  test("a numbered list counts from its start, a nested one from one", () => {
    expect(htmlToMarkdown('<ol start="3"><li>three<ol><li>one</li><li>two</li></ol></li><li>four</li></ol>')).toBe(
      "3. three\n  1. one\n  2. two\n4. four\n",
    );
  });

  test("a checkbox becomes a task item", () => {
    expect(htmlToMarkdown('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>')).toBe(
      "- [x] done\n- [ ] todo\n",
    );
  });

  test("a paragraph inside an item stays inside it", () => {
    expect(htmlToMarkdown("<ul><li><p>first</p><p>second</p></li><li><p>next</p></li></ul>")).toBe(
      "- first\n\n  second\n- next\n",
    );
  });

  test("a list closes the paragraph before it, as a browser would", () => {
    expect(htmlToMarkdown("<p>intro<ul><li>a</li></ul>")).toBe("intro\n\n- a\n");
  });
});

describe("inline marks", () => {
  test("bold, italic, strike and underline", () => {
    expect(htmlToMarkdown("<p><strong>b</strong> <b>b</b> <em>i</em> <i>i</i> <s>s</s> <del>d</del> <u>u</u></p>")).toBe(
      "**b** **b** _i_ _i_ ~~s~~ ~~d~~ u\n",
    );
  });

  test("whitespace inside a mark moves outside it", () => {
    expect(htmlToMarkdown("<p>a<strong> b </strong>c</p>")).toBe("a **b** c\n");
  });

  test("code is backticked, with a longer run when it holds backticks", () => {
    expect(htmlToMarkdown("<p>run <code>bun test</code> or <code>a`b</code></p>")).toBe("run `bun test` or ``a`b``\n");
  });

  test("a link is a markdown link; a bare url, a relative one or none stays text", () => {
    expect(htmlToMarkdown('<p><a href="https://acme.com/x">Acme</a></p>')).toBe("[Acme](https://acme.com/x)\n");
    expect(htmlToMarkdown('<p><a href="https://acme.com/x">https://acme.com/x</a></p>')).toBe("https://acme.com/x\n");
    expect(htmlToMarkdown('<p><a href="/x">here</a> <a>there</a></p>')).toBe("here there\n");
  });

  test("an image is a link to it, named by its alt, never an embedded picture", () => {
    expect(htmlToMarkdown('<p><img src="https://acme.aha.io/attachments/1.png" alt="Mock"></p>')).toBe(
      "[Mock](https://acme.aha.io/attachments/1.png)\n",
    );
    expect(htmlToMarkdown('<p><img src="https://acme.aha.io/attachments/2.png"></p>')).toBe(
      "[image](https://acme.aha.io/attachments/2.png)\n",
    );
  });

  test("an image inside a link names the link", () => {
    expect(htmlToMarkdown('<p><a href="https://acme.aha.io/attachments/1.png"><img src="https://acme.aha.io/attachments/1.png?size=small" alt="Mock"></a></p>')).toBe(
      "[Mock](https://acme.aha.io/attachments/1.png)\n",
    );
  });
});

describe("code and quotes", () => {
  test("a pre block is fenced and keeps its whitespace and newlines", () => {
    expect(htmlToMarkdown("<pre><code>if (a) {\n    b();\n}\n</code></pre>")).toBe("```\nif (a) {\n    b();\n}\n```\n");
    expect(htmlToMarkdown("<pre>x = &lt;y&gt;  z</pre>")).toBe("```\nx = <y>  z\n```\n");
  });

  test("a pre block holding a fence gets a longer one, and a language from its class", () => {
    expect(htmlToMarkdown('<pre><code class="language-md">```\nx\n```</code></pre>')).toBe("````md\n```\nx\n```\n````\n");
  });

  test("a blockquote prefixes each line, nested quotes too", () => {
    expect(htmlToMarkdown("<blockquote><p>a</p><p>b</p><blockquote><p>c</p></blockquote></blockquote>")).toBe(
      "> a\n>\n> b\n>\n> > c\n",
    );
  });
});

describe("tables", () => {
  test("a regular table is a pipe table with the first row as its header", () => {
    expect(htmlToMarkdown("<table><thead><tr><th>age</th><th>rate</th></tr></thead><tbody><tr><td>17</td><td>a | b</td></tr></tbody></table>")).toBe(
      "| age | rate |\n| --- | --- |\n| 17 | a \\| b |\n",
    );
    expect(htmlToMarkdown("<table><tr><td>a</td><td>b<br>c</td></tr><tr><td>d</td><td>e</td></tr></table>")).toBe(
      "| a | b c |\n| --- | --- |\n| d | e |\n",
    );
  });

  test("an irregular table writes each cell on its own line, rows apart", () => {
    expect(htmlToMarkdown('<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>')).toBe(
      "wide\n\na\nb\n",
    );
    expect(htmlToMarkdown("<table><tr><td>a</td></tr><tr><td>b</td><td>c</td></tr></table>")).toBe("a\n\nb\nc\n");
  });
});

describe("entities and tags that leave no mark", () => {
  test("named and numeric entities are decoded, unknown ones left as typed", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos; &mdash; &hellip; &copy;</p>")).toBe(
      "a & b < c > d \"e\" 'f' — … ©\n",
    );
    expect(htmlToMarkdown("<p>&#65;&#x42;&#xe9; &nosuch; &nbsp;x</p>")).toBe("ABé &nosuch; x\n");
  });

  test("script, style, head and comments are dropped with their content", () => {
    expect(htmlToMarkdown("<html><head><title>T</title><style>p { x: 1 }</style></head><body><!-- note --><script>if (a < b) {}</script><p>kept</p></body></html>")).toBe(
      "kept\n",
    );
  });

  test("an unknown tag keeps its text", () => {
    expect(htmlToMarkdown('<p><span style="color: red">red</span> <font>f</font> <sup>2</sup> <custom-x>c</custom-x></p>')).toBe("red f 2 c\n");
  });

  test("tag names and attribute quotes come in any form", () => {
    expect(htmlToMarkdown("<P><STRONG>a</STRONG> <A HREF='https://acme.com'>b</A> <a href=https://acme.com/c>c</a><BR/>d</P>")).toBe(
      "**a** [b](https://acme.com) [c](https://acme.com/c)\nd\n",
    );
  });
});

describe("markdown safety", () => {
  test("a line that would read as a heading, quote, item or rule is escaped", () => {
    expect(htmlToMarkdown("<p># not a heading</p><p>&gt; not a quote</p><p>- not an item</p><p>* nor this</p><p>1. nor this</p><p>---</p>")).toBe(
      "\\# not a heading\n\n\\> not a quote\n\n\\- not an item\n\n\\* nor this\n\n1\\. nor this\n\n\\---\n",
    );
  });

  test("a line starting with a test link is escaped, text in code is not", () => {
    expect(htmlToMarkdown("<p>[test: x : https://acme.com/t ]</p>")).toBe("\\[test: x : https://acme.com/t ]\n");
    expect(htmlToMarkdown("<p><code># x</code></p><pre># y</pre>")).toBe("`# x`\n\n```\n# y\n```\n");
  });
});

describe("an Aha! description", () => {
  test("converts to the markdown the editor reads", () => {
    const html = [
      "<p>As a <strong>buyer</strong> I want quotes, see <a href=\"https://acme.aha.io/features/APP-12\">APP-12</a>.</p>",
      "<ul><li>fast</li><li>accurate<ol><li>rounded</li><li>in the buyer&rsquo;s currency</li></ol></li></ul>",
      "<p><img src=\"https://acme.aha.io/attachments/1.png\" alt=\"Mock\"></p>",
    ].join("\n");
    expect(htmlToMarkdown(html)).toBe(
      "As a **buyer** I want quotes, see [APP-12](https://acme.aha.io/features/APP-12).\n\n" +
        "- fast\n- accurate\n  1. rounded\n  2. in the buyer’s currency\n\n" +
        "[Mock](https://acme.aha.io/attachments/1.png)\n",
    );
  });
});
