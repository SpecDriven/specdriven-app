import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  X,
} from "lucide-react";
import { useFocusTrap } from "./useFocusTrap";
import { useModalPrompts } from "./ModalPrompts";
import { Tooltip } from "./Tooltip";
import { parseClip, pasteCells } from "./mdtable";
import type { Align, MdTable } from "./mdtable";

interface TableDialogProps {
  /** The grid the dialog opens on: the table at the caret, or a blank one. */
  initial: MdTable;
  /** Whether `initial` came from the text (Save) or is new (Insert). */
  mode: "new" | "edit";
  /**
   * Columns owned by a {var} in the text (specs/editor/table-editor
   * .feature.md "variable creates a column"): neither renamed nor removed
   * here — the variable in the text is what to edit.
   */
  locked?: string[];
  /** The grid as applied; null deletes the table from the text. */
  onApply: (table: MdTable | null) => void;
  onCancel: () => void;
}

interface Grid {
  columns: string[];
  align: Align[];
  rows: string[][];
}

const ALIGN_NEXT: Record<string, Align> = { null: "left", left: "center", center: "right", right: null };
const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight };

function toGrid(t: MdTable): Grid {
  return {
    columns: [...t.columns],
    align: t.columns.map((_, c) => t.align?.[c] ?? null),
    rows: t.rows.map((r) => [...r]),
  };
}

/** Trimmed, as markdown stores cells — what Apply writes and what counts as a change. */
function toTable(g: MdTable): MdTable {
  return {
    columns: g.columns.map((c) => c.trim()),
    align: g.columns.map((_, c) => g.align?.[c] ?? null),
    rows: g.rows.map((r) => r.map((c) => c.trim())),
  };
}

const same = (a: MdTable, b: MdTable) => JSON.stringify(toTable(a)) === JSON.stringify(toTable(b));

const move = <T,>(xs: T[], from: number, to: number): T[] => {
  const next = [...xs];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
};

/**
 * The table dialog (specs/editor/table-editor.feature.md): a grid over one
 * markdown table, opened from the toolbar or the preview. Edits stay in the
 * dialog until Apply; Cancel asks first when something would be lost.
 */
export function TableDialog({ initial, mode, locked = [], onApply, onCancel }: TableDialogProps) {
  const [grid, setGrid] = useState<Grid>(() => toGrid(initial));
  const changed = useMemo(() => !same(grid, initial), [grid, initial]);
  const trapRef = useFocusTrap(true);
  const gridRef = useRef<HTMLDivElement>(null);
  // The discard confirmation is the app's own dialog, rendered inside this
  // one so it stacks over it.
  const { modal, confirm } = useModalPrompts();
  const owned = (name: string) => locked.includes(name.trim());

  const cellInput = (r: number, c: number): HTMLInputElement | null =>
    gridRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${r},${c}"]`) ?? null;
  // A cell that is not there yet (the row Enter adds) or whose neighbour was
  // just removed is focused once React has committed the grid.
  const pendingFocus = useRef<[number, number] | null>(null);
  useEffect(() => {
    const at = pendingFocus.current;
    if (!at) return;
    pendingFocus.current = null;
    cellInput(at[0], at[1])?.focus();
  });

  const setCell = (r: number, c: number, value: string) =>
    setGrid((g) =>
      r === -1
        ? { ...g, columns: g.columns.map((x, i) => (i === c ? value : x)) }
        : { ...g, rows: g.rows.map((row, ri) => (ri === r ? row.map((x, i) => (i === c ? value : x)) : row)) },
    );
  const addColumn = () =>
    setGrid((g) => ({ columns: [...g.columns, ""], align: [...g.align, null], rows: g.rows.map((r) => [...r, ""]) }));
  // Removing takes the button that was clicked with it; focus moves to the
  // neighbouring column's name or row's first cell rather than falling out
  // of the dialog, where an Escape would reach the page behind it.
  const removeColumn = (c: number) => {
    pendingFocus.current = [-1, Math.max(0, c - 1)];
    setGrid((g) => ({
      columns: g.columns.filter((_, i) => i !== c),
      align: g.align.filter((_, i) => i !== c),
      rows: g.rows.map((r) => r.filter((_, i) => i !== c)),
    }));
  };
  const moveColumn = (c: number, to: number) =>
    setGrid((g) => ({
      columns: move(g.columns, c, to),
      align: move(g.align, c, to),
      rows: g.rows.map((r) => move(r, c, to)),
    }));
  const cycleAlign = (c: number) =>
    setGrid((g) => ({ ...g, align: g.align.map((a, i) => (i === c ? ALIGN_NEXT[String(a)]! : a)) }));
  const addRow = () => setGrid((g) => ({ ...g, rows: [...g.rows, g.columns.map(() => "")] }));
  const removeRow = (r: number) => {
    pendingFocus.current = grid.rows.length > 1 ? [Math.min(r, grid.rows.length - 2), 0] : [-1, 0];
    setGrid((g) => ({ ...g, rows: g.rows.filter((_, i) => i !== r) }));
  };
  const moveRow = (r: number, to: number) => setGrid((g) => ({ ...g, rows: move(g.rows, r, to) }));


  const apply = () => onApply(toTable(grid));

  const cancel = async () => {
    if (changed) {
      const ok = await confirm({
        title: "Discard changes",
        body:
          mode === "edit"
            ? "The table in the text is unchanged; the edits made here will be lost."
            : "The table has not been inserted and will be lost.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    onCancel();
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete table",
      body: "The table is removed from the text.",
      confirmLabel: "Delete",
    });
    if (ok) onApply(null);
  };

  // An Escape pressed with focus outside the dialog — on the page body,
  // after a click on nothing — is still the dialog's: the app's own Escape
  // (close the pane) must not get past a modal. Seen first, in the capture
  // phase, so the app's window listener never does.
  const latestCancel = useRef(cancel);
  latestCancel.current = cancel;
  useEffect(() => {
    const onDocKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || trapRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      void latestCancel.current();
    };
    document.addEventListener("keydown", onDocKeyDown, true);
    return () => document.removeEventListener("keydown", onDocKeyDown, true);
  }, [trapRef]);

  // Escape cancels and ⌘Enter applies from anywhere in the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      void cancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply();
    }
  };

  // In a cell: Tab and Shift+Tab walk the cells, Enter goes down a row —
  // adding one below the last — so a table types like a spreadsheet.
  const onCellKeyDown = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const width = grid.columns.length;
    if (e.key === "Tab") {
      const next = e.shiftKey ? (c > 0 ? [r, c - 1] : r > -1 ? [r - 1, width - 1] : null) : c < width - 1 ? [r, c + 1] : r < grid.rows.length - 1 ? [r + 1, 0] : null;
      // Off the last cell, Tab goes on to the buttons as usual.
      if (!next) return;
      e.preventDefault();
      cellInput(next[0]!, next[1]!)?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (r === grid.rows.length - 1) {
        pendingFocus.current = [r + 1, c];
        addRow();
      } else {
        cellInput(r + 1, c)?.focus();
      }
    }
  };

  // A block pasted from a spreadsheet fills the grid from the cell on; a
  // single value pastes into the cell as text.
  const onCellPaste = (e: ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const cells = parseClip(e.clipboardData.getData("text/plain"));
    if (!cells) return;
    e.preventDefault();
    setGrid((g) => {
      const t = pasteCells(g, r, c, cells);
      return { columns: t.columns, align: t.align ?? g.align, rows: t.rows };
    });
  };

  const width = grid.columns.length;
  return (
    <div className="dialog-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={trapRef}
        className="dialog table-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "edit" ? "Edit table" : "Insert table"}
      >
        <h3>{mode === "edit" ? "Edit table" : "Insert table"}</h3>
        <div ref={gridRef} className="table-grid">
          <table>
            <thead>
              <tr>
                <th className="edge" />
                {grid.columns.map((name, c) => {
                  const lock = owned(name);
                  const AlignIcon = ALIGN_ICON[grid.align[c] ?? "left"];
                  return (
                    <th key={c}>
                      <div className="cell">
                        <input
                          data-cell={`-1,${c}`}
                          autoFocus={c === 0}
                          value={name}
                          readOnly={lock}
                          placeholder="name"
                          spellCheck={false}
                          aria-label={`Column ${c + 1} name`}
                          title={lock ? `Owned by {${name.trim()}} in the text` : undefined}
                          onChange={(e) => setCell(-1, c, e.target.value)}
                          onKeyDown={(e) => onCellKeyDown(e, -1, c)}
                          onPaste={(e) => onCellPaste(e, -1, c)}
                        />
                      </div>
                      <div className="column-tools">
                        <Tooltip label={`Align: ${grid.align[c] ?? "default"}`}>
                          <button
                            type="button"
                            className={`ghost${grid.align[c] ? " on" : ""}`}
                            aria-label={`Alignment of column ${name.trim() || c + 1}: ${grid.align[c] ?? "default"}`}
                            onClick={() => cycleAlign(c)}
                          >
                            <AlignIcon size={12} aria-hidden="true" />
                          </button>
                        </Tooltip>
                        <Tooltip label="Move column left">
                          <button
                            type="button"
                            className="ghost"
                            disabled={c === 0}
                            aria-label={`Move column ${name.trim() || c + 1} left`}
                            onClick={() => moveColumn(c, c - 1)}
                          >
                            <ChevronLeft size={12} aria-hidden="true" />
                          </button>
                        </Tooltip>
                        <Tooltip label="Move column right">
                          <button
                            type="button"
                            className="ghost"
                            disabled={c === width - 1}
                            aria-label={`Move column ${name.trim() || c + 1} right`}
                            onClick={() => moveColumn(c, c + 1)}
                          >
                            <ChevronRight size={12} aria-hidden="true" />
                          </button>
                        </Tooltip>
                        <Tooltip label={lock ? `Remove {${name.trim()}} from the text first` : "Remove column"}>
                          <button
                            type="button"
                            className="ghost danger"
                            disabled={lock || width === 1}
                            aria-label={`Remove column ${name.trim() || c + 1}`}
                            onClick={() => removeColumn(c)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </Tooltip>
                      </div>
                    </th>
                  );
                })}
                <th className="edge">
                  <button type="button" className="table-add" aria-label="Add column" onClick={addColumn}>
                    + Column
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, r) => (
                <tr key={r}>
                  <td className="edge row-tools">
                    <button
                      type="button"
                      className="ghost"
                      disabled={r === 0}
                      title="Move row up"
                      aria-label={`Move row ${r + 1} up`}
                      onClick={() => moveRow(r, r - 1)}
                    >
                      <ChevronUp size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={r === grid.rows.length - 1}
                      title="Move row down"
                      aria-label={`Move row ${r + 1} down`}
                      onClick={() => moveRow(r, r + 1)}
                    >
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  </td>
                  {row.map((cell, c) => (
                    <td key={c} style={grid.align[c] ? { textAlign: grid.align[c]! } : undefined}>
                      <input
                        data-cell={`${r},${c}`}
                        value={cell}
                        spellCheck={false}
                        aria-label={`Row ${r + 1}, ${grid.columns[c]!.trim() || `column ${c + 1}`}`}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, r, c)}
                        onPaste={(e) => onCellPaste(e, r, c)}
                      />
                    </td>
                  ))}
                  <td className="edge">
                    <button
                      type="button"
                      className="ghost danger"
                      title="Remove row"
                      aria-label={`Remove row ${r + 1}`}
                      onClick={() => removeRow(r)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-actions">
            <button type="button" className="table-add" aria-label="Add row" onClick={addRow}>
              + Row
            </button>
          </div>
        </div>
        <p className="table-hint">
          Tab moves across cells, Enter down a row. Paste a block from a spreadsheet to fill several cells.
        </p>
        <div className="dialog-actions">
          {mode === "edit" && (
            <button type="button" className="btn btn-danger" onClick={() => void remove()}>
              Delete table
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => void cancel()}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={mode === "edit" && !changed}>
            {mode === "edit" ? "Save" : "Insert"}
          </button>
        </div>
        {modal}
      </div>
    </div>
  );
}
