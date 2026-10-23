import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Table } from "lucide-react";

/**
 * How an editable preview lets a table be edited (specs/editor/table-editor
 * .feature.md): `editTable(index)` opens the dialog on the index-th table of
 * the text. Null — a read-only body, a scenario card — leaves tables plain.
 */
export interface TableEditing {
  editTable(index: number): void;
}

export const TableEditContext = createContext<TableEditing | null>(null);

interface MarkdownTableProps {
  /** Which table of the text this is, counting from the top. */
  index: number;
  children: ReactNode;
}

/**
 * A rendered markdown table. In an editable preview it carries a button in
 * its top-right corner, on hover, that opens the table dialog on it; a
 * preview without editing renders the bare table.
 */
export function MarkdownTable({ index, children }: MarkdownTableProps) {
  const editing = useContext(TableEditContext);
  if (!editing) return <table>{children}</table>;
  return (
    <div className="md-table">
      <table>{children}</table>
      <button
        type="button"
        className="md-table-edit"
        aria-label={`Edit table ${index + 1}`}
        title="Edit this table"
        onClick={() => editing.editTable(index)}
      >
        <Table size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
