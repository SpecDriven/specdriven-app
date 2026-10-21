// A feature as a Confluence page body (specs/external-links/confluence-wiki
// .feature.md), in Confluence's storage format — XHTML with `ac:` macros:
// https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
//
// The markdown is read with the same patterns the app's preview uses
// (src/frontend/markdownSyntax.ts — pure and DOM-free, like the testref and
// weblinks modules it builds on), so a feature reads the same in the wiki as
// in the app. The output is a string rather than React elements: React cannot
// write the `ac:` macros or the CDATA a code block needs.
//
// Everything taken from the feature is escaped; only the tags written here
// reach Confluence. Links and images go through the preview's safeUrl, so a
// `javascript:` url stays text.

import {
  BLOCK_START,
  HR,
  INLINE,
  OL_ITEM,
  TABLE_DIVIDER,
  TASK_ITEM,
  UL_ITEM,
  imageTagAttrs,
  safeUrl,
} from "../frontend/markdownSyntax";
import { renderTestInEditor } from "../frontend/testref";
import { webLinkEnd } from "../frontend/weblinks";
import { parseTestRef, scenarioNumbers, type Feature, type Scenario } from "./parser";

/** Which scenarios a page holds: every one, or only the published. */
export type PublishScope = "all" | "published";

export function isPublishScope(value: unknown): value is PublishScope {
  return value === "all" || value === "published";
}

/** Text as XML character data or an attribute value. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);
}

/** A code macro: the text in CDATA, a `]]>` inside it split across two sections. */
function codeMacro(code: string, language?: string): string {
  const lang = language && /^[\w#+.-]+$/.test(language) ? `<ac:parameter ac:name="language">${language}</ac:parameter>` : "";
  const cdata = code.replaceAll("]]>", "]]]]><![CDATA[>");
  return `<ac:structured-macro ac:name="code" ac:schema-version="1">${lang}<ac:plain-text-body><![CDATA[${cdata}]]></ac:plain-text-body></ac:structured-macro>`;
}

function link(href: string, text: string): string {
  return `<a href="${escapeXml(href)}">${text}</a>`;
}

/**
 * An image: one on the web is embedded by url; one the app stores
 * (`/api/images/…`, a relative path) is out of Confluence's reach, so its alt
 * text stands in for it.
 */
function image(src: string | undefined, alt: string, snippet: string): string {
  const url = src === undefined ? null : safeUrl(src);
  if (!url) return escapeXml(snippet);
  if (!/^https?:\/\//i.test(url)) return `<em>${escapeXml(alt || "image")}</em>`;
  const altAttr = alt ? ` ac:alt="${escapeXml(alt)}"` : "";
  return `<ac:image${altAttr}><ri:url ri:value="${escapeXml(url)}" /></ac:image>`;
}

/** A `[test: … ]` reference as a link named after the test. */
function testLink(url: string, name?: string): string | null {
  const { label, href, title } = renderTestInEditor.render(url, name);
  return href ? `<a href="${escapeXml(href)}" title="${escapeXml(title)}">${escapeXml(label)}</a>` : null;
}

/**
 * Inline markdown as storage XHTML. `links` is false inside a link's own
 * text, where a bare url stays text — a link cannot hold another.
 */
export function renderInlineStorage(input: string, links = true): string {
  let out = "";
  let rest = input;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m) {
      out += escapeXml(rest);
      break;
    }
    out += escapeXml(rest.slice(0, m.index));
    const g = m.groups!;
    let used = m[0].length;
    if (g.code !== undefined) {
      out += `<code>${escapeXml(g.code)}</code>`;
    } else if (g.angle !== undefined) {
      out += links ? link(g.angle, escapeXml(g.angle)) : escapeXml(m[0]);
    } else if (g.web !== undefined) {
      const len = webLinkEnd(g.web);
      used = len || g.web.length;
      const url = g.web.slice(0, used);
      out += links && len > 0 ? link(url, escapeXml(url)) : escapeXml(url);
    } else if (g.bold !== undefined) {
      out += `<strong>${renderInlineStorage(g.bold, links)}</strong>`;
    } else if (g.star !== undefined) {
      out += `<em>${renderInlineStorage(g.star, links)}</em>`;
    } else if (g.under !== undefined) {
      out += `<em>${renderInlineStorage(g.under, links)}</em>`;
    } else if (g.strike !== undefined) {
      out += `<del>${renderInlineStorage(g.strike, links)}</del>`;
    } else if (g.src !== undefined) {
      out += image(g.src, g.alt ?? "", m[0]);
    } else if (g.tag !== undefined) {
      const a = imageTagAttrs(g.tag);
      out += image(a.src, a.alt ?? "", m[0]);
    } else if (g.test !== undefined) {
      out += testLink(g.test, g.testname) ?? escapeXml(m[0]);
    } else {
      const href = safeUrl(g.href!);
      out += href ? link(href, renderInlineStorage(g.text!, false)) : renderInlineStorage(g.text!, links);
    }
    rest = rest.slice(m.index + used);
  }
  return out;
}

/** A table row's cells, trimmed. */
function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((c) => c.trim());
}

/**
 * Block markdown as storage XHTML. `headingShift` pushes headings down a
 * level or more, so those inside a scenario sit under its heading.
 */
export function renderMarkdownStorage(src: string, headingShift = 0): string {
  return renderBlocks(src.replaceAll("\r\n", "\n").split("\n"), headingShift);
}

function renderBlocks(lines: string[], shift: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = line.match(/^```\s*([\w#+.-]*)/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++; // closing fence (or end of input)
      out.push(codeMacro(buf.join("\n"), fence[1] || undefined));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1]!.length + shift);
      out.push(`<h${level}>${renderInlineStorage(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*> ?/, ""));
      out.push(`<blockquote>${renderBlocks(buf, shift)}</blockquote>`);
      continue;
    }
    if (UL_ITEM.test(line) && !HR.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i]!) && !HR.test(lines[i]!)) {
        const content = lines[i]!.match(UL_ITEM)![1]!;
        const task = content.match(TASK_ITEM);
        items.push(
          task
            ? `<li>${task[1] === " " ? "☐" : "☑"} ${renderInlineStorage(task[2]!)}</li>`
            : `<li>${renderInlineStorage(content)}</li>`,
        );
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (OL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i]!)) {
        items.push(`<li>${renderInlineStorage(lines[i]!.match(OL_ITEM)![1]!)}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") rows.push(tableCells(lines[i++]!));
      const head = `<tr>${headers.map((c) => `<th>${renderInlineStorage(c)}</th>`).join("")}</tr>`;
      const body = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInlineStorage(c)}</td>`).join("")}</tr>`);
      out.push(`<table><tbody>${head}${body.join("")}</tbody></table>`);
      continue;
    }
    // Paragraph: consecutive plain lines, soft breaks kept (scenario steps
    // are usually one per line without blank lines between them).
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !BLOCK_START.test(lines[i]!)) buf.push(lines[i++]!);
    if (buf.length === 0) buf.push(lines[i++]!);
    out.push(`<p>${buf.map((l) => renderInlineStorage(l)).join("<br />")}</p>`);
  }
  return out.join("");
}

/** The scenarios a page in this scope holds, in the feature's order. */
export function scenariosInScope(feature: Feature, scope: PublishScope): Scenario[] {
  return scope === "published" ? feature.scenarios.filter((s) => s.status === "published") : feature.scenarios;
}

/**
 * A scenario's number as its heading's anchor (specs/external-links/
 * confluence-wiki.feature.md "Each scenario is numbered and can be linked
 * to"): an anchor macro named `S<n>`, and the number as a link to it, so a
 * reader clicks the number to put the scenario's deep link in the address
 * bar. Confluence writes the anchor's fragment itself — page-title-prefixed
 * on Server and Data Center, bare on Cloud — so the link names the anchor
 * rather than a fragment.
 */
function numberAnchor(n: number): string {
  const name = `S${n}`;
  return (
    `<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">${name}</ac:parameter></ac:structured-macro>` +
    `<ac:link ac:anchor="${name}"><ac:plain-text-link-body><![CDATA[${name}]]></ac:plain-text-link-body></ac:link>`
  );
}

/**
 * The heading of a polarity section (specs/ui/scenario-polarity.feature.md):
 * its title in green for Positive and red for Negative — Atlassian's own
 * green and red, those of its status lozenges — so the colour, not a marker
 * on every scenario, says which side a scenario is on.
 */
function polaritySectionHeading(negative: boolean): string {
  const colour = negative ? "rgb(222,53,11)" : "rgb(0,135,90)";
  const title = negative ? "Negative" : "Positive";
  return `<h1><span style="color: ${colour};">${title}</span></h1>`;
}

/** What a page may show beyond the scenarios themselves. */
export interface RenderOptions {
  /**
   * Whether the scenarios are grouped into a green Positive and a red
   * Negative section (specs/ui/scenario-polarity.feature.md) — the "Positive and negative scenarios"
   * setting. Default false: the page is one run of scenarios.
   */
  polarity?: boolean;
}

// A scenario's status and version are the app's bookkeeping, not part of the
// spec a wiki reader needs, so the page shows neither. Its number, a draft
// aside, leads its heading, as on its card in the app.
function scenarioStorage(s: Scenario, number: number | null): string {
  const label = number === null ? "" : `${numberAnchor(number)} · `;
  const parts = [`<h2>${label}${escapeXml(s.name)}</h2>`];
  if (s.body.trim()) parts.push(renderMarkdownStorage(s.body, 2));
  if (s.tests.length > 0) {
    const items = s.tests.map((t) => {
      const ref = parseTestRef(t);
      return `<li>${testLink(ref.url, ref.name) ?? escapeXml(t)}</li>`;
    });
    parts.push(`<p><strong>Tests</strong></p><ul>${items.join("")}</ul>`);
  }
  return parts.join("");
}

/**
 * A feature as the body of its Confluence page: its description, then its
 * scenarios. They are numbered over the whole feature, so a page of the
 * published ones alone keeps the numbers — and the anchors — the app shows.
 * With `polarity` on, the scenarios come in a green Positive section and
 * then a red Negative one, in the feature's order within each; a section
 * with no scenario in scope is left out.
 */
export function renderFeatureStorage(
  feature: Feature,
  scope: PublishScope,
  { polarity = false }: RenderOptions = {},
): string {
  const parts: string[] = [];
  if (feature.description.trim()) parts.push(renderMarkdownStorage(feature.description, 1));
  const scenarios = scenariosInScope(feature, scope);
  if (scenarios.length === 0) {
    parts.push(`<p><em>${scope === "published" ? "No published scenarios yet." : "No scenarios yet."}</em></p>`);
  }
  const numbers = scenarioNumbers(feature.scenarios);
  const render = (s: Scenario) => scenarioStorage(s, numbers[feature.scenarios.indexOf(s)] ?? null);
  if (!polarity) {
    for (const s of scenarios) parts.push(render(s));
    return parts.join("");
  }
  for (const negative of [false, true]) {
    const held = scenarios.filter((s) => !!s.negative === negative);
    if (held.length === 0) continue;
    parts.push(polaritySectionHeading(negative));
    for (const s of held) parts.push(render(s));
  }
  return parts.join("");
}
