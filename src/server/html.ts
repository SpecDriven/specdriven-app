// An Aha! record's HTML as the markdown the spec editor reads
// (specs/external-links/aha-import.feature.md): Aha!'s REST API hands a
// description back as HTML — paragraphs, lists, marks, links, images,
// tables, headings — never markdown, and the app stores the dialect
// src/server/parser.ts reads and src/frontend/markdownSyntax.ts renders.
//
// Pure and DOM-free, the reverse of src/server/confluenceStorage.ts: a regex
// tokenizer over tags and text, a small element stack that builds a tree,
// and a renderer that writes block by block. No library — turndown wants a
// DOM, and the server has none.
//
// Headings are demoted to at least `###` (the feature's own is `#`, a
// scenario's `##`); an image becomes a link, as an Aha! attachment url sits
// behind its sign-in and would show as a broken picture; a line that would
// read as a block or a test link is escaped.

interface Elem {
  kind: "elem";
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface Text {
  kind: "text";
  text: string;
}
type Node = Elem | Text;

/** A rendered block: joined to its neighbours by a blank line, or none after a list item's text. */
interface Block {
  kind: "para" | "heading" | "list" | "code" | "quote" | "table" | "rule";
  text: string;
}

// ---- Entities ----

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  euro: "€", pound: "£", yen: "¥", deg: "°", times: "×", divide: "÷",
  para: "¶", sect: "§", laquo: "«", raquo: "»", shy: "",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined || dec !== undefined) {
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    const value = NAMED_ENTITIES[name!.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

// ---- Tokenizer and tree ----

const TOKEN = new RegExp(
  [
    "<!--[\\s\\S]*?(?:-->|$)",
    "<!\\[CDATA\\[([\\s\\S]*?)(?:\\]\\]>|$)",
    "<[!?][^>]*>",
    "<\\/([a-zA-Z][^\\s>\\/]*)[^>]*>",
    "<([a-zA-Z][^\\s>\\/]*)((?:\\s+[^\\s\"'>\\/=]+(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s\"'>]+))?)*)[^>]*?(\\/?)\\s*>",
  ].join("|"),
  "g",
);
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose text is not text: skipped to their closing tag. */
const RAW = new Set(["script", "style"]);
/** Dropped with everything inside. */
const DROPPED = new Set(["head", "title", "template", "noscript"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "col", "colgroup", "dd", "details",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "header", "hr", "html", "li", "main", "nav", "noscript", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "template", "tfoot", "th", "thead", "title", "tr", "ul",
]);
const LIST = new Set(["ul", "ol"]);
const CELL = new Set(["td", "th"]);
const TABLE_PART = new Set(["table", "tbody", "thead", "tfoot"]);
const DEFINITION = new Set(["dt", "dd"]);

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** Pop the stack to (and including) the nearest element `name` names, if `until` is not met first. */
function closeNearest(stack: Elem[], names: Set<string>, until: (name: string) => boolean): void {
  for (let i = stack.length - 1; i > 0; i--) {
    const name = stack[i]!.name;
    if (names.has(name)) {
      stack.length = i;
      return;
    }
    if (until(name)) return;
  }
}

function openElement(stack: Elem[], name: string, attrs: Record<string, string>, selfClosing: boolean): void {
  if (name === "li") closeNearest(stack, new Set(["li"]), (n) => LIST.has(n));
  else if (CELL.has(name)) closeNearest(stack, CELL, (n) => n === "tr" || TABLE_PART.has(n));
  else if (name === "tr") closeNearest(stack, new Set(["tr"]), (n) => TABLE_PART.has(n));
  else if (DEFINITION.has(name)) closeNearest(stack, DEFINITION, (n) => n === "dl");
  else if (name === "a") closeNearest(stack, new Set(["a"]), (n) => BLOCK.has(n));
  else if (BLOCK.has(name)) closeNearest(stack, new Set(["p"]), (n) => BLOCK.has(n));
  const elem: Elem = { kind: "elem", name, attrs, children: [] };
  stack[stack.length - 1]!.children.push(elem);
  if (!VOID.has(name) && !selfClosing) stack.push(elem);
}

function closeElement(stack: Elem[], name: string): void {
  if (name === "br") {
    openElement(stack, "br", {}, true);
    return;
  }
  closeNearest(stack, new Set([name]), () => false);
}

function parse(html: string): Elem {
  const root: Elem = { kind: "elem", name: "#root", attrs: {}, children: [] };
  const stack: Elem[] = [root];
  const addText = (text: string) => {
    if (text) stack[stack.length - 1]!.children.push({ kind: "text", text });
  };
  let at = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    addText(decodeEntities(html.slice(at, m.index)));
    at = TOKEN.lastIndex;
    const [, cdata, closing, opening, attrText, selfClose] = m;
    if (cdata !== undefined) addText(cdata);
    else if (closing !== undefined) closeElement(stack, closing.toLowerCase());
    else if (opening !== undefined) {
      const name = opening.toLowerCase();
      if (RAW.has(name)) {
        const end = new RegExp(`</${name}\\s*>`, "ig");
        end.lastIndex = at;
        at = end.exec(html) ? end.lastIndex : html.length;
        TOKEN.lastIndex = at;
        continue;
      }
      openElement(stack, name, parseAttrs(attrText ?? ""), selfClose === "/");
    }
  }
  addText(decodeEntities(html.slice(at)));
  return root;
}

// ---- Inline rendering ----

const ABSOLUTE_URL = /^(https?:|mailto:)/i;

const collapse = (text: string) => text.replace(/\s+/g, " ");
/** A url fit for `(…)`: a space or a parenthesis would end the link early. */
const linkTarget = (url: string) => url.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const oneLine = (text: string) => collapse(text).trim();

/** The plain text inside a node, whitespace collapsed. */
function textOf(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.name === "br") out += " ";
    else if (n.name === "img") out += n.attrs.alt ?? "";
    else out += textOf(n.children);
  }
  return collapse(out);
}

/** Text in a pre block: verbatim, a br a newline. */
function rawTextOf(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.name === "br") out += "\n";
    else out += rawTextOf(n.children);
  }
  return out;
}

/** `**bold**` line by line, the surrounding whitespace moved outside the marks. */
function mark(inner: string, m: string): string {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  const core = parts[2]!;
  if (!core) return parts[1]! + parts[3]!;
  const marked = core
    .split("\n")
    .map((line) => {
      const t = line.trim();
      return t ? `${m}${t}${m}` : "";
    })
    .join("\n");
  return parts[1]! + marked + parts[3]!;
}

function codeSpan(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function imageLabel(img: Elem): string {
  return oneLine(img.attrs.alt ?? "") || "image";
}

function renderInline(nodes: Node[], inLink = false): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += collapse(n.text);
      continue;
    }
    switch (n.name) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b":
        out += mark(renderInline(n.children, inLink), "**");
        break;
      case "em":
      case "i":
        out += mark(renderInline(n.children, inLink), "_");
        break;
      case "s":
      case "del":
      case "strike":
        out += mark(renderInline(n.children, inLink), "~~");
        break;
      case "code":
        out += codeSpan(textOf(n.children));
        break;
      case "a": {
        const href = (n.attrs.href ?? "").trim();
        const text = oneLine(renderInline(n.children, true));
        if (inLink || !ABSOLUTE_URL.test(href)) out += renderInline(n.children, inLink);
        else if (!text || text === href) out += href;
        else out += `[${text}](${linkTarget(href)})`;
        break;
      }
      case "img": {
        const src = (n.attrs.src ?? "").trim();
        const label = imageLabel(n);
        out += inLink || !ABSOLUTE_URL.test(src) ? label : `[${label}](${linkTarget(src)})`;
        break;
      }
      case "input":
        if ((n.attrs.type ?? "").toLowerCase() === "checkbox") out += "checked" in n.attrs ? "[x]" : "[ ]";
        break;
      case "head":
      case "title":
      case "template":
      case "noscript":
        break;
      default:
        // A block that ended up inline (a `p` inside a `b`): its own lines.
        out += BLOCK.has(n.name) ? `\n${renderInline(n.children, inLink)}\n` : renderInline(n.children, inLink);
    }
  }
  return out;
}

// ---- Blocks ----

/** A line that would otherwise read as a heading, quote, list item, rule, test link or image tag. */
function escapeLineStart(line: string): string {
  if (/^(#|>|[-*+]\s|\d+[.)]\s|\[test:)/i.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
    return /^\d/.test(line) ? line.replace(/^(\d+)([.)])/, "$1\\$2") : `\\${line}`;
  }
  return line.replace(/^<img\s/i, "\\<img ");
}

/** Lines of a paragraph: trimmed, escaped, runs of blank lines folded, none at either end. */
function paragraph(text: string): Block | null {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = oneLine(raw);
    if (!line && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line ? escapeLineStart(line) : "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? { kind: "para", text: lines.join("\n") } : null;
}

function heading(elem: Elem): Block | null {
  const text = oneLine(renderInline(elem.children));
  if (!text) return null;
  const level = Math.max(3, Number(elem.name.slice(1)));
  return { kind: "heading", text: `${"#".repeat(level)} ${text}` };
}

function codeBlock(elem: Elem): Block | null {
  const content = rawTextOf(elem.children).replace(/^\n/, "").replace(/\s+$/, "");
  if (!content) return null;
  const longest = Math.max(2, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const inner = elem.children.find((c): c is Elem => c.kind === "elem" && c.name === "code");
  const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(`${elem.attrs.class ?? ""} ${inner?.attrs.class ?? ""}`)?.[1] ?? "";
  return { kind: "code", text: `${fence}${lang}\n${content}\n${fence}` };
}

function quote(elem: Elem): Block | null {
  const inner = joinBlocks(renderBlocks(elem.children));
  if (!inner) return null;
  return { kind: "quote", text: inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") };
}

/** Whether a list item starts with a checkbox; the nodes without it. */
function takeCheckbox(nodes: Node[]): { checked?: boolean; nodes: Node[] } {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.kind === "text") {
      if (!n.text.trim()) continue;
      return { nodes };
    }
    if (n.name === "input") {
      if ((n.attrs.type ?? "").toLowerCase() !== "checkbox") return { nodes };
      return { checked: "checked" in n.attrs, nodes: nodes.filter((_, j) => j !== i) };
    }
    if (["p", "div", "label", "span"].includes(n.name)) {
      const inner = takeCheckbox(n.children);
      if (inner.checked === undefined) return { nodes };
      return { checked: inner.checked, nodes: nodes.map((m, j) => (j === i ? { ...n, children: inner.nodes } : m)) };
    }
    return { nodes };
  }
  return { nodes };
}

const indent = (line: string) => (line ? `  ${line}` : "");

function list(elem: Elem): Block | null {
  const ordered = elem.name === "ol";
  let n = ordered ? parseInt(elem.attrs.start ?? "", 10) || 1 : 0;
  const lines: string[] = [];
  for (const child of elem.children) {
    if (child.kind === "text") continue;
    if (LIST.has(child.name)) {
      const nested = list(child);
      if (nested) lines.push(...nested.text.split("\n").map(indent));
      continue;
    }
    const marker = ordered ? `${n++}. ` : "- ";
    const item = takeCheckbox(child.children);
    const dataChecked = child.attrs["data-checked"];
    const checked = item.checked ?? (dataChecked === undefined ? undefined : dataChecked === "true");
    const prefix = marker + (checked === undefined ? "" : checked ? "[x] " : "[ ] ");
    const blocks = renderBlocks(item.nodes);
    const first = blocks[0];
    if (first && (first.kind === "para" || first.kind === "heading")) {
      const [head, ...rest] = first.text.split("\n");
      lines.push(prefix + head, ...rest.map(indent));
      blocks.shift();
    } else {
      lines.push(prefix.trimEnd());
    }
    for (const block of blocks) {
      if (block.kind !== "list") lines.push("");
      lines.push(...block.text.split("\n").map(indent));
    }
  }
  return lines.length ? { kind: "list", text: lines.join("\n") } : null;
}

function tableRows(elem: Elem): Elem[][] {
  const rows: Elem[][] = [];
  for (const child of elem.children) {
    if (child.kind !== "elem") continue;
    if (child.name === "tr") rows.push(child.children.filter((c): c is Elem => c.kind === "elem" && CELL.has(c.name)));
    else if (TABLE_PART.has(child.name)) rows.push(...tableRows(child));
  }
  return rows.filter((cells) => cells.length > 0);
}

const spans = (cell: Elem) =>
  ["colspan", "rowspan"].some((a) => cell.attrs[a] !== undefined && cell.attrs[a]!.trim() !== "" && cell.attrs[a]!.trim() !== "1");

function table(elem: Elem): Block[] {
  const out: Block[] = [];
  for (const caption of elem.children) {
    if (caption.kind === "elem" && caption.name === "caption") {
      const p = paragraph(renderInline(caption.children));
      if (p) out.push(p);
    }
  }
  const rows = tableRows(elem);
  if (rows.length === 0) return out;
  const cellTexts = rows.map((cells) => cells.map((c) => oneLine(renderInline(c.children))));
  const width = rows[0]!.length;
  const regular = rows.every((cells) => cells.length === width && !cells.some(spans));
  if (regular) {
    const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
    const lines = [line(cellTexts[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...cellTexts.slice(1).map(line)];
    out.push({ kind: "table", text: lines.join("\n") });
    return out;
  }
  for (const cells of cellTexts) {
    const lines = cells.filter(Boolean).map(escapeLineStart);
    if (lines.length) out.push({ kind: "para", text: lines.join("\n") });
  }
  return out;
}

function renderBlock(elem: Elem): Block[] {
  const one = (b: Block | null) => (b ? [b] : []);
  switch (elem.name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return one(heading(elem));
    case "ul":
    case "ol":
      return one(list(elem));
    case "pre":
      return one(codeBlock(elem));
    case "blockquote":
      return one(quote(elem));
    case "table":
      return table(elem);
    case "hr":
      return [{ kind: "rule", text: "---" }];
    case "head":
    case "title":
    case "template":
    case "noscript":
    case "col":
    case "colgroup":
      return [];
    default:
      return renderBlocks(elem.children);
  }
}

/** Blocks in order; a run of inline nodes between them is a paragraph. */
function renderBlocks(nodes: Node[]): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.length) {
      const p = paragraph(renderInline(run));
      if (p) out.push(p);
      run = [];
    }
  };
  for (const n of nodes) {
    if (n.kind === "elem" && BLOCK.has(n.name)) {
      flush();
      out.push(...renderBlock(n));
    } else run.push(n);
  }
  flush();
  return out;
}

function joinBlocks(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

/** Aha! record HTML as the Markdown the spec editor reads. */
export function htmlToMarkdown(html: string): string {
  const text = joinBlocks(renderBlocks(parse(html).children));
  return text ? `${text}\n` : "";
}
