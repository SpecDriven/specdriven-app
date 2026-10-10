// Markdown tables inside scenario bodies (specs/scenario-table.feature.md).
// The scenario table widget is a structured view over the body text: these
// helpers find the table, turn it into {columns, rows}, and write it back.
// The grammar mirrors renderMarkdown's table branch (src/frontend/markdown.tsx)
// so what the widget edits is exactly what the preview renders.

export interface MdTable {
  columns: string[];
  rows: string[][];
}

export interface TableBlock extends MdTable {
  /** Char offset of the table's first line within the body. */
  start: number;
  /** Char offset just past the table's last line (excludes its newline). */
  end: number;
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/** Split a `| a | b |` line into trimmed cells, honouring `\|` escapes. */
function parseRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let escaped = false;
  for (const ch of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      cur += ch === "|" ? "|" : `\\${ch}`;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (escaped) cur += "\\";
  cells.push(cur.trim());
  return cells;
}

/**
 * Find the last markdown table in the body — the examples table by
 * convention. Tables inside fenced code blocks don't count.
 */
export function findTable(body: string): TableBlock | null {
  const lines = body.split("\n");
  // Char offset of the start of each line.
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }

  let found: TableBlock | null = null;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i]!)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!lines[i]!.includes("|") || i + 1 >= lines.length || !TABLE_DIVIDER.test(lines[i + 1]!))
      continue;
    const columns = parseRow(lines[i]!);
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
      // Ragged rows are normalized to the header width.
      const cells = parseRow(lines[j]!);
      rows.push(columns.map((_, c) => cells[c] ?? ""));
      j++;
    }
    found = { columns, rows, start: offsets[i]!, end: offsets[j - 1]! + lines[j - 1]!.length };
    i = j - 1;
  }
  return found;
}

/** Render {columns, rows} as a pipe table, padded for readable source. */
export function serializeTable(table: MdTable): string {
  const esc = (cell: string) => cell.replaceAll("|", "\\|");
  const widths = table.columns.map((col, c) =>
    Math.max(3, esc(col).length, ...table.rows.map((r) => esc(r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, c) => esc(cell).padEnd(widths[c]!)).join(" | ")} |`;
  return [
    line(table.columns),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...table.rows.map(line),
  ].join("\n");
}

/**
 * Rewrite the body with `table` in place of its current table block; append
 * (separated by a blank line) when the body has none, and remove the block
 * entirely when `table` is null (specs/scenario-table.feature.md: removing the
 * last column removes the table).
 */
export function replaceTable(body: string, table: MdTable | null): string {
  const block = findTable(body);
  if (!block) {
    if (!table) return body;
    const trimmed = body.replace(/\s+$/, "");
    return trimmed ? `${trimmed}\n\n${serializeTable(table)}` : serializeTable(table);
  }
  const before = body.slice(0, block.start);
  const after = body.slice(block.end);
  if (!table) {
    const b = before.replace(/\s+$/, "");
    const a = after.replace(/^\s+/, "");
    return b && a ? `${b}\n\n${a}` : b || a;
  }
  return before + serializeTable(table) + after;
}

const VAR = /\{([A-Za-z0-9_-]+)\}/g;

/**
 * Variable names written {var} in the body, in order of first appearance.
 * The table block and fenced code don't count — a {var} in a cell must not
 * spawn a column for itself.
 */
export function extractVars(body: string): string[] {
  const block = findTable(body);
  let text = block ? body.slice(0, block.start) + body.slice(block.end) : body;
  let inFence = false;
  text = text
    .split("\n")
    .filter((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    })
    .join("\n");
  const seen = new Set<string>();
  for (const m of text.matchAll(VAR)) seen.add(m[1]!);
  return [...seen];
}
