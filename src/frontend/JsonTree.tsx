// A JSON value as a folding tree (src/frontend/DataPage.tsx): objects and
// arrays open and close, scalars read in their own colour. Branches deeper
// than `openDepth` start closed; `generation` reopens or closes everything
// at once when the page's Expand all / Collapse all change it.

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

export interface JsonTreeProps {
  value: unknown;
  /** Branches at this depth and below start closed. Default 2. */
  openDepth?: number;
  /** Bumped with a new openDepth to reset every branch to it. */
  generation?: number;
}

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function scalarClass(value: unknown): string {
  if (value === null || value === undefined) return "json-null";
  return `json-${typeof value}`;
}

function scalarText(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function summary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  const n = Object.keys(value).length;
  return n === 1 ? "1 key" : `${n} keys`;
}

function Branch({
  name,
  value,
  depth,
  openDepth,
  generation,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  openDepth: number;
  generation: number;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  useEffect(() => {
    setOpen(depth < openDepth);
  }, [generation, openDepth, depth]);
  const label = name === null ? null : <span className="json-key">{name}</span>;
  if (!isBranch(value)) {
    return (
      <li className="json-leaf">
        {label}
        {label && <span className="json-colon">: </span>}
        <span className={`json-value ${scalarClass(value)}`}>{scalarText(value)}</span>
      </li>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [openBracket, closeBracket] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <li className={`json-branch${open ? " open" : ""}`}>
      <button type="button" className="json-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={11} className="json-caret" aria-hidden="true" />
        {label}
        {label && <span className="json-colon">: </span>}
        <span className="json-bracket">{openBracket}</span>
        {!open && (
          <>
            <span className="json-summary">{summary(value)}</span>
            <span className="json-bracket">{closeBracket}</span>
          </>
        )}
      </button>
      {open && (
        <>
          <ul className="json-tree">
            {entries.map(([k, v]) => (
              <Branch key={k} name={k} value={v} depth={depth + 1} openDepth={openDepth} generation={generation} />
            ))}
          </ul>
          <span className="json-bracket json-close">{closeBracket}</span>
        </>
      )}
    </li>
  );
}

export function JsonTree({ value, openDepth = 2, generation = 0 }: JsonTreeProps) {
  return (
    <ul className="json-tree json-root">
      <Branch name={null} value={value} depth={0} openDepth={openDepth} generation={generation} />
    </ul>
  );
}
