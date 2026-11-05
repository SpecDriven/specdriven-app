// One keyboard model for every sidebar list (specs/ui/ui.feature.md "Design
// system"): the plugin tabs' lists are `role="tree"` like the Specs tree, so
// ↑/↓/Home/End walk their rows and Shift+F10 (or the context-menu key) opens
// the focused row's ⋯ — the row says which menu through `data-menu`. And the
// open row is scrolled into view when it was opened from elsewhere — a deep
// link, the palette — as the Specs tree reveals its feature
// (specs/ui/navigation.feature.md "the tree follows the open feature").

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

export function listKeyDown(e: ReactKeyboardEvent<HTMLElement>, onMenu?: (key: string) => void): void {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const i = rows.indexOf(t);
  if (i === -1) return;
  const move = (to: number) => rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(i + 1);
      return;
    case "ArrowUp":
      e.preventDefault();
      move(i - 1);
      return;
    case "Home":
      e.preventDefault();
      move(0);
      return;
    case "End":
      e.preventDefault();
      move(rows.length - 1);
      return;
    case "F10":
    case "ContextMenu": {
      if (e.key === "F10" && !e.shiftKey) return;
      const key = t.dataset.menu;
      if (key === undefined || !onMenu) return;
      e.preventDefault();
      onMenu(key);
      return;
    }
  }
}

/**
 * Scroll the list's open row (`aria-current="page"`) into view when the open
 * thing changes and the row is not already visible; the rest of the list
 * stays where it was.
 */
export function useRevealActive(list: RefObject<HTMLElement | null>, active: string | number | null): void {
  useEffect(() => {
    if (active === null) return;
    const host = list.current;
    const row = host?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!host || !row) return;
    const box = row.getBoundingClientRect();
    const frame = host.getBoundingClientRect();
    if (box.top < frame.top || box.bottom > frame.bottom) row.scrollIntoView({ block: "nearest" });
  }, [active, list]);
}
