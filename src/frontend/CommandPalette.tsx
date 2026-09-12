import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Keys } from "./shortcuts";
import { useFocusTrap } from "./useFocusTrap";

/**
 * The command palette on ⌘K (specs/ui/ui.feature.md "Design system",
 * specs/search.feature.md): one field that finds features and scenarios —
 * or, opened from one of the sidebar's page tabs, that folder's pages — with
 * the full-text search's ranking and snippets, and runs the app's actions by
 * name. Empty, it offers what was opened recently and every action; typing
 * narrows all groups at once. ↑/↓ move, ⏎ opens, ⌘⏎ opens a scenario on its
 * feature page instead of in the editor, ESC closes. A combobox for
 * assistive tech: the field owns the list and names the active option.
 */
export type PaletteGroup =
  | "Recent"
  | "Actions"
  | "Features"
  | "Scenarios"
  | "Roadmap"
  | "Tasks"
  | "Notebook"
  | "Tests"
  | "Issues"
  | "Models";

/** What the query searches, after the sidebar tab the palette opened from. */
export type PaletteScope =
  | "specs"
  | "roadmap"
  | "tasks"
  | "notebook"
  | "tests"
  | "issues"
  | "models";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: ReactNode;
  /** Plain text of the label, for filtering actions by name. */
  text: string;
  sub?: ReactNode;
  icon?: ReactNode;
  keys?: string;
  href?: string;
  run: (opts: { alt: boolean }) => void;
}

const GROUP_ORDER: PaletteGroup[] = [
  "Recent",
  "Actions",
  "Features",
  "Scenarios",
  "Roadmap",
  "Tasks",
  "Notebook",
  "Tests",
  "Issues",
  "Models",
];

export function CommandPalette({
  initialQuery,
  scope = "specs",
  onClose,
  actions,
  recent,
  resolve,
}: {
  initialQuery: string;
  /** Specs, roadmap pages or tasks — names the field and the results' scope. */
  scope?: PaletteScope;
  onClose: () => void;
  /** Every action, filtered here by name. */
  actions: PaletteItem[];
  /** What to show before typing. */
  recent: PaletteItem[];
  /** Features and scenarios — or roadmap pages — matching a query. */
  resolve: (query: string, signal: AbortSignal) => Promise<PaletteItem[]>;
}) {
  const trapRef = useFocusTrap(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [found, setFound] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Search as the user types, debounced; a stale response never overwrites
  // a newer query's results.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        setFound(await resolve(q, controller.signal));
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError((e as Error).message || "Search failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: PaletteItem[] = q
      ? [...actions.filter((a) => a.text.toLowerCase().includes(q)), ...found]
      : [...recent, ...actions];
    return list.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [query, actions, recent, found]);

  useEffect(() => setActive(0), [query, found.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem | undefined, alt: boolean) => {
    if (!item) return;
    onClose();
    item.run({ alt });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home" && items.length > 0 && !query) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active], e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let lastGroup: PaletteGroup | null = null;
  const rows: ReactNode[] = [];
  items.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      rows.push(
        <div key={`g:${item.group}`} className="palette-group" role="presentation">
          {item.group}
        </div>,
      );
    }
    const row = (
      <>
        {item.icon && (
          <span className="palette-icon" aria-hidden="true">
            {item.icon}
          </span>
        )}
        <span className="palette-label">{item.label}</span>
        {item.sub && <span className="palette-sub">{item.sub}</span>}
        {item.keys && <Keys spec={item.keys} />}
      </>
    );
    const props = {
      id: `palette-opt-${i}`,
      role: "option" as const,
      "aria-selected": i === active,
      "data-index": i,
      className: `palette-item${i === active ? " active" : ""}`,
      onMouseEnter: () => setActive(i),
    };
    rows.push(
      item.href ? (
        <a
          key={item.id}
          {...props}
          href={item.href}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            choose(item, false);
          }}
        >
          {row}
        </a>
      ) : (
        <button key={item.id} type="button" {...props} onClick={() => choose(item, false)}>
          {row}
        </button>
      ),
    );
  });

  return (
    <div className="dialog-backdrop palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items.length ? `palette-opt-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={`Search ${scope} or type a command`}
            placeholder={`Search ${scope} or type a command…`}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div id="palette-list" className="palette-list" role="listbox" ref={listRef}>
          {error && <p className="error">{error}</p>}
          {rows}
          {loading && found.length === 0 && (
            <div className="palette-loading" aria-busy="true" aria-label="Searching">
              {[60, 45, 70].map((w, i) => (
                <span key={i} className="skeleton" style={{ height: "1rem", width: `${w}%` }} />
              ))}
            </div>
          )}
          {query.trim() && !error && !loading && items.length === 0 && (
            <p className="empty">No matches for “{query.trim()}”</p>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Keys spec="arrowup" />
            <Keys spec="arrowdown" /> navigate
          </span>
          <span>
            <Keys spec="enter" /> open
          </span>
          {scope === "specs" && (
            <span>
              <Keys spec="mod+enter" /> show on the feature page
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
