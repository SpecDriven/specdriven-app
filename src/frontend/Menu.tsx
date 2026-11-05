import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Keys } from "./shortcuts";

/**
 * The one drop-down menu (specs/ui/ui.feature.md "Design system"): behind
 * the feature entry's ⋯, the recent folders list and the user corner, and
 * later the property chips. It owns what every menu needs — first item
 * focused on open, ↑/↓ with wrap, Home/End, type-ahead, Enter/Space to
 * choose, a top-level item's single-key `keys` (say "1") to choose it
 * directly, ESC or a click outside to close, focus back where it came from —
 * with `role="menu"` / `menuitem` / `menuitemradio` semantics. Positioning
 * is the caller's (`className`): the menu renders inside its trigger's
 * container, and that container is what counts as "inside" for clicks.
 */
export interface MenuItem {
  id: string;
  label: ReactNode;
  /** A second, quieter line under the label. */
  description?: ReactNode;
  icon?: ReactNode;
  /** Shortcut spec, shown as keycaps on the right. */
  keys?: string;
  danger?: boolean;
  /** Set (true or false) for a radio-style item; the checked one shows ✓. */
  checked?: boolean;
  title?: string;
  disabled?: boolean;
  onSelect?: () => void;
  /** A submenu, unfolded inline under the item. */
  items?: MenuItem[];
  /**
   * With `items`: a labelled section laid out inline — the label over its
   * items, a rule between sections — rather than a submenu. For a long menu
   * of unlike things (the user menu's account, project and app rows).
   */
  inline?: boolean;
}

export function Menu({
  open,
  onClose,
  label,
  heading,
  items,
  className,
  containerSelector,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  /** A visible title over the items; `label` stays the accessible name. */
  heading?: string;
  items: MenuItem[];
  className?: string;
  /** Clicks inside an ancestor matching this stay "inside" (the trigger). */
  containerSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const focusables = () =>
    ref.current
      ? [...ref.current.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")]
      : [];

  useEffect(() => {
    if (!open) {
      setExpanded(null);
      return;
    }
    opener.current = document.activeElement;
    focusables()[0]?.focus();
    const onDown = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (ref.current?.contains(t)) return;
      if (containerSelector && t.closest(containerSelector)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      const back = opener.current;
      const active = document.activeElement;
      // Give focus back to the trigger unless the user has moved on.
      if (
        back instanceof HTMLElement &&
        back.isConnected &&
        (active === null || active === document.body || ref.current?.contains(active))
      ) {
        back.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const move = (from: HTMLElement | null, delta: number) => {
    const list = focusables();
    if (list.length === 0) return;
    const i = from ? list.indexOf(from as HTMLButtonElement) : -1;
    const next = i === -1 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    list[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(t, 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(t, -1);
        return;
      case "Home":
        e.preventDefault();
        focusables()[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        focusables().at(-1)?.focus();
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      case "ArrowRight": {
        const id = t?.dataset.submenu;
        if (id) {
          e.preventDefault();
          setExpanded(id);
          queueMicrotask(() => {
            const first = ref.current?.querySelector<HTMLButtonElement>(
              `[data-parent="${id}"] [role^=menuitem]`,
            );
            first?.focus();
          });
        }
        return;
      }
      case "ArrowLeft": {
        const parent = t?.closest<HTMLElement>("[data-parent]")?.dataset.parent;
        if (parent) {
          e.preventDefault();
          setExpanded(null);
          ref.current?.querySelector<HTMLButtonElement>(`[data-submenu="${parent}"]`)?.focus();
        }
        return;
      }
      default: {
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
        // An item's own one-key shortcut chooses it outright.
        const direct = items.find((i) => i.keys === e.key && !i.disabled && i.items === undefined);
        if (direct) {
          e.preventDefault();
          onClose();
          direct.onSelect?.();
          return;
        }
        // Type-ahead: jump to the next item starting with the letter.
        const list = focusables();
        const from = t ? list.indexOf(t as HTMLButtonElement) : -1;
        const letter = e.key.toLowerCase();
        for (let step = 1; step <= list.length; step++) {
          const el = list[(from + step) % list.length]!;
          if ((el.textContent ?? "").trim().toLowerCase().startsWith(letter)) {
            e.preventDefault();
            el.focus();
            return;
          }
        }
      }
    }
  };

  const renderItem = (item: MenuItem) => {
    if (item.items !== undefined && item.inline) {
      return (
        <div key={item.id} className="menu-section" role="group" aria-label={String(item.label)}>
          <div className="menu-section-label" aria-hidden="true">
            {item.label}
          </div>
          {item.items.map(renderItem)}
        </div>
      );
    }
    const radio = item.checked !== undefined;
    const sub = item.items !== undefined;
    const isOpen = sub && expanded === item.id;
    return (
      <div key={item.id} className="menu-entry">
        <button
          type="button"
          role={radio ? "menuitemradio" : "menuitem"}
          aria-checked={radio ? item.checked : undefined}
          aria-haspopup={sub ? "menu" : undefined}
          aria-expanded={sub ? isOpen : undefined}
          data-submenu={sub ? item.id : undefined}
          tabIndex={-1}
          disabled={item.disabled}
          title={item.title}
          className={`menu-item${item.danger ? " danger" : ""}${item.checked ? " checked" : ""}`}
          onClick={() => {
            if (sub) {
              setExpanded((cur) => (cur === item.id ? null : item.id));
              return;
            }
            onClose();
            item.onSelect?.();
          }}
        >
          {radio && (
            <span className="menu-check" aria-hidden="true">
              {item.checked && <Check size={12} />}
            </span>
          )}
          {item.icon && (
            <span className="menu-icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          {item.description !== undefined ? (
            <span className="menu-text">
              <span className="menu-label">{item.label}</span>
              <span className="menu-desc">{item.description}</span>
            </span>
          ) : (
            <span className="menu-label">{item.label}</span>
          )}
          {item.keys && <Keys spec={item.keys} />}
          {sub &&
            (isOpen ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            ))}
        </button>
        {isOpen && (
          <div role="menu" className="menu-submenu" data-parent={item.id} aria-label={String(item.label)}>
            {item.items!.map(renderItem)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`menu${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
    >
      {heading && (
        <div className="menu-heading" aria-hidden="true">
          {heading}
        </div>
      )}
      {items.map(renderItem)}
    </div>
  );
}
