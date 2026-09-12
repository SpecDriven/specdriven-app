import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
// The package's exports map offers its stylesheet only under the bundler
// conditions "development" and "production", neither of which Bun's HTML
// bundler applies, so the production sheet is reached by path.
import "../../../node_modules/@excalidraw/excalidraw/dist/prod/index.css";
import { Excalidraw, exportToSvg, getSceneVersion, loadFromBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useFocusTrap } from "../useFocusTrap";
import { useModalPrompts } from "../ModalPrompts";
import { svgFile } from "./diagram";

// The Excalidraw pane (specs/editor/excalidraw-support.feature.md "Create new
// Excalidraw diagram"): a full-window overlay over the Markdown editor that
// opened it. Insert exports the drawing as an SVG — with the scene embedded,
// so Excalidraw can open it again later — and hands it to the editor, which
// uploads and embeds it exactly like a pasted image.
//
// That embedded scene is what "Edit Excalidraw diagram" rests on: given the
// url of a diagram already in the text, the pane fetches the SVG, restores
// the drawing from it, and Save exports the edited scene the same way — the
// editor then points that image at the new export (src/frontend/
// MarkdownEditor.tsx), so the diagram shown in the text is the edited one.
//
// This module is the only one importing the library, and the editor loads it
// lazily: the ~2 MB of Excalidraw stays out of the main bundle until a
// diagram is actually drawn.

// Excalidraw fetches its fonts at runtime (for the canvas, and again to inline
// them into an export). Bun bundles nothing it cannot see from an import, so
// they come from the library's own CDN, pinned to the installed version, the
// same way in the web app, the demo, the desktop app and the compiled
// binary. Self-hosting them is a follow-up for offline desktop use.
const EXCALIDRAW_VERSION = "0.18.1";
if (typeof window !== "undefined") {
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    `https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/prod/`;
}

/**
 * Excalidraw's own light/dark: the app's explicit theme choice when there is
 * one (specs/ui.spec.md "Settings"), otherwise the system's — the same rule
 * the event model canvas follows (src/frontend/eventModel/ModelsPane.tsx).
 */
function readDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t === "dark";
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    const update = () => setDark(readDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    mql?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      mql?.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

/** The diagram already in the text that the pane was opened on, to edit. */
export interface ExcalidrawEdit {
  /** Where its SVG is served from — the url of the `![…](…)` in the source. */
  url: string;
  /** Its name, recovered from the link (src/frontend/excalidraw/diagram.ts). */
  name: string;
}

interface ExcalidrawPaneProps {
  /** The exported drawing, named `<name>.excalidraw.svg`, ready to upload. */
  onInsert: (file: File) => void;
  onCancel: () => void;
  /** Absent, the pane starts blank and draws a new diagram. */
  edit?: ExcalidrawEdit;
}

export function ExcalidrawPane({ onInsert, onCancel, edit }: ExcalidrawPaneProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [name, setName] = useState(edit?.name ?? "diagram");
  const [hasElements, setHasElements] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editing starts on the diagram in the text: until its scene is in the
  // canvas there is nothing to save, and nothing to lose by cancelling.
  const [loading, setLoading] = useState(edit !== undefined);
  // Whether anything has been drawn since — for a new diagram, anything at
  // all; for one being edited, anything after the scene it opened with. The
  // load itself reaches onChange, so it is discounted: `base` is the scene
  // version the canvas started from, taken at the first onChange (an empty
  // canvas) and again once an existing diagram has been restored into it.
  const [changed, setChanged] = useState(false);
  const base = useRef<number | null>(null);
  const dark = useDarkTheme();
  // Tab stays inside the pane. The trap's own focus restore is a no-op for a
  // component that mounts already open; the editor puts focus back itself.
  const trapRef = useFocusTrap(true);
  // The discard confirmation is the app's own dialog (src/frontend/ModalPrompts
  // .tsx), rendered inside the pane so it stacks over it.
  const { modal, confirm } = useModalPrompts();

  // Editing an existing diagram: read the SVG the link points at and restore
  // the scene Insert embedded in it. An SVG without one — a screenshot whose
  // name happens to look like an export, an export made elsewhere with the
  // scene stripped — has no drawing to edit, and says so rather than opening
  // an empty canvas that would silently replace it on Save.
  useEffect(() => {
    if (!edit || !api) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(edit.url);
        if (!res.ok) throw new Error(`could not read the diagram (${res.status})`);
        const scene = await loadFromBlob(await res.blob(), null, null);
        if (cancelled) return;
        api.updateScene({ elements: scene.elements });
        api.addFiles(Object.values(scene.files ?? {}));
        api.scrollToContent(scene.elements, { fitToContent: true });
        // The scene as it came out of the text: onChange fires for this too,
        // and everything from here on is the user's own editing.
        base.current = getSceneVersion(scene.elements);
        setChanged(false);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message || "this image has no Excalidraw drawing in it");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [edit, api]);

  const cancel = async () => {
    if (changed) {
      const ok = await confirm({
        title: edit ? "Discard changes" : "Discard diagram",
        body: edit
          ? "The diagram in the text is unchanged; the edits made here will be lost."
          : "The drawing has not been inserted and will be lost.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    onCancel();
  };

  // Excalidraw handles Escape itself on a document listener — leaving text
  // editing, dropping a selection — and React's handler here runs first, so
  // only an Escape from the pane's own controls closes it; one from inside
  // the canvas is Excalidraw's.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    if ((e.target as HTMLElement).closest(".excalidraw")) return;
    e.stopPropagation();
    e.preventDefault();
    void cancel();
  };

  // Insert, or Save when editing: the same export either way — the editor
  // decides whether the file lands at the caret or over the diagram it came
  // from (src/frontend/MarkdownEditor.tsx).
  const insert = async () => {
    if (!api) return;
    setExporting(true);
    setError(null);
    try {
      // A white background whatever the theme: Excalidraw's dark mode is a
      // canvas filter over light-mode colours, so a transparent export would
      // vanish on a dark page, and the preview shows one image in both.
      const svg = await exportToSvg({
        elements: api.getSceneElements(),
        appState: {
          ...api.getAppState(),
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          exportWithDarkMode: false,
          exportEmbedScene: true,
        },
        files: api.getFiles(),
        exportPadding: 16,
      });
      onInsert(svgFile(new XMLSerializer().serializeToString(svg), name));
    } catch (e) {
      setError((e as Error).message || "export failed");
      setExporting(false);
    }
  };

  // The one way out with a drawing: a new diagram is inserted at the caret,
  // an edited one saved over the image it was opened from.
  const commitLabel = edit
    ? exporting
      ? "Saving…"
      : "Save"
    : exporting
      ? "Inserting…"
      : "Insert";

  return (
    <div className="dialog-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={trapRef}
        className="dialog excalidraw-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={edit ? "Edit Excalidraw diagram" : "Excalidraw diagram"}
      >
        <div className="excalidraw-header">
          <h3>Excalidraw</h3>
          <label className="excalidraw-name">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="diagram"
              spellCheck={false}
            />
          </label>
          {loading && <span className="excalidraw-status">Opening diagram…</span>}
          {error && <span className="excalidraw-error">{error}</span>}
          <div className="dialog-actions excalidraw-actions">
            <button type="button" className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!api || !hasElements || exporting || loading}
              onClick={() => void insert()}
            >
              {commitLabel}
            </button>
          </div>
          <button
            type="button"
            className="excalidraw-close"
            aria-label="Close"
            onClick={() => void cancel()}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="excalidraw-body">
          <Excalidraw
            excalidrawAPI={setApi}
            theme={dark ? "dark" : "light"}
            initialData={{ appState: { viewBackgroundColor: "#ffffff" } }}
            onChange={(elements) => {
              setHasElements(elements.some((el) => !el.isDeleted));
              // Against the scene the pane opened with — the empty canvas,
              // for a new diagram — so Cancel only asks about work that
              // would be lost. While an existing diagram is still being read
              // there is nothing to lose either way.
              const version = getSceneVersion(elements);
              if (base.current === null) base.current = version;
              setChanged(version !== base.current);
            }}
            UIOptions={{
              // The pane has one way out — Insert — so the file actions that
              // would bypass it are off; the image tool too, so the export is
              // self-contained vector art with no rasters to carry.
              canvasActions: {
                changeViewBackgroundColor: false,
                clearCanvas: true,
                export: false,
                loadScene: false,
                saveToActiveFile: false,
                saveAsImage: false,
                toggleTheme: false,
              },
              tools: { image: false },
            }}
          />
        </div>
        {modal}
      </div>
    </div>
  );
}
