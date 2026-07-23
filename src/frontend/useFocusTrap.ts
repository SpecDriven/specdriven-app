import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // Hidden elements (e.g. the markdown editor's inactive tab pane) are laid
    // out at zero size, so they must not be Tab stops.
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

// Dialogs can stack — a delete confirmation above the scenario edit dialog
// (specs/ui.spec.md "Dialogs"). Only the top-most trap may handle Tab, or
// the lower one would keep yanking focus out of the foreground dialog.
const trapStack: HTMLElement[] = [];

/**
 * specs/ui.spec.md "Dialogs": while a dialog is open, Tab and Shift+Tab only
 * cycle its own fields, wrapping at both ends; focus never reaches the page
 * behind it; and closing the dialog restores focus to whatever opened it.
 *
 * Returns the ref to attach to the dialog element. Pass open=false when the
 * dialog is closed — the trap installs and tears down with it.
 */
export function useFocusTrap(open: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  // Assigned during render, so it is already true by the time the dialog's
  // autoFocus field fires focusin during commit.
  openRef.current = open;

  // Remember the last thing focused outside the dialog. Tracked continuously
  // rather than read when the dialog opens: an autoFocus field inside it claims
  // focus during commit, before any effect here could observe the opener.
  useEffect(() => {
    const onFocusIn = () => {
      if (openRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) openerRef.current = el;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;

    const opener = openerRef.current;
    trapStack.push(container);

    // Fields with autoFocus have already claimed focus by this point; only step
    // in when focus is still outside the dialog.
    if (!container.contains(document.activeElement)) {
      const first = focusable(container)[0];
      (first ?? container).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (trapStack[trapStack.length - 1] !== container) return;
      const items = focusable(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // Wrap at both ends, and pull focus back in if it escaped the dialog.
      if (!active || !container.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase so the trap wins over any field-level Tab handling.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      const i = trapStack.lastIndexOf(container);
      if (i !== -1) trapStack.splice(i, 1);
      document.removeEventListener("keydown", onKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  return ref;
}
