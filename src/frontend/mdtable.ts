// Markdown tables in editor text (specs/editor/table-editor.feature.md).
// The table dialog is a structured view over the text: these helpers find
// the tables, turn one into {columns, align, rows}, and write it back. The
// grammar mirrors renderMarkdown's table branch (src/frontend/markdown.tsx)
// so what the dialog edits is exactly what the preview renders.

import type { Edit } from "./markdown";

/** A column's alignment, as the divider row spells it; null for none. */
export type Align = "left" | "center" | "right" | null;

export interface MdTable {
  columns: string[];
  rows: string[][];
  /** One entry per column; absent means no column is aligned. */
  align?: Align[];
}

export interface TableBlock extends MdTable {
  align: Align[];
  /** Char offset of the table's first line within the text. */
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

/** The alignment each divider cell asks for: `:--` left, `:-:` center, `--:` right. */
function parseAlign(divider: string, width: number): Align[] {
  const cells = parseRow(divider);
  return Array.from({ length: width }, (_, c) => {
    const d = cells[c] ?? "";
    const left = d.startsWith(":");
    const right = d.endsWith(":");
    return left && right ? "center" : left ? "left" : right ? "right" : null;
  });
}

/**
 * Every markdown table in the text, in order. Tables inside fenced code
 * blocks don't count: the preview shows those as code.
 */
export function findTables(text: string): TableBlock[] {
  const lines = text.split("\n");
  // Char offset of the start of each line.
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }

  const found: TableBlock[] = [];
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
    const align = parseAlign(lines[i + 1]!, columns.length);
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
      // Ragged rows are normalized to the header width.
      const cells = parseRow(lines[j]!);
      rows.push(columns.map((_, c) => cells[c] ?? ""));
      j++;
    }
    found.push({
      columns,
      align,
      rows,
      start: offsets[i]!,
      end: offsets[j - 1]! + lines[j - 1]!.length,
    });
    i = j - 1;
  }
  return found;
}

/** The table the caret is in, if it is in one — on any of its lines. */
export function tableAt(text: string, caret: number): TableBlock | null {
  return findTables(text).find((t) => caret >= t.start && caret <= t.end) ?? null;
}

/** Render {columns, align, rows} as a pipe table, padded for readable source. */
export function serializeTable(table: MdTable): string {
  const esc = (cell: string) => cell.replaceAll("|", "\\|");
  const widths = table.columns.map((col, c) =>
    Math.max(3, esc(col).length, ...table.rows.map((r) => esc(r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, c) => esc(cell).padEnd(widths[c]!)).join(" | ")} |`;
  const divider = widths.map((w, c) => {
    const a = table.align?.[c] ?? null;
    if (a === null) return "-".repeat(w);
    if (a === "left") return `:${"-".repeat(w - 1)}`;
    if (a === "right") return `${"-".repeat(w - 1)}:`;
    return `:${"-".repeat(w - 2)}:`;
  });
  return [line(table.columns), `| ${divider.join(" | ")} |`, ...table.rows.map(line)].join("\n");
}

/**
 * Rewrite `block` (found in `text` by findTables or tableAt) as `table`, or
 * take it out when `table` is null, closing the blank lines around it. The
 * caret of the returned edit sits at the start of the rewritten table, or
 * where the removed one was.
 */
export function replaceTableBlock(text: string, block: TableBlock, table: MdTable | null): Edit {
  const before = text.slice(0, block.start);
  const after = text.slice(block.end);
  if (!table) {
    const b = before.replace(/\s+$/, "");
    const a = after.replace(/^\s+/, "");
    const joined = b && a ? `${b}\n\n${a}` : b || a;
    const at = b ? Math.min(b.length + 2, joined.length) : 0;
    return { text: joined, start: at, end: at };
  }
  return { text: before + serializeTable(table) + after, start: block.start, end: block.start };
}

/**
 * Put `table` at the caret on a paragraph of its own: a blank line before
 * and after unless the text there already gives one. Selected text is
 * replaced. The caret lands after the table.
 */
export function insertTable(text: string, start: number, end: number, table: MdTable): Edit {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after === "" ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const md = lead + serializeTable(table) + trail;
  const at = start + md.length;
  return { text: before + md + after, start: at, end: at };
}

const VAR = /\{([A-Za-z0-9_-]+)\}/g;

/**
 * Variable names written {var} in the text, in order of first appearance.
 * Tables and fenced code don't count — a {var} in a cell must not spawn a
 * column for itself.
 */
export function extractVars(text: string): string[] {
  let rest = text;
  for (const block of findTables(text).reverse())
    rest = rest.slice(0, block.start) + rest.slice(block.end);
  let inFence = false;
  rest = rest
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
  for (const m of rest.matchAll(VAR)) seen.add(m[1]!);
  return [...seen];
}

/**
 * The grid the dialog opens on (specs/editor/table-editor.feature.md
 * "variable creates a column"): `table` with a column for each {var} in
 * `vars` it lacks — a new table, with just those columns and one empty row,
 * or one empty column when there are no variables either.
 */
export function withVarColumns(table: MdTable | null, vars: string[]): MdTable {
  if (!table) {
    const columns = vars.length > 0 ? vars : [""];
    return { columns, align: columns.map(() => null), rows: [columns.map(() => "")] };
  }
  const missing = vars.filter((v) => !table.columns.includes(v));
  if (missing.length === 0) return table;
  return {
    columns: [...table.columns, ...missing],
    align: [...(table.align ?? table.columns.map(() => null)), ...missing.map(() => null)],
    rows: table.rows.map((r) => [...r, ...missing.map(() => "")]),
  };
}

/**
 * A block pasted from a spreadsheet or another table: tab-separated cells
 * on newline-separated rows. Null when the clip is a single cell, which
 * pastes as plain text.
 */
export function parseClip(clip: string): string[][] | null {
  const rows = clip.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (rows.length === 1 && !rows[0]!.includes("\t")) return null;
  return rows.map((r) => r.split("\t"));
}

/**
 * Lay `cells` over the grid from (row, col) — row -1 for the header — growing
 * it by as many rows and columns as the clip needs.
 */
export function pasteCells(table: MdTable, row: number, col: number, cells: string[][]): MdTable {
  const width = Math.max(table.columns.length, col + Math.max(...cells.map((r) => r.length)));
  const height = Math.max(table.rows.length, row + cells.length);
  const grow = (r: string[]) => [...r, ...Array.from({ length: width - r.length }, () => "")];
  const columns = grow(table.columns);
  const align = [...(table.align ?? []), ...Array.from({ length: width }, () => null)].slice(0, width);
  const rows = [
    ...table.rows.map(grow),
    ...Array.from({ length: height - table.rows.length }, () => columns.map(() => "")),
  ];
  cells.forEach((clipRow, i) => {
    const r = row + i;
    clipRow.forEach((cell, j) => {
      if (r === -1) columns[col + j] = cell;
      else rows[r]![col + j] = cell;
    });
  });
  return { columns, align, rows };
}
