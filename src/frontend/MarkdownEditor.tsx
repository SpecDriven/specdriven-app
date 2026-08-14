import { useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  insertImage,
  insertLink,
  renderMarkdown,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "./markdown";
import type { Edit } from "./markdown";

/** POST the image to the data repo; resolves to the url for `![...](url)`. */
async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/images", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? "image upload failed");
  return body.path;
}

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  // Images (specs/images.spec.md): pasted or picked files upload to the data
  // repo; each finished upload drops `![alt](/api/images/…)` at the caret.
  const addImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploadError(null);
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const url = await uploadImage(file);
        const alt = file.name.replace(/\.[^.]*$/, "") || "image";
        apply((t, s, e) => insertImage(t, s, e, alt, url));
      } catch (e) {
        setUploadError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return; // plain text pastes as usual
    e.preventDefault();
    void addImages(files);
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
    { label: "🖼", cls: "", title: "Image (or paste one)", run: () => fileRef.current?.click() },
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
            {uploadError && <span className="md-upload-error">{uploadError}</span>}
            {uploading > 0 && <span className="md-upload-status">Uploading…</span>}
            {tools.map((t) => (
              <button key={t.title} type="button" className={t.cls} title={t.title} aria-label={t.title} onClick={t.run}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {!readOnly && (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages(Array.from(e.target.files ?? []));
            e.target.value = ""; // allow re-picking the same file
          }}
        />
      )}
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
          onPaste={readOnly ? undefined : onPaste}
        />
      ) : (
        <div className="md-preview">{renderMarkdown(value) ?? <p className="md-empty">Nothing to preview.</p>}</div>
      )}
    </div>
  );
}
