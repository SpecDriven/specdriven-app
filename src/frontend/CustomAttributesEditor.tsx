// Settings → Custom attributes (specs/app/custom-attributes.feature.md
// "Custom attributes are defined in Settings"): the data repo's
// `custom-attributes.txt` in a monospace editor, checked as it is typed, and
// autosaved like the README (App.tsx autosaveReadme): one write at a time,
// `from` folding in a disk edit, a flush on blur and when Settings closes. It
// saves whatever it holds — problems and all; a definition with a problem is
// simply left out where the file is read.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CUSTOM_ATTRIBUTES_FILE,
  EXAMPLE_ATTRIBUTE_DEFINITIONS,
  parseAttributeDefinitions,
  type AttributeDefinition,
  type AttributeDefinitions,
} from "../server/customAttributes";
import { createPromiseQueue } from "./promiseQueue";

/** Writes the file; resolves to what landed on disk (a fold may differ). */
export type SaveCustomAttributes = (content: string, from: string) => Promise<string>;

export const saveCustomAttributesOverHttp: SaveCustomAttributes = async (content, from) => {
  const res = await fetch("/api/custom-attributes", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, from }),
  });
  const data = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return typeof data.content === "string" ? data.content : content;
};

/** "1 problem", "3 problems", "No problems". */
export function problemCount(n: number): string {
  return n === 0 ? "No problems" : `${n} problem${n === 1 ? "" : "s"}`;
}

/** Where a definition applies, as the summary says it. */
function scopeText(d: AttributeDefinition): string {
  return d.scope.length === 2 ? "features and scenarios" : `${d.scope[0]}s only`;
}

const PROBLEMS_ID = "custom-attributes-problems";

/** The editor as it renders: the text, its problems, and what it defines. */
export function CustomAttributesView({
  text,
  defs,
  onChange,
  onBlur,
}: {
  text: string;
  defs: AttributeDefinitions;
  onChange: (text: string) => void;
  onBlur?: () => void;
}) {
  const problems = defs.diagnostics;
  return (
    <div className="custom-attributes-editor">
      <textarea
        className="custom-attributes-text"
        aria-label="Custom attribute definitions"
        aria-describedby={problems.length > 0 ? PROBLEMS_ID : undefined}
        aria-invalid={problems.length > 0 ? true : undefined}
        spellCheck={false}
        rows={Math.min(24, Math.max(8, text.split("\n").length + 1))}
        value={text}
        placeholder={"[br:<rule>:on|off|<value>]\n  label: Business rule"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <p className={`custom-attributes-status${problems.length > 0 ? " has-problems" : ""}`} role="status">
        {problemCount(problems.length)}
        {defs.list.length > 0 &&
          ` · ${defs.list.length} attribute${defs.list.length === 1 ? "" : "s"} defined`}
      </p>
      {problems.length > 0 && (
        <ul id={PROBLEMS_ID} className="custom-attributes-problems">
          {problems.map((p) => (
            <li key={`${p.line}:${p.column}:${p.message}`} title={`Line ${p.line}, column ${p.column}`}>
              Line {p.line}: {p.message}
            </li>
          ))}
        </ul>
      )}
      {defs.list.length > 0 && (
        <ul className="custom-attributes-summary">
          {defs.list.map((d) => (
            <li key={d.key}>
              <strong>{d.label}</strong> <code>{d.pattern}</code>{" "}
              <span className="hint">
                on {scopeText(d)}
                {d.description ? ` — ${d.description}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {text.trim() === "" && (
        <button type="button" className="secondary" onClick={() => onChange(EXAMPLE_ATTRIBUTE_DEFINITIONS)}>
          Start from the example
        </button>
      )}
    </div>
  );
}

/**
 * The editor with its autosave. `content` is the file as the listing last
 * read it; it replaces the buffer only while the buffer holds no unsaved
 * edit, so a teammate's definitions arrive without eating what is typed.
 */
export function CustomAttributesEditor({
  content,
  autosaveSeconds,
  onSaved,
  onError,
  save = saveCustomAttributesOverHttp,
}: {
  content: string;
  autosaveSeconds: number;
  onSaved: (content: string) => void;
  onError?: (message: string) => void;
  save?: SaveCustomAttributes;
}) {
  const [text, setText] = useState(content);
  const textRef = useRef(content);
  /** What the buffer grew out of: the file as last loaded or saved. */
  const saved = useRef(content);
  const queue = useRef(createPromiseQueue());
  const defs = useMemo(() => parseAttributeDefinitions(text), [text]);

  useEffect(() => {
    if (textRef.current === saved.current && content !== saved.current) {
      saved.current = content;
      textRef.current = content;
      setText(content);
    }
  }, [content]);

  const flush = useRef(async () => {});
  flush.current = async () => {
    if (textRef.current === saved.current) return;
    await queue.current.run(async () => {
      const toWrite = textRef.current;
      if (toWrite === saved.current) return;
      try {
        const written = await save(toWrite, saved.current);
        if (textRef.current === toWrite) {
          saved.current = written;
          if (written !== toWrite) {
            textRef.current = written;
            setText(written);
          }
        } else {
          saved.current = toWrite;
        }
        onSaved(written);
      } catch (e) {
        onError?.(`${CUSTOM_ATTRIBUTES_FILE} not saved: ${(e as Error).message} — will retry.`);
      }
    });
  };

  useEffect(() => {
    const id = setInterval(() => void flush.current(), autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void flush.current();
    };
  }, [autosaveSeconds]);

  return (
    <CustomAttributesView
      text={text}
      defs={defs}
      onChange={(next) => {
        textRef.current = next;
        setText(next);
      }}
      onBlur={() => void flush.current()}
    />
  );
}
