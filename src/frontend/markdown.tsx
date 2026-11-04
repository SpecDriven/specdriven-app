import type { CSSProperties, ReactNode } from "react";
import { MarkdownImage } from "./MarkdownImage";
import { MarkdownTable } from "./MarkdownTable";
import {
  BLOCK_START,
  encodeAttr,
  HR,
  imageTagAttrs,
  INLINE,
  OL_ITEM,
  safeUrl,
  spanStyle,
  spanStyleDeclarations,
  TABLE_DIVIDER,
  TASK_ITEM,
  type ImageAttrs,
  type SpanStyle,
  UL_ITEM,
} from "./markdownSyntax";
import { renderTestInEditor } from "./testref";
import { webLinkEnd } from "./weblinks";

// Markdown support for the scenario edit dialog (specs/ui/ui.feature.md
// "Scenario edit dialog"). The preview is built from React elements — never
// innerHTML — so untrusted feature-file content cannot inject markup.
//
// Beyond standard markdown the preview knows one house token: `[test:<url>]`
// or `[test:<name>:<url>]` (specs/external-links/test-traceability.feature.md),
// shown as a link named after the test — see ./testref.
//
// A bare web url — `https://abc.com`, or `<https://abc.com>` as markdown
// spells an autolink — is a link too (specs/editor/common-editor.feature.md
// "web links are clickable"), ending where ./weblinks says it ends, so the
// preview and the source tabs agree on which characters are the link.
//
// Images (specs/images.feature.md) have two spellings: `![alt](url)`, what a
// paste inserts, and `<img src="…" alt="…" width="…">` — the one HTML tag the
// preview renders, because it is how markdown everywhere sizes an image, and
// it is what the Preview tab's resize handle writes (setImageWidth). Only
// src, alt, width and height are read off the tag; anything else is dropped.
// The renderer also notes where each image sits in the source (imageRefs),
// so the handle on the nth image on screen edits the nth reference in the
// text — whatever code blocks, quotes or tables lie between.

/**
 * A width or height as the attribute takes it: whole pixels (a "px" someone
 * typed by hand is forgiven, as browsers forgive it) or a percentage.
 */
function dimension(value: string | undefined): string | null {
  const m = value?.trim().match(/^(\d+)(px|%)?$/);
  return m ? `${m[1]}${m[2] === "%" ? "%" : ""}` : null;
}

// ---- Rendering ----

/** An image reference in the source, as the preview found it (imageRefs). */
export interface ImageRef {
  /** Offsets of the whole `![…](…)` or `<img …>` in the (LF-normalised) source. */
  start: number;
  end: number;
  src: string;
  alt: string;
  /** The width and height as written (`"320"`, `"50%"`) — null when not set. */
  width: string | null;
  height: string | null;
}

/** What one render accumulates: its images and tables, in the order they appear. */
interface Ctx {
  images: ImageRef[];
  /** Tables rendered so far, numbering each for its Edit button. */
  tables: number;
}

/** A run of source text and the offset of its first character in the source. */
interface Span {
  text: string;
  at: number;
}

function image(ctx: Ctx, key: string, snippet: string, at: number, a: ImageAttrs): ReactNode {
  const src = a.src === undefined ? null : safeUrl(a.src);
  if (!src) return snippet;
  const ref: ImageRef = {
    start: at,
    end: at + snippet.length,
    src,
    alt: a.alt ?? "",
    width: dimension(a.width),
    height: dimension(a.height),
  };
  const index = ctx.images.push(ref) - 1;
  return (
    <MarkdownImage
      key={key}
      index={index}
      src={src}
      alt={ref.alt}
      width={ref.width ?? undefined}
      height={ref.height ?? undefined}
    />
  );
}

/**
 * Inline markdown in `input`, which starts at offset `at` of the source.
 * `links` is false inside a link's own text, where a bare url stays text —
 * a link cannot hold another.
 */
function parseInline(
  input: string,
  keyBase: string,
  at: number,
  ctx: Ctx,
  links = true,
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = input;
  let pos = at; // where `rest` starts in the source
  let k = 0;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const g = m.groups!;
    const key = `${keyBase}.${k++}`;
    const start = pos + m.index;
    // How much of the match was read: all of it, but for a bare url, whose
    // trailing punctuation goes back to the text after it.
    let used = m[0].length;
    if (g.code !== undefined) {
      out.push(<code key={key}>{g.code}</code>);
    } else if (g.angle !== undefined) {
      out.push(
        links ? (
          <a key={key} href={g.angle} target="_blank" rel="noreferrer">
            {g.angle}
          </a>
        ) : (
          m[0]
        ),
      );
    } else if (g.web !== undefined) {
      const len = webLinkEnd(g.web);
      used = len || g.web.length;
      const url = g.web.slice(0, used);
      out.push(
        links && len > 0 ? (
          <a key={key} href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        ) : (
          url
        ),
      );
    } else if (g.bold !== undefined) {
      out.push(<strong key={key}>{parseInline(g.bold, key, start + g.bmark!.length, ctx, links)}</strong>);
    } else if (g.star !== undefined) {
      out.push(<em key={key}>{parseInline(g.star, key, start + 1, ctx, links)}</em>);
    } else if (g.under !== undefined) {
      out.push(<em key={key}>{parseInline(g.under, key, start + 1, ctx, links)}</em>);
    } else if (g.strike !== undefined) {
      out.push(<del key={key}>{parseInline(g.strike, key, start + 2, ctx, links)}</del>);
    } else if (g.colored !== undefined) {
      const style = spanStyle(g.style!);
      const inner = parseInline(g.colored, key, start + m[0].indexOf(">") + 1, ctx, links);
      out.push(
        <span
          key={key}
          className="md-color"
          style={
            style.color || style.background
              ? { color: style.color, backgroundColor: style.background }
              : undefined
          }
        >
          {inner}
        </span>,
      );
    } else if (g.src !== undefined) {
      out.push(image(ctx, key, m[0], start, { src: g.src, alt: g.alt ?? "" }));
    } else if (g.tag !== undefined) {
      out.push(image(ctx, key, m[0], start, imageTagAttrs(g.tag)));
    } else if (g.test !== undefined) {
      const { label, href, title } = renderTestInEditor.render(g.test, g.testname);
      out.push(
        href ? (
          <a key={key} className="test-ref" href={href} target="_blank" rel="noreferrer" title={title}>
            {label}
          </a>
        ) : (
          m[0]
        ),
      );
    } else {
      const href = safeUrl(g.href!);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {parseInline(g.text!, key, start + 1, ctx, false)}
          </a>
        ) : (
          <span key={key}>{parseInline(g.text!, key, start + 1, ctx, links)}</span>
        ),
      );
    }
    rest = rest.slice(m.index + used);
    pos = start + used;
  }
  return out;
}

/** The rest of a line after a prefix the block syntax owns (`## `, `- `, `> `). */
function tail(line: Span, text: string): Span {
  return { text, at: line.at + line.text.length - text.length };
}

/** A table row's cells, trimmed, each placed in the source. */
function tableCells(line: Span): Span[] {
  let text = line.text;
  let at = line.at + (text.length - text.trimStart().length);
  text = text.trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
    at += 1;
  }
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells: Span[] = [];
  let pos = 0;
  for (const raw of text.split("|")) {
    cells.push({ text: raw.trim(), at: at + pos + (raw.length - raw.trimStart().length) });
    pos += raw.length + 1;
  }
  return cells;
}

/** The source as lines, CRLF read as LF, each with its offset. */
function spans(src: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const text of src.replaceAll("\r\n", "\n").split("\n")) {
    out.push({ text, at });
    at += text.length + 1;
  }
  return out;
}

/** Render markdown as React elements. Returns null for blank input. */
export function renderMarkdown(src: string): ReactNode {
  return renderBlocks(spans(src), { images: [], tables: 0 });
}

function renderBlocks(lines: Span[], ctx: Ctx): ReactNode {
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  const inline = (s: Span, kk: string) => parseInline(s.text, kk, s.at, ctx);

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text.trim() === "") {
      i++;
      continue;
    }
    if (/^```/.test(line.text)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.text)) buf.push(lines[i++]!.text);
      i++; // closing fence (or end of input)
      out.push(
        <pre key={key()}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.text.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const Tag = `h${h[1]!.length}` as "h1";
      const kk = key();
      out.push(<Tag key={kk}>{inline(tail(line, h[2]!), kk)}</Tag>);
      i++;
      continue;
    }
    if (HR.test(line.text)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line.text)) {
      const buf: Span[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!.text)) {
        const l = lines[i++]!;
        buf.push(tail(l, l.text.replace(/^\s*> ?/, "")));
      }
      out.push(<blockquote key={key()}>{renderBlocks(buf, ctx)}</blockquote>);
      continue;
    }
    if (UL_ITEM.test(line.text) && !HR.test(line.text)) {
      const items: ReactNode[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i]!.text) && !HR.test(lines[i]!.text)) {
        const content = tail(lines[i]!, lines[i]!.text.match(UL_ITEM)![1]!);
        const task = content.text.match(TASK_ITEM);
        const kk = key();
        items.push(
          <li key={kk} className={task ? "task" : undefined}>
            {task ? (
              <>
                <input type="checkbox" checked={task[1] !== " "} readOnly disabled />{" "}
                {inline(tail(content, task[2]!), kk)}
              </>
            ) : (
              inline(content, kk)
            )}
          </li>,
        );
        i++;
      }
      out.push(<ul key={key()}>{items}</ul>);
      continue;
    }
    if (OL_ITEM.test(line.text)) {
      const items: ReactNode[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i]!.text)) {
        const kk = key();
        items.push(<li key={kk}>{inline(tail(lines[i]!, lines[i]!.text.match(OL_ITEM)![1]!), kk)}</li>);
        i++;
      }
      out.push(<ol key={key()}>{items}</ol>);
      continue;
    }
    if (line.text.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!.text)) {
      const headers = tableCells(line);
      const divider = lines[i + 1]!;
      i += 2;
      const rows: Span[][] = [];
      while (i < lines.length && lines[i]!.text.includes("|") && lines[i]!.text.trim() !== "")
        rows.push(tableCells(lines[i++]!));
      const kk = key();
      // The divider row's `:` marks align a column, as on GitHub.
      const align = tableCells(divider).map((d): CSSProperties["textAlign"] => {
        const left = d.text.startsWith(":");
        const right = d.text.endsWith(":");
        return left && right ? "center" : left ? "left" : right ? "right" : undefined;
      });
      const style = (j: number): CSSProperties | undefined =>
        align[j] ? { textAlign: align[j] } : undefined;
      out.push(
        <MarkdownTable key={kk} index={ctx.tables++}>
          <thead>
            <tr>
              {headers.map((c, j) => (
                <th key={j} style={style(j)}>
                  {inline(c, `${kk}h${j}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={style(ci)}>
                    {inline(c, `${kk}r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </MarkdownTable>,
      );
      continue;
    }
    // Paragraph: consecutive plain lines, soft breaks kept as <br> (scenario
    // steps are usually one per line without blank lines between them).
    const buf: Span[] = [];
    while (
      i < lines.length &&
      lines[i]!.text.trim() !== "" &&
      !BLOCK_START.test(lines[i]!.text)
    )
      buf.push(lines[i++]!);
    if (buf.length === 0) buf.push(lines[i++]!);
    const kk = key();
    out.push(
      <p key={kk}>
        {buf.flatMap((l, j) =>
          j === 0 ? [inline(l, `${kk}l${j}`)] : [<br key={`${kk}br${j}`} />, inline(l, `${kk}l${j}`)],
        )}
      </p>,
    );
  }
  return out.length > 0 ? out : null;
}

// ---- Image sizing (specs/images.feature.md) ----

/**
 * The images in `src` in the order the preview shows them, each with where
 * it sits in the source (CRLF read as LF, as the preview reads it). Found by
 * the renderer itself, so the nth image on screen is always refs[n].
 */
export function imageRefs(src: string): ImageRef[] {
  const ctx: Ctx = { images: [], tables: 0 };
  renderBlocks(spans(src), ctx);
  return ctx.images;
}

/**
 * The image `offset` falls in, and its index in imageRefs order — for the
 * toolbar acting on the reference under the caret (specs/editor/excalidraw-
 * support.feature.md "Edit Excalidraw diagram"). An offset anywhere in the
 * `![…](…)` or `<img …>` counts, its two ends included, so a caret just
 * before or just after the link still finds it; where two references touch,
 * the first one wins. Null when the offset is in ordinary text.
 *
 * Takes refs rather than the source: parsing is the expensive half and the
 * images only move when the text does, while the caret moves on every key.
 */
export function imageAtOffset(
  refs: ImageRef[],
  offset: number,
): { index: number; ref: ImageRef } | null {
  const index = refs.findIndex((r) => offset >= r.start && offset <= r.end);
  return index === -1 ? null : { index, ref: refs[index]! };
}

/** imageAtOffset against a source parsed on the spot (CRLF read as LF). */
export function imageAt(src: string, offset: number): { index: number; ref: ImageRef } | null {
  return imageAtOffset(imageRefs(src.replaceAll("\r\n", "\n")), offset);
}

/**
 * The source with its nth image (imageRefs order) set to `width` pixels,
 * spelled `<img src="…" alt="…" width="…">` — or, with null, back at its
 * natural size: plain `![alt](src)` again, unless the alt or url cannot be
 * written that way. A height the tag carried goes, so the image keeps its
 * proportions. Unchanged when there is no such image.
 */
export function setImageWidth(src: string, index: number, width: number | null): string {
  if (width !== null && !Number.isFinite(width)) return src;
  const text = src.replaceAll("\r\n", "\n");
  const ref = imageRefs(text)[index];
  if (!ref) return src;
  const w = width === null ? null : Math.max(1, Math.round(width));
  const plain = !ref.alt.includes("]") && !ref.src.includes(")");
  const md =
    w === null && plain
      ? `![${ref.alt}](${ref.src})`
      : `<img src="${encodeAttr(ref.src)}" alt="${encodeAttr(ref.alt)}"${w === null ? "" : ` width="${w}"`}>`;
  return text.slice(0, ref.start) + md + text.slice(ref.end);
}

/**
 * The source with its nth image (imageRefs order) pointed at `src`, under
 * `alt` — how a re-saved Excalidraw diagram takes the place of the one it was
 * opened from (specs/editor/excalidraw-support.feature.md "Edit Excalidraw
 * diagram"). A width or height the reference carried stays, so a diagram
 * sized in the preview keeps that size; the tag spelling is kept where one
 * is needed and plain `![alt](src)` used where it is not. Unchanged when
 * there is no such image.
 */
export function setImageSrc(src: string, index: number, url: string, alt: string): string {
  const text = src.replaceAll("\r\n", "\n");
  const ref = imageRefs(text)[index];
  if (!ref) return src;
  const plain = ref.width === null && ref.height === null && !alt.includes("]") && !url.includes(")");
  const md = plain
    ? `![${alt}](${url})`
    : `<img src="${encodeAttr(url)}" alt="${encodeAttr(alt)}"${
        ref.width === null ? "" : ` width="${ref.width}"`
      }${ref.height === null ? "" : ` height="${ref.height}"`}>`;
  return text.slice(0, ref.start) + md + text.slice(ref.end);
}

// ---- Toolbar text edits (pure, so they are unit-testable) ----

export interface Edit {
  text: string;
  start: number;
  end: number;
}

/** Wrap the selection in an inline marker, or unwrap if already wrapped. */
export function toggleInline(text: string, start: number, end: number, marker: string): Edit {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const len = marker.length;
  if (sel.length >= 2 * len && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(len, sel.length - len);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { text: before.slice(0, -len) + sel + after.slice(len), start: start - len, end: end - len };
  }
  if (sel === "") {
    return { text: before + marker + marker + after, start: start + len, end: start + len };
  }
  return { text: before + marker + sel + marker + after, start: start + len, end: end + len };
}

function lineBounds(text: string, start: number, end: number): [number, number] {
  const ls = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  let le = text.indexOf("\n", end);
  if (le === -1) le = text.length;
  return [ls, le];
}

/** Prefix every selected line (list, quote), or strip if all already have it. */
export function toggleLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
  detect: RegExp,
): Edit {
  const [ls, le] = lineBounds(text, start, end);
  const lines = text.slice(ls, le).split("\n");
  const allHave = lines.every((l) => detect.test(l));
  const next = lines.map((l, idx) => (allHave ? l.replace(detect, "") : prefix(idx) + l)).join("\n");
  return { text: text.slice(0, ls) + next + text.slice(le), start: ls, end: ls + next.length };
}

/** Make the selected lines a heading; toggle off if already at this level. */
export function toggleHeading(text: string, start: number, end: number, level = 2): Edit {
  const mark = "#".repeat(level) + " ";
  const [ls, le] = lineBounds(text, start, end);
  const next = text
    .slice(ls, le)
    .split("\n")
    .map((l) => {
      const m = l.match(/^#{1,6}\s+/);
      if (m && m[0] === mark) return l.slice(m[0].length);
      if (m) return mark + l.slice(m[0].length);
      return mark + l;
    })
    .join("\n");
  return { text: text.slice(0, ls) + next + text.slice(le), start: ls, end: ls + next.length };
}

/**
 * Insert an image reference at the caret (specs/images.feature.md). A non-empty
 * selection becomes the alt text; the caret lands after the inserted markdown
 * so consecutive pastes line up one after another.
 */
export function insertImage(text: string, start: number, end: number, alt: string, url: string): Edit {
  const md = `![${text.slice(start, end) || alt}](${url})`;
  return {
    text: text.slice(0, start) + md + text.slice(end),
    start: start + md.length,
    end: start + md.length,
  };
}

/**
 * The font colors the toolbar offers: mid-tone hues that read on the light
 * theme and the dark one alike, so colored text never disappears when the
 * theme flips.
 */
export const TEXT_COLORS: { id: string; label: string; value: string }[] = [
  { id: "red", label: "Red", value: "#e5484d" },
  { id: "orange", label: "Orange", value: "#f76b15" },
  { id: "green", label: "Green", value: "#30a46c" },
  { id: "teal", label: "Teal", value: "#12a594" },
  { id: "blue", label: "Blue", value: "#0090ff" },
  { id: "purple", label: "Purple", value: "#8e4ec6" },
  { id: "pink", label: "Pink", value: "#d6409f" },
  { id: "gray", label: "Gray", value: "#8b8d98" },
];

/**
 * The highlights the toolbar offers: translucent, so they read on the light
 * theme and the dark one alike, over any text color.
 */
export const HIGHLIGHT_COLORS: { id: string; label: string; value: string }[] = [
  { id: "yellow", label: "Yellow", value: "#ffd60066" },
  { id: "green", label: "Green", value: "#30d15866" },
  { id: "blue", label: "Blue", value: "#0a84ff59" },
  { id: "pink", label: "Pink", value: "#ff375f59" },
  { id: "orange", label: "Orange", value: "#ff9f0a66" },
  { id: "purple", label: "Purple", value: "#bf5af266" },
];

/** A styled span (`<span style="…">…</span>`): its tags and the text between them. */
const STYLE_SPAN = /<span\s+style\s*=\s*(["'])([^"'<>]*?)\1\s*>(.*?)<\/span>/g;

export interface StyledSpan {
  /** The span, tags included. */
  start: number;
  end: number;
  /** The text between the tags. */
  inner: number;
  innerEnd: number;
  style: SpanStyle;
}

/**
 * The styled spans in a line of text, in order — what the source editor
 * paints in place of the tags (src/frontend/SourceEditor.tsx). Spans do not
 * cross lines, as the renderer reads none that do.
 */
export function styledSpans(text: string): StyledSpan[] {
  const out: StyledSpan[] = [];
  for (const m of text.matchAll(STYLE_SPAN)) {
    const start = m.index!;
    const end = start + m[0].length;
    const inner = start + m[0].indexOf(">") + 1;
    out.push({ start, end, inner, innerEnd: end - "</span>".length, style: spanStyle(m[2]!) });
  }
  return out;
}

function styledSpanAround(text: string, start: number, end: number): StyledSpan | null {
  for (const span of styledSpans(text)) {
    // The selection is the whole span, its text, or lies inside its text.
    if (
      (start === span.start && end === span.end) ||
      (start >= span.inner && end <= span.innerEnd)
    )
      return span;
  }
  return null;
}

/** A change to a span's style: a color to set, `null` to take it off, or nothing. */
interface StylePatch {
  color?: string | null;
  background?: string | null;
}

/**
 * Restyle the selection: wrap it in `<span style="…">`, leaving the text
 * selected. A selection already in a styled span restyles that span instead
 * of nesting another — a color joins a highlight there, and the other way
 * round — and a span left with no style comes off, leaving the text as it was.
 */
function setSpanStyle(text: string, start: number, end: number, patch: StylePatch): Edit {
  const around = styledSpanAround(text, start, end);
  if (around) {
    const style: SpanStyle = { ...around.style };
    if (patch.color !== undefined) {
      if (patch.color) style.color = patch.color;
      else delete style.color;
    }
    if (patch.background !== undefined) {
      if (patch.background) style.background = patch.background;
      else delete style.background;
    }
    const decls = spanStyleDeclarations(style);
    const inner = text.slice(around.inner, around.innerEnd);
    const open = decls.length === 0 ? "" : `<span style="${decls.join("; ")}">`;
    const close = decls.length === 0 ? "" : "</span>";
    const next = text.slice(0, around.start) + open + inner + close + text.slice(around.end);
    // Keep the same characters selected, wherever the opening tag moved them.
    const shift = around.start + open.length - around.inner;
    const whole = start === around.start && end === around.end;
    return whole
      ? { text: next, start: around.start + open.length, end: around.start + open.length + inner.length }
      : { text: next, start: start + shift, end: end + shift };
  }
  const decls = spanStyleDeclarations({
    color: patch.color ?? undefined,
    background: patch.background ?? undefined,
  });
  if (decls.length === 0) return { text, start, end };
  const open = `<span style="${decls.join("; ")}">`;
  const sel = text.slice(start, end);
  return {
    text: text.slice(0, start) + open + sel + "</span>" + text.slice(end),
    start: start + open.length,
    end: start + open.length + sel.length,
  };
}

/**
 * Color the selection (specs/editor/common-editor.feature.md "Font color"):
 * `null` takes the color off.
 */
export function setColor(text: string, start: number, end: number, color: string | null): Edit {
  return setSpanStyle(text, start, end, { color });
}

/**
 * Highlight the selection (specs/editor/common-editor.feature.md
 * "Highlight"): a color behind the text; `null` takes the highlight off.
 */
export function setHighlight(text: string, start: number, end: number, color: string | null): Edit {
  return setSpanStyle(text, start, end, { background: color });
}

/** Turn the selection into a markdown link, leaving "url" selected. */
export function insertLink(text: string, start: number, end: number): Edit {
  const sel = text.slice(start, end) || "text";
  const urlStart = start + sel.length + 3; // "[" + sel + "]("
  return {
    text: text.slice(0, start) + `[${sel}](url)` + text.slice(end),
    start: urlStart,
    end: urlStart + 3,
  };
}
