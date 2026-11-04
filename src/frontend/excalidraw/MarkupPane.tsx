import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToCanvas,
  getCommonBounds,
  getDataURL,
  getSceneVersion,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { useFocusTrap } from "../useFocusTrap";
import { useModalPrompts } from "../ModalPrompts";
// Through the diagram pane, so the library's stylesheet and font path are
// set up once, by the one module that does it.
import { useDarkTheme } from "./ExcalidrawPane";
import { MAX_MARKUP_BYTES, markupFileName, readMarkup, shiftElements, withMarkup } from "./markup";

// The markup pane (specs/image-editor-markup.feature.md): an image already in
// the text opened in Excalidraw as a locked background, for boxes and arrows
// drawn over it with Excalidraw's own tools — and undone with its own undo.
// Save burns the shapes into a PNG the image's own size and hands it to the
// editor, which uploads it and points the image at it (src/frontend/
// MarkdownEditor.tsx), so every view of the text shows the markup.
//
// The PNG also carries the shapes and the clean original's url
// (src/frontend/excalidraw/markup.ts), so marking it up again starts from
// the original with the shapes still shapes — movable, deletable — rather
// than drawing over a copy with the old ones burnt in.

/** Shapes that read as markup on a screenshot: red, bold, unfilled, crisp. */
const MARKUP_STYLE = {
  currentItemStrokeColor: "#e03131",
  currentItemBackgroundColor: "transparent",
  currentItemStrokeWidth: 4,
  currentItemRoughness: 0,
  currentItemRoundness: "sharp",
  currentItemArrowType: "sharp",
  currentItemEndArrowhead: "arrow",
  currentItemStartArrowhead: null,
  // An arrow points at something in the picture, not at the picture's edge
  // or a box: off, its ends stay where they were dropped.
  isBindingEnabled: false,
  // Not white, so the image's own edges — where Save crops — show.
  viewBackgroundColor: "#e9ecef",
} as const;

/** What Save hands back: a new file to upload, or the original to point at again. */
export type MarkupResult = { file: File } | { url: string };

interface MarkupPaneProps {
  /** The image's url in the text — the original, or an earlier markup of it. */
  src: string;
  alt: string;
  onSave: (result: MarkupResult) => void;
  onCancel: () => void;
}

/** The image the shapes are drawn on, once it is on the canvas. */
interface Background {
  /** The clean original's url, which the saved markup names. */
  source: string;
  fileId: FileId;
  /** Decoded at its natural size, for Save to draw untouched under the shapes. */
  image: HTMLImageElement;
}

async function fetchImage(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read the image (${res.status})`);
  return res.blob();
}

/** The image decoded, at its natural size — an SVG with none takes the browser's default. */
function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read the image"));
    };
    img.src = url;
  });
}

/**
 * Scene units around the shapes' bounds the exported layer keeps, room for
 * the widest stroke and an arrowhead (Excalidraw's bounds hold neither).
 */
const EXPORT_MARGIN = 32;

function size(img: HTMLImageElement): { width: number; height: number } {
  return { width: img.naturalWidth || 300, height: img.naturalHeight || 150 };
}

export function MarkupPane({ src, alt, onSave, onCancel }: MarkupPaneProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [loading, setLoading] = useState<string | null>("Opening image…");
  // Said once the image is up, when it is not quite the one asked for.
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const background = useRef<Background | null>(null);
  // Whether anything was drawn since the canvas opened on the image (and any
  // shapes saved with it): `base` is that scene's version, null until then.
  const [changed, setChanged] = useState(false);
  const base = useRef<number | null>(null);
  const dark = useDarkTheme();
  const trapRef = useFocusTrap(true);
  const { modal, confirm } = useModalPrompts();

  // Opening: the image the link points at, or — when it is a markup saved
  // here before — the original it names, with the shapes back over it. None
  // of it lands on the undo stack: undo goes back as far as the image as it
  // opened, never past it.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const shown = await fetchImage(src);
        const record =
          shown.type === "image/png" ? readMarkup(new Uint8Array(await shown.arrayBuffer())) : null;
        let blob = shown;
        let source = src;
        let shapes: readonly ExcalidrawElement[] = [];
        if (record) {
          try {
            blob = await fetchImage(record.source);
            source = record.source;
            shapes = record.elements;
          } catch {
            setNote("The original under this markup is gone; marking up the image as it is");
          }
        }
        const image = await decode(blob);
        if (cancelled) return;
        const fileId = source.split("/").pop()! as FileId;
        const file: BinaryFileData = {
          id: fileId,
          dataURL: await getDataURL(blob),
          mimeType: blob.type as BinaryFileData["mimeType"],
          created: Date.now(),
        };
        if (cancelled) return;
        api.addFiles([file]);
        const [element] = convertToExcalidrawElements([
          { type: "image", fileId, x: 0, y: 0, ...size(image), locked: true, status: "saved" },
        ]);
        const elements = [element!, ...restoreElements(shapes, null)];
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
        api.history.clear();
        api.scrollToContent(element, { fitToContent: true });
        api.setActiveTool({ type: "rectangle" });
        background.current = { source, fileId, image };
        base.current = getSceneVersion(api.getSceneElementsIncludingDeleted());
        setChanged(false);
        setLoading(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message || "could not read the image");
        setLoading(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, src]);

  const cancel = async () => {
    if (changed) {
      const ok = await confirm({
        title: "Discard markup",
        body: "The image in the text is unchanged; the markup drawn here will be lost.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    onCancel();
  };

  // Escape from the pane's own controls closes it; one from inside the
  // canvas is Excalidraw's (src/frontend/excalidraw/ExcalidrawPane.tsx).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    if ((e.target as HTMLElement).closest(".excalidraw")) return;
    e.stopPropagation();
    e.preventDefault();
    void cancel();
  };

  // Save: the original drawn untouched at its natural size, the shapes
  // exported over it at the same scale and cropped to it — a shape running
  // off the edge is cut there. No shapes left, and the image goes back to
  // the original. Too big to upload, and the pane stays open with the
  // markup still in it.
  //
  // The shapes are exported with a margin around their bounds, which are
  // geometric: a straight line is 0 tall, a pen dot 0 by 0, and an arrowhead
  // or a stroke's outer half sits outside them. Exported at exactly those
  // bounds, the layer would be an empty canvas (which drawImage refuses) or
  // one that clips the strokes.
  const save = async () => {
    const bg = background.current;
    if (!api || !bg) return;
    setSaving(true);
    setError(null);
    try {
      const elements = api.getSceneElements();
      const image = elements.find(
        (el) => el.type === "image" && el.fileId === bg.fileId,
      ) as ExcalidrawImageElement | undefined;
      if (!image) throw new Error("the image itself is no longer on the canvas");
      const shapes = elements.filter((el) => el !== image);
      if (shapes.length === 0) {
        onSave({ url: bg.source });
        return;
      }
      const { width, height } = size(bg.image);
      const scale = width / image.width;
      const layer = await exportToCanvas({
        elements: shapes,
        appState: {
          ...api.getAppState(),
          exportBackground: false,
          exportWithDarkMode: false,
        },
        files: api.getFiles(),
        exportPadding: EXPORT_MARGIN,
        getDimensions: (w: number, h: number) => ({
          width: Math.max(1, Math.ceil(w * scale)),
          height: Math.max(1, Math.ceil(h * scale)),
          scale,
        }),
      });
      // The layer's origin is the shapes' top-left corner, less the margin.
      const [minX, minY] = getCommonBounds(shapes);
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("export failed");
      ctx.drawImage(bg.image, 0, 0, width, height);
      ctx.drawImage(
        layer,
        (minX - EXPORT_MARGIN - image.x) * scale,
        (minY - EXPORT_MARGIN - image.y) * scale,
      );
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("export failed");
      const png = withMarkup(new Uint8Array(await blob.arrayBuffer()), {
        version: 1,
        source: bg.source,
        elements: shiftElements(shapes, -image.x, -image.y),
      });
      if (png.byteLength > MAX_MARKUP_BYTES) {
        const mb = (png.byteLength / 1024 / 1024).toFixed(1);
        throw new Error(`the marked-up image is ${mb} MB, over the 10 MB an upload may be`);
      }
      onSave({ file: new File([png], markupFileName(bg.source), { type: "image/png" }) });
    } catch (e) {
      setError((e as Error).message || "export failed");
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={trapRef}
        className="dialog excalidraw-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={alt ? `Mark up image "${alt}"` : "Mark up image"}
      >
        <div className="excalidraw-header">
          <h3>Mark up</h3>
          <span className="markup-alt" title={alt}>
            {alt || "image"}
          </span>
          {loading && <span className="excalidraw-status">{loading}</span>}
          {note && <span className="excalidraw-status">{note}</span>}
          {error && <span className="excalidraw-error">{error}</span>}
          <div className="dialog-actions excalidraw-actions">
            <button type="button" className="btn btn-secondary" onClick={() => void cancel()}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!api || loading !== null || !changed || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
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
            autoFocus
            theme={dark ? "dark" : "light"}
            initialData={{ appState: MARKUP_STYLE }}
            onChange={(elements) => {
              // Nothing counts until the image is on the canvas.
              if (base.current === null) return;
              setChanged(getSceneVersion(elements) !== base.current);
            }}
            UIOptions={{
              // Save is the one way out, so the file actions are off — and
              // Clear canvas, which would take the image with it.
              canvasActions: {
                changeViewBackgroundColor: false,
                clearCanvas: false,
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
