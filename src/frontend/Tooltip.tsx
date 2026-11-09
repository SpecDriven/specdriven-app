import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Tooltip for icon buttons (specs/ui/ui.feature.md "Design system"): a
 * label, optionally with the keyboard shortcut, shown 350 ms after the
 * pointer settles on the control or as soon as it takes keyboard focus.
 * Rendered in a portal under `body` so it escapes clipped panes, positioned
 * under the control (above it when there is no room below), and kept inside
 * the window when the control sits near its edge. The control
 * gets `aria-describedby`, so the label reaches assistive tech even while
 * the tooltip is hidden; pass an `aria-label` on the control as well when
 * the icon is its only content.
 */
export function Tooltip({
  label,
  keys,
  children,
}: {
  label: ReactNode;
  /** Shortcut hint, e.g. "⌘K" — rendered as a keycap after the label. */
  keys?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  /** How far the tooltip moves off the control's centre to stay on screen. */
  const [nudge, setNudge] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  useEffect(() => () => hide(), []);

  useEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const above = r.bottom + 40 > window.innerHeight;
    setPos({ top: above ? r.top - 6 : r.bottom + 6, left: r.left + r.width / 2, above });
    const onScroll = () => hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onScroll);
    };
  }, [open]);

  // A control by the window's edge (the pane's last button) would push a
  // centred tooltip off screen: move it in, keeping a small margin.
  useLayoutEffect(() => {
    if (!open || !pos || !tip.current) return;
    const half = tip.current.offsetWidth / 2;
    const margin = 8;
    const min = margin + half;
    const max = Math.max(min, window.innerWidth - margin - half);
    setNudge(Math.min(Math.max(pos.left, min), max) - pos.left);
  }, [open, pos]);

  const child = children;
  const props = child.props;
  const control = cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
      const inner = (child as { ref?: unknown }).ref;
      if (typeof inner === "function") inner(el);
      else if (inner && typeof inner === "object") (inner as { current: unknown }).current = el;
    },
    "aria-describedby": open ? id : undefined,
    onMouseEnter: (e: unknown) => {
      show(350);
      (props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: unknown) => {
      hide();
      (props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
    },
    onFocus: (e: unknown) => {
      show(0);
      (props.onFocus as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: unknown) => {
      hide();
      (props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseDown: (e: unknown) => {
      hide();
      (props.onMouseDown as ((e: unknown) => void) | undefined)?.(e);
    },
  });

  return (
    <>
      {control}
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            ref={tip}
            role="tooltip"
            className={`tooltip${pos.above ? " above" : ""}`}
            style={{ top: pos.top, left: pos.left + nudge }}
          >
            {label}
            {keys && <kbd>{keys}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
