import { useRef, type RefObject } from "react";

// The grab strip on an editor's lower boundary (specs/editor/feature-editor.
// feature.md "Edit feature descrition", specs/editor/spec-editor.feature.md
// "Spec body resize"): drag it to give the editor more or less room,
// double-click to restore the CSS default, arrow keys nudge it when focused.
// The height lives with the caller — null means the CSS default stands — and
// every new height runs through the caller's clamp.

const NUDGE = 16;

export function HeightResizer({
  label,
  min,
  height,
  target,
  clamp,
  onHeight,
  onCommit,
  onReset,
  onResizing,
}: {
  label: string;
  min: number;
  height: number | null;
  /** The box being resized: a first drag starts from its rendered height. */
  target: RefObject<HTMLElement | null>;
  clamp: (h: number, windowHeight: number) => number;
  /** Every step of a drag or nudge. */
  onHeight: (h: number) => void;
  /** Where a drag or nudge ends up — the height to remember. */
  onCommit: (h: number) => void;
  /** Double-click: back to the CSS default. */
  onReset: () => void;
  onResizing: (resizing: boolean) => void;
}) {
  /** Set while the strip is being dragged; holds the drag's starting point. */
  const drag = useRef<{ y: number; height: number } | null>(null);
  const dragged = (clientY: number, start: { y: number; height: number }) =>
    clamp(start.height + (clientY - start.y), window.innerHeight);

  return (
    <div
      className="height-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={min}
      aria-valuenow={height ?? undefined}
      tabIndex={0}
      onPointerDown={(e) => {
        const box = target.current;
        if (!box) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // From wherever the box stands now, so the first drag off the CSS
        // default doesn't jump.
        drag.current = { y: e.clientY, height: box.getBoundingClientRect().height };
        onResizing(true);
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start) onHeight(dragged(e.clientY, start));
      }}
      onPointerUp={(e) => {
        const start = drag.current;
        if (!start) return;
        drag.current = null;
        onResizing(false);
        onCommit(dragged(e.clientY, start));
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        onResizing(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowDown" ? NUDGE : e.key === "ArrowUp" ? -NUDGE : 0;
        if (delta === 0) return;
        e.preventDefault();
        const from = height ?? target.current?.getBoundingClientRect().height;
        if (from === undefined) return;
        const h = clamp(from + delta, window.innerHeight);
        onHeight(h);
        onCommit(h);
      }}
    />
  );
}
