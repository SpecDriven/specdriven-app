import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { PencilRuler } from "lucide-react";
import { isDiagram } from "./excalidraw/diagram";

// Image sizing (specs/images.spec.md). A pasted screenshot lands at its pixel
// size — on a HiDPI display twice as big as it looked on screen — so in an
// editable Preview every image carries a handle at its bottom-right corner.
// Dragging it sets the width, written into the markdown as
// `<img … width="…">` (src/frontend/markdown.tsx setImageWidth) so every
// other view of the text shows the same size; a double-click on the handle
// puts the natural size back. To the keyboard the handle is a slider: the
// arrow keys nudge the width, Shift-arrows in bigger steps, Home and End go
// to the narrowest and the pane's width, Backspace or Delete restores the
// natural size. Outside an editable preview an image is just an image.

/** How an editable preview takes a new width for its nth image. */
export interface ImageSizing {
  /** `width` in pixels, or null for the natural size. */
  resize(index: number, width: number | null): void;
  /**
   * Reopen the nth image in Excalidraw (specs/editor/excalidraw-support
   * .feature.md "Edit Excalidraw diagram"). Absent when Excalidraw support is
   * off, so no diagram shows the control; only diagrams ever show it.
   */
  editDiagram?(index: number): void;
}

/** Put around an editable preview by the editor; absent, images are plain. */
export const ImageSizingContext = createContext<ImageSizing | null>(null);

/** Narrower than this and a screenshot is a smudge; also the keyboard's floor. */
export const MIN_IMAGE_WIDTH = 32;
/** Pixels an arrow key moves the width; Shift makes it five times that. */
export const IMAGE_WIDTH_STEP = 10;

/** Whole pixels, no narrower than the floor and no wider than `max`. */
export function clampWidth(width: number, max: number): number {
  return Math.round(Math.min(Math.max(width, MIN_IMAGE_WIDTH), Math.max(max, MIN_IMAGE_WIDTH)));
}

/**
 * The width a key on the handle asks for: pixels to size to, null for the
 * natural size, undefined for a key that is not the handle's to handle.
 */
export function widthAfterKey(
  key: string,
  shiftKey: boolean,
  current: number,
  max: number,
): number | null | undefined {
  const step = shiftKey ? IMAGE_WIDTH_STEP * 5 : IMAGE_WIDTH_STEP;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampWidth(current + step, max);
    case "ArrowLeft":
    case "ArrowDown":
      return clampWidth(current - step, max);
    case "Home":
      return MIN_IMAGE_WIDTH;
    case "End":
      return clampWidth(max, max);
    case "Backspace":
    case "Delete":
      return null;
    default:
      return undefined;
  }
}

/** The room an image has to grow: its pane's content width, else its own. */
function roomFor(img: HTMLImageElement): number {
  const pane = img.closest(".md-preview");
  if (pane instanceof HTMLElement) {
    const cs = getComputedStyle(pane);
    const room = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (room > 0) return Math.round(room);
  }
  return Math.round(Math.max(img.naturalWidth, img.getBoundingClientRect().width));
}

interface MarkdownImageProps {
  /** Which image of the text this is, in the order the preview renders them. */
  index: number;
  src: string;
  alt: string;
  width?: string;
  height?: string;
}

/** An image in rendered markdown; in an editable preview, with its resize handle. */
export function MarkdownImage(props: MarkdownImageProps) {
  const sizing = useContext(ImageSizingContext);
  if (!sizing) return <img src={props.src} alt={props.alt} width={props.width} height={props.height} />;
  return <ResizableImage {...props} sizing={sizing} />;
}

function ResizableImage({
  index,
  src,
  alt,
  width,
  height,
  sizing,
}: MarkdownImageProps & { sizing: ImageSizing }) {
  const img = useRef<HTMLImageElement>(null);
  // The width mid-drag, shown live on the image; committed on release.
  const [drag, setDrag] = useState<number | null>(null);
  // The width on screen and the room it has, once someone looks at the
  // image (hover or focus) — what the badge and the slider semantics show.
  const [measured, setMeasured] = useState<{ width: number; max: number } | null>(null);

  const measure = () => {
    const el = img.current;
    if (!el) return;
    const next = { width: Math.round(el.getBoundingClientRect().width), max: roomFor(el) };
    setMeasured((prev) => (prev && prev.width === next.width && prev.max === next.max ? prev : next));
  };
  // A resize lands as new source, so re-measure after each commit — but
  // not mid-drag, when the live width is already on the image.
  useLayoutEffect(() => {
    if (measured && drag === null) measure();
  });

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    const el = img.current;
    if (e.button !== 0 || !el) return;
    e.preventDefault(); // no text selection, no image drag
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = el.getBoundingClientRect().width;
    const max = roomFor(el);
    let last = Math.round(startWidth);
    setDrag(last);
    const move = (ev: globalThis.PointerEvent) => {
      last = clampWidth(startWidth + ev.clientX - startX, max);
      setDrag(last);
    };
    const finish = (ev: globalThis.PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      setDrag(null);
      if (ev.type === "pointerup" && last !== Math.round(startWidth)) sizing.resize(index, last);
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const el = img.current;
    if (!el) return;
    const current = Math.round(el.getBoundingClientRect().width);
    const next = widthAfterKey(e.key, e.shiftKey, current, roomFor(el));
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== current) sizing.resize(index, next);
  };

  const shown = drag ?? measured?.width;
  // An Excalidraw diagram in an editable preview also carries a button that
  // reopens it in the pane (specs/editor/excalidraw-support.feature.md "Edit
  // Excalidraw diagram"), shown alongside the width badge on the same hover.
  const editDiagram = sizing.editDiagram && isDiagram(alt, src) ? sizing.editDiagram : null;
  return (
    <span className={`md-img${drag !== null ? " resizing" : ""}`} onPointerEnter={measure}>
      <img
        ref={img}
        src={src}
        alt={alt}
        width={width}
        height={height}
        style={drag === null ? undefined : { width: drag, height: "auto" }}
        onLoad={measure}
      />
      <span
        role="slider"
        tabIndex={0}
        className="md-img-handle"
        aria-label={alt ? `Width of image "${alt}"` : "Image width"}
        aria-orientation="horizontal"
        aria-valuemin={MIN_IMAGE_WIDTH}
        aria-valuemax={measured?.max}
        aria-valuenow={shown}
        aria-valuetext={shown === undefined ? undefined : `${shown} px`}
        title="Drag to size the image; double-click for its natural size"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => sizing.resize(index, null)}
        onFocus={measure}
      />
      {editDiagram && (
        <button
          type="button"
          className="md-img-edit"
          aria-label={alt ? `Edit diagram "${alt}"` : "Edit diagram"}
          title="Edit this diagram in Excalidraw"
          onClick={() => editDiagram(index)}
        >
          <PencilRuler size={13} aria-hidden="true" />
        </button>
      )}
      {shown !== undefined && (
        <span className="md-img-size" aria-hidden="true">
          {shown} px
        </span>
      )}
    </span>
  );
}
