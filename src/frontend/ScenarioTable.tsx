import { useEffect, useMemo, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { X } from "lucide-react";
import { extractVars, findTable, replaceTable } from "./mdtable";
import type { MdTable } from "./mdtable";

interface ScenarioTableProps {
  /** The scenario body markdown — the single source of truth. */
  body: string;
  onChange: (body: string) => void;
}

const columnHelper = createColumnHelper<string[]>();
const NO_ROWS: string[][] = [];

interface CellInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: string;
  onCommit: (value: string) => void;
}

/**
 * Markdown table cells are stored trimmed, but a trailing space must survive
 * while the user is still typing ("hello world" passes through "hello ").
 * While focused the input shows its own draft; the trimmed canonical value
 * takes over on blur.
 */
function CellInput({ value, onCommit, ...rest }: CellInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
    />
  );
}

/**
 * Structured editor for the markdown table in the scenario body
 * (specs/scenario-table.spec.md). Headless TanStack Table provides the
 * column/row model; cells are plain controlled inputs, and every edit
 * rewrites the table block inside the body text.
 */
export function ScenarioTable({ body, onChange }: ScenarioTableProps) {
  const tbl = useMemo(() => findTable(body), [body]);
  const vars = useMemo(() => extractVars(body), [body]);

  // specs/scenario-table.spec.md "variable creates a column": a {var} in the
  // body guarantees a column of that name, creating the table if needed.
  useEffect(() => {
    const missing = vars.filter((v) => !tbl?.columns.includes(v));
    if (missing.length === 0) return;
    onChange(
      replaceTable(
        body,
        tbl
          ? {
              columns: [...tbl.columns, ...missing],
              rows: tbl.rows.map((r) => [...r, ...missing.map(() => "")]),
            }
          : { columns: missing, rows: [missing.map(() => "")] },
      ),
    );
  }, [body, tbl, vars, onChange]);

  const columns = useMemo(
    () =>
      (tbl?.columns ?? []).map((name, i) =>
        columnHelper.accessor((row) => row[i] ?? "", { id: String(i), header: name }),
      ),
    [tbl],
  );

  const rt = useReactTable({
    data: tbl?.rows ?? NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (!tbl) {
    return (
      <div>
        <button
          type="button"
          className="table-add"
          onClick={() => onChange(replaceTable(body, { columns: [""], rows: [[""]] }))}
        >
          + Add table
        </button>
      </div>
    );
  }

  const update = (next: MdTable | null) => onChange(replaceTable(body, next));

  const setCell = (r: number, c: number, value: string) =>
    update({
      ...tbl,
      rows: tbl.rows.map((row, ri) =>
        ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row,
      ),
    });

  const renameColumn = (c: number, name: string) =>
    update({ columns: tbl.columns.map((n, i) => (i === c ? name : n)), rows: tbl.rows });

  const addColumn = () =>
    update({ columns: [...tbl.columns, ""], rows: tbl.rows.map((r) => [...r, ""]) });

  // Removing the last column removes the table itself — a zero-column table
  // has no markdown form (specs/scenario-table.spec.md).
  const removeColumn = (c: number) =>
    update(
      tbl.columns.length === 1
        ? null
        : {
            columns: tbl.columns.filter((_, i) => i !== c),
            rows: tbl.rows.map((r) => r.filter((_, i) => i !== c)),
          },
    );

  const addRow = () => update({ ...tbl, rows: [...tbl.rows, tbl.columns.map(() => "")] });

  const removeRow = (r: number) => update({ ...tbl, rows: tbl.rows.filter((_, i) => i !== r) });

  return (
    <div className="scenario-table">
      <table>
        <thead>
          <tr>
            {rt.getHeaderGroups()[0]!.headers.map((h) => {
              const c = Number(h.column.id);
              const name = tbl.columns[c]!;
              // A column matching a {var} in the body is owned by the
              // variable: rename or remove it by editing the body.
              const owned = vars.includes(name);
              return (
                <th key={h.id}>
                  <div className="cell">
                    <CellInput
                      value={name}
                      readOnly={owned}
                      placeholder="name"
                      aria-label={`Column ${c + 1} name`}
                      title={owned ? `Owned by {${name}} in the body` : undefined}
                      onCommit={(v) => renameColumn(c, v)}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={owned}
                      title={owned ? `Remove {${name}} from the body first` : "Remove column"}
                      aria-label={`Remove column ${name || c + 1}`}
                      onClick={() => removeColumn(c)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                </th>
              );
            })}
            <th className="edge">
              <button type="button" className="ghost" title="Add column" aria-label="Add column" onClick={addColumn}>
                +
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rt.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const c = Number(cell.column.id);
                return (
                  <td key={cell.id}>
                    <CellInput
                      value={cell.getValue<string>()}
                      aria-label={`Row ${row.index + 1}, ${tbl.columns[c] || `column ${c + 1}`}`}
                      onCommit={(v) => setCell(row.index, c, v)}
                    />
                  </td>
                );
              })}
              <td className="edge">
                <button
                  type="button"
                  className="ghost"
                  title="Remove row"
                  aria-label={`Remove row ${row.index + 1}`}
                  onClick={() => removeRow(row.index)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-actions">
        <button type="button" className="table-add" onClick={addRow}>
          + Row
        </button>
      </div>
    </div>
  );
}
