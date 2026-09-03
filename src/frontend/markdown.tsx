import type { ReactNode } from "react";
import { TEST_REF_RE, renderTestInEditor } from "./testref";

// Markdown support for the scenario edit dialog (specs/ui.spec.md "Scenario
// edit dialog"). The preview is built from React elements — never innerHTML —
// so untrusted feature-file content cannot inject markup.
//
// Beyond standard markdown the preview knows one house token: `[test:<url>]`
// (specs/external-links/test-traceability.feature.md), shown as a link named
// after the test — see ./testref.

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
    TEST_REF_RE.source.replace("(?<url>", "(?<test>"),
    "\\[(?<text>[^\\]]+)\\]\\((?<href>[^)]+)\\)",
  ].join("|"),
);

function parseInline(input: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = input;
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
    if (g.code !== undefined) {
      out.push(<code key={key}>{g.code}</code>);
    } else if (g.bold !== undefined) {
      out.push(<strong key={key}>{parseInline(g.bold, key)}</strong>);
    } else if (g.star !== undefined) {
      out.push(<em key={key}>{parseInline(g.star, key)}</em>);
    } else if (g.under !== undefined) {
      out.push(<em key={key}>{parseInline(g.under, key)}</em>);
    } else if (g.strike !== undefined) {
      out.push(<del key={key}>{parseInline(g.strike, key)}</del>);
    } else if (g.src !== undefined) {
      const src = safeUrl(g.src);
      out.push(src ? <img key={key} src={src} alt={g.alt ?? ""} /> : m[0]);
    } else if (g.test !== undefined) {
      const { label, href, title } = renderTestInEditor.render(g.test);
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
            {parseInline(g.text!, key)}
          </a>
        ) : (
          <span key={key}>{parseInline(g.text!, key)}</span>
        ),
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render markdown as React elements. Returns null for blank input. */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++; // closing fence (or end of input)
      out.push(
        <pre key={key()}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const Tag = `h${h[1]!.length}` as "h1";
      const kk = key();
      out.push(<Tag key={kk}>{parseInline(h[2]!, kk)}</Tag>);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*> ?/, ""));
      out.push(<blockquote key={key()}>{renderMarkdown(buf.join("\n"))}</blockquote>);
      continue;
    }
    if (UL_ITEM.test(line) && !HR.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i]!) && !HR.test(lines[i]!)) {
        const content = lines[i]!.match(UL_ITEM)![1]!;
        const task = content.match(TASK_ITEM);
        const kk = key();
        items.push(
          <li key={kk} className={task ? "task" : undefined}>
            {task ? (
              <>
                <input type="checkbox" checked={task[1] !== " "} readOnly disabled />{" "}
                {parseInline(task[2]!, kk)}
              </>
            ) : (
              parseInline(content, kk)
            )}
          </li>,
        );
        i++;
      }
      out.push(<ul key={key()}>{items}</ul>);
      continue;
    }
    if (OL_ITEM.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i]!)) {
        const kk = key();
        items.push(<li key={kk}>{parseInline(lines[i]!.match(OL_ITEM)![1]!, kk)}</li>);
        i++;
      }
      out.push(<ol key={key()}>{items}</ol>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const headers = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "")
        rows.push(tableRow(lines[i++]!));
      const kk = key();
      out.push(
        <table key={kk}>
          <thead>
            <tr>
              {headers.map((c, j) => (
                <th key={j}>{parseInline(c, `${kk}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{parseInline(c, `${kk}r${ri}c${ci}`)}</td>
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
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!)
    )
      buf.push(lines[i++]!);
    if (buf.length === 0) buf.push(lines[i++]!);
    const kk = key();
    out.push(
      <p key={kk}>
        {buf.flatMap((l, j) =>
          j === 0 ? [parseInline(l, `${kk}l${j}`)] : [<br key={`${kk}br${j}`} />, parseInline(l, `${kk}l${j}`)],
        )}
      </p>,
    );
  }
  return out.length > 0 ? out : null;
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
