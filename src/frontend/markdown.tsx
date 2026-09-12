import type { ReactNode } from "react";
import { MarkdownImage } from "./MarkdownImage";
import { TEST_REF_RE, renderTestInEditor } from "./testref";

// Markdown support for the scenario edit dialog (specs/ui.spec.md "Scenario
// edit dialog"). The preview is built from React elements — never innerHTML —
// so untrusted feature-file content cannot inject markup.
//
// Beyond standard markdown the preview knows one house token: `[test:<url>]`
// or `[test:<name>:<url>]` (specs/external-links/test-traceability.feature.md),
// shown as a link named after the test — see ./testref.
//
// Images (specs/images.spec.md) have two spellings: `![alt](url)`, what a
// paste inserts, and `<img src="…" alt="…" width="…">` — the one HTML tag the
// preview renders, because it is how markdown everywhere sizes an image, and
// it is what the Preview tab's resize handle writes (setImageWidth). Only
// src, alt, width and height are read off the tag; anything else is dropped.
// The renderer also notes where each image sits in the source (imageRefs),
// so the handle on the nth image on screen edits the nth reference in the
// text — whatever code blocks, quotes or tables lie between.

/** Only these destinations are allowed for links/images in the preview. */
function safeUrl(url: string): string | null {
  return /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(url.trim()) ? url.trim() : null;
}

const INLINE = new RegExp(
  [
    "(?<tick>`+)(?<code>.+?)\\k<tick>",
    "(?<bmark>\\*\\*|__)(?<bold>.+?)\\k<bmark>",
    "\\*(?<star>[^*]+?)\\*",
    "(?<!\\w)_(?<under>[^_]+?)_(?!\\w)",
    "~~(?<strike>.+?)~~",
    "!\\[(?<alt>[^\\]]*)\\]\\((?<src>[^)]+)\\)",
    "<img\\s+(?<tag>[^<>]*)>",
    TEST_REF_RE.source.replace("(?<url>", "(?<test>").replace("(?<name>", "(?<testname>"),
    "\\[(?<text>[^\\]]+)\\]\\((?<href>[^)]+)\\)",
  ].join("|"),
);

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

function encodeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => `&${{ "&": "amp", '"': "quot", "<": "lt", ">": "gt" }[c]};`);
}

interface ImageAttrs {
  src?: string;
  alt?: string;
  width?: string;
  height?: string;
}

/** The attributes the preview honours, off the inside of an `<img …>` tag. */
function imageTagAttrs(tag: string): ImageAttrs {
  const a: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) a[m[1]!.toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  return { src: a.src, alt: a.alt, width: a.width, height: a.height };
}

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

/** What one render accumulates: its images, in the order they appear. */
interface Ctx {
  images: ImageRef[];
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

/** Inline markdown in `input`, which starts at offset `at` of the source. */
function parseInline(input: string, keyBase: string, at: number, ctx: Ctx): ReactNode[] {
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
    if (g.code !== undefined) {
      out.push(<code key={key}>{g.code}</code>);
    } else if (g.bold !== undefined) {
      out.push(<strong key={key}>{parseInline(g.bold, key, start + g.bmark!.length, ctx)}</strong>);
    } else if (g.star !== undefined) {
      out.push(<em key={key}>{parseInline(g.star, key, start + 1, ctx)}</em>);
    } else if (g.under !== undefined) {
      out.push(<em key={key}>{parseInline(g.under, key, start + 1, ctx)}</em>);
    } else if (g.strike !== undefined) {
      out.push(<del key={key}>{parseInline(g.strike, key, start + 2, ctx)}</del>);
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
            {parseInline(g.text!, key, start + 1, ctx)}
          </a>
        ) : (
          <span key={key}>{parseInline(g.text!, key, start + 1, ctx)}</span>
        ),
      );
    }
    rest = rest.slice(m.index + m[0].length);
    pos = start + m[0].length;
  }
  return out;
}

const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

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
  return renderBlocks(spans(src), { images: [] });
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
      i += 2;
      const rows: Span[][] = [];
      while (i < lines.length && lines[i]!.text.includes("|") && lines[i]!.text.trim() !== "")
        rows.push(tableCells(lines[i++]!));
      const kk = key();
      out.push(
        <table key={kk}>
          <thead>
            <tr>
              {headers.map((c, j) => (
                <th key={j}>{inline(c, `${kk}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{inline(c, `${kk}r${ri}c${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    // Paragraph: consecutive plain lines, soft breaks kept as <br> (scenario
    // steps are usually one per line without blank lines between them).
    const buf: Span[] = [];
    while (
      i < lines.length &&
      lines[i]!.text.trim() !== "" &&
      !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!.text)
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

// ---- Image sizing (specs/images.spec.md) ----

/**
 * The images in `src` in the order the preview shows them, each with where
 * it sits in the source (CRLF read as LF, as the preview reads it). Found by
 * the renderer itself, so the nth image on screen is always refs[n].
 */
export function imageRefs(src: string): ImageRef[] {
  const ctx: Ctx = { images: [] };
  renderBlocks(spans(src), ctx);
  return ctx.images;
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
 * Insert an image reference at the caret (specs/images.spec.md). A non-empty
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
