import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";

/**
 * An anchored popover for a small form — the property chips' editors
 * (specs/ui/ui.feature.md "Design system"). Like Menu it lives inside its
 * trigger's container and positions through `className`; unlike Menu its
 * content is free-form, so Tab cycles inside it (the dialogs' focus trap,
 * which also puts focus on the first field and gives it back on close).
 * ESC or a click outside closes.
 */
export function Popover({
  open,
  onClose,
  label,
  className,
  containerSelector,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  containerSelector?: string;
  children: ReactNode;
}) {
  const ref = useFocusTrap(open);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (ref.current?.contains(t)) return;
      if (containerSelector && t.closest(containerSelector)) return;
      closeRef.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, containerSelector, ref]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`popover${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
