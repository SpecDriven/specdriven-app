import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
// The package's exports map offers its stylesheet only under the bundler
// conditions "development" and "production", neither of which Bun's HTML
// bundler applies, so the production sheet is reached by path.
import "../../../node_modules/@excalidraw/excalidraw/dist/prod/index.css";
import { Excalidraw, exportToSvg } from "@excalidraw/excalidraw";
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

interface ExcalidrawPaneProps {
  /** The exported drawing, named `<name>.excalidraw.svg`, ready to upload. */
  onInsert: (file: File) => void;
  onCancel: () => void;
}

export function ExcalidrawPane({ onInsert, onCancel }: ExcalidrawPaneProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [name, setName] = useState("diagram");
  const [hasElements, setHasElements] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = useDarkTheme();
  // Tab stays inside the pane. The trap's own focus restore is a no-op for a
  // component that mounts already open; the editor puts focus back itself.
  const trapRef = useFocusTrap(true);
  // The discard confirmation is the app's own dialog (src/frontend/ModalPrompts
  // .tsx), rendered inside the pane so it stacks over it.
  const { modal, confirm } = useModalPrompts();

  const cancel = async () => {
    if (hasElements) {
      const ok = await confirm({
        title: "Discard diagram",
        body: "The drawing has not been inserted and will be lost.",
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

  return (
    <div className="dialog-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={trapRef}
        className="dialog excalidraw-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Excalidraw diagram"
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
          {error && <span className="excalidraw-error">{error}</span>}
          <div className="dialog-actions excalidraw-actions">
            <button type="button" className="secondary" onClick={() => void cancel()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!api || !hasElements || exporting}
              onClick={() => void insert()}
            >
              {exporting ? "Inserting…" : "Insert"}
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
            onChange={(elements) => setHasElements(elements.some((el) => !el.isDeleted))}
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
