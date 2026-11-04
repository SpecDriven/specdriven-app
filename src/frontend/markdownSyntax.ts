// The markdown the app renders, as patterns: shared by the React preview
// (./markdown.tsx) and the Confluence page renderer
// (src/server/confluenceStorage.ts), so a feature reads the same in both.
// Pure and DOM-free.

import { TEST_REF_RE } from "./testref";
import { WEB_URL_RE } from "./weblinks";

/** Only these destinations are allowed for links and images. */
export function safeUrl(url: string): string | null {
  return /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(url.trim()) ? url.trim() : null;
}

/** Every inline construct, one named group per kind; the first match wins. */
export const INLINE = new RegExp(
  [
    "(?<tick>`+)(?<code>.+?)\\k<tick>",
    "<(?<angle>https?://[^\\s<>]+)>",
    `(?<!\\w)(?<web>${WEB_URL_RE.source})`,
    "(?<bmark>\\*\\*|__)(?<bold>.+?)\\k<bmark>",
    "\\*(?<star>[^*]+?)\\*",
    "(?<!\\w)_(?<under>[^_]+?)_(?!\\w)",
    "~~(?<strike>.+?)~~",
    // Colored or highlighted text (specs/editor/common-editor.feature.md
    // "Font color", "Highlight"): the HTML every markdown tool reads, since
    // markdown has neither of its own. Only `color` and `background-color`
    // are read off the style; see spanStyle.
    `<span\\s+style\\s*=\\s*(?<cq>["'])(?<style>[^"'<>]*?)\\k<cq>\\s*>(?<colored>.*?)</span>`,
    "!\\[(?<alt>[^\\]]*)\\]\\((?<src>[^)]+)\\)",
    "<img\\s+(?<tag>[^<>]*)>",
    TEST_REF_RE.source.replace("(?<url>", "(?<test>").replace("(?<name>", "(?<testname>"),
    "\\[(?<text>[^\\]]+)\\]\\((?<href>[^)]+)\\)",
  ].join("|"),
);

/**
 * A text color as a style may carry it: a hex color, a named one, or an
 * rgb()/hsl() call — never anything that could close the attribute or the
 * declaration. Null for anything else, which then renders uncolored.
 */
export function safeColor(color: string): string | null {
  const c = color.trim();
  return /^(#[0-9a-f]{3,8}|[a-z]{3,24}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i.test(c) ? c : null;
}

/** What a styled span may carry: a text color, a highlight behind it, or both. */
export interface SpanStyle {
  color?: string;
  background?: string;
}

/**
 * The color and the highlight a span's style sets — each only if it is a
 * color safeColor accepts; every other declaration is passed over, so a
 * style can set nothing but those two.
 */
export function spanStyle(style: string): SpanStyle {
  const out: SpanStyle = {};
  for (const decl of style.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = safeColor(decl.slice(at + 1));
    if (!value) continue;
    if (prop === "color") out.color = value;
    else if (prop === "background-color" || prop === "background") out.background = value;
  }
  return out;
}

/** The declarations of a span's style, `color: …; background-color: …`, whichever are set. */
export function spanStyleDeclarations(style: SpanStyle): string[] {
  const out: string[] = [];
  if (style.color) out.push(`color: ${style.color}`);
  if (style.background) out.push(`background-color: ${style.background}`);
  return out;
}

// ---- Block syntax ----

export const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
export const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
export const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
export const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
export const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A line that starts a block other than a paragraph, ending the paragraph before it. */
export const BLOCK_START = /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/;

// ---- The <img> tag: its attributes, read and written ----

/** `name="value"`, `name='value'` or `name=value`, as attributes are written. */
const ATTR = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/g;

const ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  "#39": "'",
  lt: "<",
  gt: ">",
  amp: "&",
};

function decodeAttr(value: string): string {
  return value.replace(/&(quot|apos|#39|lt|gt|amp);/g, (_, e: string) => ENTITIES[e]!);
}

export function encodeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => `&${{ "&": "amp", '"': "quot", "<": "lt", ">": "gt" }[c]};`);
}

export interface ImageAttrs {
  src?: string;
  alt?: string;
  width?: string;
  height?: string;
}

/** The attributes honoured, off the inside of an `<img …>` tag. */
export function imageTagAttrs(tag: string): ImageAttrs {
  const a: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) a[m[1]!.toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  return { src: a.src, alt: a.alt, width: a.width, height: a.height };
}
