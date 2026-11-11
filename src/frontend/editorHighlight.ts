// The colours CodeMirror paints syntax in, for both editors: the Markdown
// source editor (SourceEditor.tsx) and the Files tab's code editor
// (files/CodeEditor.tsx). Every colour is a token from index.css, so the
// light and dark themes follow on their own.

import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Markdown syntax, in the app's own colours (index.css): headings and links
// take the accent, the marks around them recede.
export const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--accent-strong)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--text-2)" },
  { tag: tags.monospace, background: "var(--code-bg)", borderRadius: "2px" },
  { tag: tags.quote, color: "var(--text-2)" },
  { tag: tags.processingInstruction, color: "var(--text-3)" },
  { tag: tags.contentSeparator, color: "var(--text-3)" },
]);

// Source code (specs/app/code-repo-mode.feature.md "Source files are
// highlighted by language"): six colours — keywords, strings, constants,
// comments, types and names — and plain text for everything else, so
// variables, operators and brackets stay quiet. A later entry wins over an
// earlier one for the same token, and a narrower tag over its parent
// (`null` is a keyword, but reads as a constant).
export const codeStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.escape], color: "var(--syntax-constant)" },
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment)" },
  {
    tag: [tags.typeName, tags.standard(tags.typeName), tags.className, tags.namespace, tags.annotation],
    color: "var(--syntax-type)",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.standard(tags.name),
      tags.macroName,
      tags.labelName,
    ],
    color: "var(--syntax-name)",
  },
  // What a file declares: JSON and YAML keys, object keys, class members.
  { tag: [tags.definition(tags.propertyName), tags.attributeName], color: "var(--syntax-property)" },
]);

// JSON's keys are its only names, so they take the colour declared members
// have elsewhere; in a program the same tag is every `.member` read, which
// codeStyle leaves alone.
export const jsonKeyStyle = HighlightStyle.define([{ tag: tags.propertyName, color: "var(--syntax-property)" }]);
