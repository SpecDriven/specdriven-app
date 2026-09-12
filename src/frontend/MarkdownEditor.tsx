import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactElement, UIEvent } from "react";
import {
  Bold,
  Code,
  Heading,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  PencilRuler,
  Quote,
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import {
  imageRefs,
  insertImage,
  insertLink,
  renderMarkdown,
  setImageSrc,
  setImageWidth,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "./markdown";
import type { Edit } from "./markdown";
import { diagramName } from "./excalidraw/diagram";
import type { ExcalidrawEdit } from "./excalidraw/ExcalidrawPane";
import { markNodes, markText } from "./highlight";
import { ImageSizingContext } from "./MarkdownImage";
import type { ImageSizing } from "./MarkdownImage";
import { useVimMode } from "./vimPref";
import { useExcalidrawEnabled } from "./excalidrawPref";
import type { TextSurface } from "./VimEditor";

// CodeMirror and the vim extension are only mounted once a Vim tab is shown.
// Loaded lazily so a bundler that splits can keep them out of the main bundle
// (Bun's dev bundle inlines them; a server render shows the fallback).
const VimEditor = lazy(() => import("./VimEditor").then((m) => ({ default: m.VimEditor })));
// Excalidraw (specs/editor/excalidraw-support.feature.md) the same way: the
// pane, and the library with it, load the first time a diagram is drawn.
const ExcalidrawPane = lazy(() =>
  import("./excalidraw/ExcalidrawPane").then((m) => ({ default: m.ExcalidrawPane })),
);

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
  /**
   * Words to mark in the text (specs/search.feature.md): the terms a search
   * hit matched on, when the editor was opened from that hit. Marked in the
   * source and in the preview, and the first one is scrolled into view.
   */
  highlight?: string[];
  /**
   * The tab the editor opens on. Write by default (Vim, with Vim mode on);
   * "preview" for text the user is more likely to read than rewrite — the
   * feature description opens rendered, and Write is a click away.
   */
  initialTab?: "write" | "preview";
}

type Tab = "write" | "vim" | "preview";

/**
 * Embedded markdown editor for the scenario body (specs/ui.spec.md "Scenario
 * edit dialog"): a formatting toolbar over a source textarea, with a rendered
 * Preview tab — and, with Vim mode on in Settings, a Vim tab editing the same
 * text with Vim's keys (src/frontend/VimEditor.tsx).
 */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  highlight,
  initialTab,
}: MarkdownEditorProps) {
  const vimOn = useVimMode();
  const [tab, setTab] = useState<Tab>(
    readOnly || initialTab === "preview" ? "preview" : vimOn ? "vim" : "write",
  );
  // The Settings switch flipping while an editor is open moves it over; a
  // read-only body has nothing to edit, so it never shows the Vim tab.
  useEffect(() => {
    if (readOnly) return;
    if (vimOn && tab === "write") setTab("vim");
    if (!vimOn && tab === "vim") setTab("write");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vimOn, readOnly]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const vimRef = useRef<TextSurface>(null);
  const editing = tab === "write" || tab === "vim";
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Excalidraw (specs/editor/excalidraw-support.feature.md): with the Settings
  // switch on, a toolbar button opens the pane over this editor; its export
  // comes back as a file and goes through the image upload like a paste.
  // A diagram already in the text opens the same pane from the Preview tab
  // ("Edit Excalidraw diagram"), and its export replaces that image instead.
  const excalidrawOn = useExcalidrawEnabled();
  const [diagram, setDiagram] = useState<
    { mode: "new" } | { mode: "edit"; index: number; edit: ExcalidrawEdit } | null
  >(null);

  // Search-term marks (specs/search.feature.md). A textarea cannot carry
  // markup, so a mirror of its text sits behind it — same font, padding and
  // wrapping, transparent ink — painting only the marks; the textarea over
  // it is made transparent so they show through. The mirror follows the
  // textarea's scroll and its client width (a scrollbar narrows the text).
  const marks = highlight && highlight.length > 0 ? highlight : null;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
  };
  useEffect(() => {
    const ta = ref.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      mirror.style.width = `${ta.clientWidth}px`;
      mirror.style.height = `${ta.clientHeight}px`;
      mirror.scrollTop = ta.scrollTop;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, [marks !== null, tab]);
  // Land on the first mark: a third of the way down the pane, so the lines
  // around it read too. Once per set of terms and tab, not on every keystroke.
  const marksKey = marks?.join(" ") ?? "";
  useEffect(() => {
    if (!marks) return;
    const pane = tab === "write" ? ref.current : previewRef.current;
    const marked = (tab === "write" ? mirrorRef.current : previewRef.current)?.querySelector("mark");
    if (!pane || !marked) return;
    const top =
      marked.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
    if (mirrorRef.current) mirrorRef.current.scrollTop = pane.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, tab]);

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

  // The pane being edited, seen the same way whichever it is: the toolbar
  // and shortcuts read the selection from it and put it back after an edit.
  const surface = (): TextSurface | null => {
    if (tab === "vim") return vimRef.current;
    const ta = ref.current;
    if (!ta) return null;
    return {
      focus: () => ta.focus(),
      get: () => ({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }),
      select: (start, end) => ta.setSelectionRange(start, end),
    };
  };

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const s = surface();
    if (!s) return;
    const { text, start, end } = s.get();
    const r = edit(text, start, end);
    onChange(r.text);
    // Restore focus and selection once React has committed the new value.
    requestAnimationFrame(() => {
      s.focus();
      s.select(r.start, r.end);
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

  // Image sizing (src/frontend/MarkdownImage.tsx): the handle on an image in
  // the Preview tab writes its width into the source, through onChange like
  // any other edit. One sizing object for the editor's life, reading the
  // latest text and callback through a ref. A double-click on an image
  // already at its natural size changes nothing, and says nothing.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  // The edited diagram, uploaded like any other image but landing over the
  // one it was opened from rather than at the caret — so the diagram shown
  // in the text is the edited one (specs/editor/excalidraw-support.feature.md
  // "Edit Excalidraw diagram"). The image is found again by index at save
  // time, against the text as it stands then.
  const saveDiagram = async (index: number, file: File) => {
    setUploadError(null);
    setUploading((n) => n + 1);
    try {
      const url = await uploadImage(file);
      const alt = file.name.replace(/\.[^.]*$/, "") || "image";
      const { value: text, onChange: change } = latest.current;
      const next = setImageSrc(text, index, url, alt);
      if (next !== text) change(next);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  // Opening a diagram from the preview: the image's own url and name, read
  // from the text as it stands. Through a ref, so the sizing object below
  // stays one for the editor's life while the text moves on.
  const openDiagram = useRef<(index: number) => void>(() => {});
  openDiagram.current = (index) => {
    const ref = imageRefs(latest.current.value.replaceAll("\r\n", "\n"))[index];
    if (!ref) return;
    setDiagram({ mode: "edit", index, edit: { url: ref.src, name: diagramName(ref.alt, ref.src) } });
  };
  const sizing = useMemo<ImageSizing>(
    () => ({
      resize: (index, width) => {
        const { value: text, onChange: change } = latest.current;
        const next = setImageWidth(text, index, width);
        if (next !== text) change(next);
      },
      // Off with the Settings switch, so no diagram offers the control.
      ...(excalidrawOn ? { editDiagram: (index: number) => openDiagram.current(index) } : {}),
    }),
    [excalidrawOn],
  );

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return; // plain text pastes as usual
    e.preventDefault();
    void addImages(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
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

  // The toolbar (specs/ui/ui.feature.md "Design system"): icon buttons, each
  // with a tooltip naming the action and, where there is one, its shortcut.
  const size = 14;
  const tools: { icon: ReactElement; title: string; keys?: string; run: () => void }[] = [
    { icon: <Heading size={size} />, title: "Heading", run: () => apply((t, s, e) => toggleHeading(t, s, e)) },
    { icon: <Bold size={size} />, title: "Bold", keys: "⌘B", run: () => apply((t, s, e) => toggleInline(t, s, e, "**")) },
    { icon: <Italic size={size} />, title: "Italic", keys: "⌘I", run: () => apply((t, s, e) => toggleInline(t, s, e, "*")) },
    { icon: <Code size={size} />, title: "Inline code", run: () => apply((t, s, e) => toggleInline(t, s, e, "`")) },
    { icon: <Quote size={size} />, title: "Quote", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "> ", /^> /)) },
    { icon: <List size={size} />, title: "Bullet list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "- ", /^[-*+] /)) },
    { icon: <ListOrdered size={size} />, title: "Numbered list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, (i) => `${i + 1}. `, /^\d+[.)] /)) },
    { icon: <Link size={size} />, title: "Link", keys: "⌘K", run: () => apply(insertLink) },
    { icon: <Image size={size} />, title: "Image (or paste one)", run: () => fileRef.current?.click() },
    ...(excalidrawOn
      ? [{ icon: <PencilRuler size={size} />, title: "Excalidraw diagram", run: () => setDiagram({ mode: "new" }) }]
      : []),
  ];

  // The pane closing gives focus back to the text — once React has taken the
  // pane down, so nothing of it (its own focus trap, the discard dialog's)
  // moves focus after this; on Insert, apply() then lands the caret after
  // the embedded link once the upload finishes. A diagram opened from the
  // Preview tab has no text pane to go back to, and leaves focus alone.
  const closeDiagram = () => setDiagram(null);
  const diagramWasOpen = useRef(false);
  useEffect(() => {
    if (diagramWasOpen.current && !diagram && editing) surface()?.focus();
    diagramWasOpen.current = diagram !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram]);

  const preview = tab === "preview" ? renderMarkdown(value) : null;

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
          {vimOn && !readOnly && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "vim"}
              className={tab === "vim" ? "active" : ""}
              onClick={() => setTab("vim")}
            >
              Vim
            </button>
          )}
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
        {!readOnly && editing && (
          <div className="md-tools">
            {uploadError && <span className="md-upload-error">{uploadError}</span>}
            {uploading > 0 && <span className="md-upload-status">Uploading…</span>}
            {tools.map((t) => (
              <Tooltip key={t.title} label={t.title} keys={t.keys}>
                <button type="button" aria-label={t.title} onClick={t.run}>
                  {t.icon}
                </button>
              </Tooltip>
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
      {diagram && !readOnly && (
        <Suspense
          fallback={
            <div className="dialog-backdrop">
              <div className="dialog">Loading Excalidraw…</div>
            </div>
          }
        >
          <ExcalidrawPane
            edit={diagram.mode === "edit" ? diagram.edit : undefined}
            onCancel={closeDiagram}
            onInsert={(file) => {
              const target = diagram.mode === "edit" ? diagram.index : null;
              closeDiagram();
              // A new diagram lands at the caret; an edited one over the
              // image it came from.
              if (target === null) void addImages([file]);
              else void saveDiagram(target, file);
            }}
          />
        </Suspense>
      )}
      {tab === "write" ? (
        <div className={`md-write${marks ? " highlighted" : ""}`}>
          {marks && (
            <div ref={mirrorRef} className="md-highlights" aria-hidden="true">
              {/* The trailing newline keeps a final empty line, as the textarea does. */}
              {markText(value, marks)}
              {"\n"}
            </div>
          )}
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
            onScroll={marks ? onScroll : undefined}
            onKeyDown={readOnly ? undefined : onKeyDown}
            onPaste={readOnly ? undefined : onPaste}
          />
        </div>
      ) : tab === "vim" ? (
        <Suspense fallback={<div className="md-vim-loading">Loading Vim…</div>}>
          <VimEditor
            ref={vimRef}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            highlight={marks}
            onPasteFiles={(files) => void addImages(files)}
            onShortcut={onKeyDown}
          />
        </Suspense>
      ) : (
        <div ref={previewRef} className="md-preview">
          {preview === null ? (
            <p className="md-empty">Nothing to preview.</p>
          ) : (
            // A published (read-only) body keeps its images as they are.
            <ImageSizingContext.Provider value={readOnly ? null : sizing}>
              {marks ? markNodes(preview, marks) : preview}
            </ImageSizingContext.Provider>
          )}
        </div>
      )}
    </div>
  );
}
