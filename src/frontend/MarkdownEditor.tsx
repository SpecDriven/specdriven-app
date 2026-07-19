import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  insertLink,
  renderMarkdown,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "./markdown";
import type { Edit } from "./markdown";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Published scenarios are immutable: source is read-only, preview first. */
  readOnly?: boolean;
  placeholder?: string;
}

/**
 * Embedded markdown editor for the scenario body (specs/ui.spec.md "Scenario
 * edit dialog"): a formatting toolbar over a source textarea, with a rendered
 * Preview tab.
 */
export function MarkdownEditor({ value, onChange, readOnly = false, placeholder }: MarkdownEditorProps) {
  const [tab, setTab] = useState<"write" | "preview">(readOnly ? "preview" : "write");
  const ref = useRef<HTMLTextAreaElement>(null);

  // The scenario table widget rewrites the body outside this textarea (e.g.
  // typing "{amount}" appends a table below the caret). A controlled textarea
  // would snap the caret to the end when the committed value differs from
  // what was typed — restore the position recorded at the last keystroke.
  const sel = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    const s = sel.current;
    if (!ta || !s || document.activeElement !== ta) return;
    if (ta.selectionStart !== s.start || ta.selectionEnd !== s.end)
      ta.setSelectionRange(s.start, s.end);
  }, [value]);

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const ta = ref.current;
    if (!ta) return;
    const r = edit(ta.value, ta.selectionStart, ta.selectionEnd);
    onChange(r.text);
    // Restore focus and selection once React has committed the new value.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.start, r.end);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      apply((t, s, en) => toggleInline(t, s, en, "**"));
    } else if (k === "i") {
      e.preventDefault();
      apply((t, s, en) => toggleInline(t, s, en, "*"));
    } else if (k === "k") {
      e.preventDefault();
      apply(insertLink);
    }
  };

  const tools = [
    { label: "H", cls: "", title: "Heading", run: () => apply((t, s, e) => toggleHeading(t, s, e)) },
    { label: "B", cls: "b", title: "Bold (⌘B)", run: () => apply((t, s, e) => toggleInline(t, s, e, "**")) },
    { label: "I", cls: "i", title: "Italic (⌘I)", run: () => apply((t, s, e) => toggleInline(t, s, e, "*")) },
    { label: "<>", cls: "code", title: "Inline code", run: () => apply((t, s, e) => toggleInline(t, s, e, "`")) },
    { label: "❝", cls: "", title: "Quote", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "> ", /^> /)) },
    { label: "•", cls: "", title: "Bullet list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "- ", /^[-*+] /)) },
    { label: "1.", cls: "code", title: "Numbered list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, (i) => `${i + 1}. `, /^\d+[.)] /)) },
    { label: "🔗", cls: "", title: "Link (⌘K)", run: () => apply(insertLink) },
  ];

  return (
    <div className="md-editor">
      <div className="md-toolbar">
        <div className="md-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            className={tab === "write" ? "active" : ""}
            onClick={() => setTab("write")}
          >
            {readOnly ? "Source" : "Write"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={tab === "preview" ? "active" : ""}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
        </div>
        {!readOnly && tab === "write" && (
          <div className="md-tools">
            {tools.map((t) => (
              <button key={t.title} type="button" className={t.cls} title={t.title} aria-label={t.title} onClick={t.run}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {tab === "write" ? (
        <textarea
          ref={ref}
          className="md-textarea"
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            sel.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
            onChange(e.target.value);
          }}
          onKeyDown={readOnly ? undefined : onKeyDown}
        />
      ) : (
        <div className="md-preview">{renderMarkdown(value) ?? <p className="md-empty">Nothing to preview.</p>}</div>
      )}
    </div>
  );
}
