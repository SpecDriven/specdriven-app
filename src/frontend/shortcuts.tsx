import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./useFocusTrap";

/**
 * One keyboard model for the app (specs/ui/ui.feature.md "Design system"):
 * every shortcut is declared once, in a registry, and a single window
 * listener dispatches from it. The cheat sheet (`?`) renders the same
 * registry, so what it shows is what the keys do.
 *
 * Bindings are Linear's where they overlap: `C` creates, `?` opens the
 * shortcuts help, `G` then a key goes somewhere, `⌘K` / `/` search.
 */
export interface Shortcut {
  /** Stable id, also the React key in the cheat sheet. */
  id: string;
  /**
   * The key combo(s): "mod+k", "?", "arrowdown", "mod+shift+c", or a chord
   * "g h" (two keys in sequence). `mod` is ⌘ on macOS, Ctrl elsewhere.
   * Several combos for one action go in an array.
   */
  keys: string | string[];
  /** What the cheat sheet says it does. */
  label: string;
  /** Cheat sheet section. */
  group: string;
  /** Fire while typing in a field; single letters never should. */
  inFields?: boolean;
  /** Only while this holds — evaluated on each key press. */
  when?: () => boolean;
  /**
   * Whether the command palette offers this shortcut as a command, when that
   * differs from `when`. `when` keeps a key from firing behind a dialog, and
   * the palette is a dialog — so a command listed there must not disappear
   * the moment it opens. Defaults to `when`.
   */
  palette?: () => boolean;
  /** The action. Return false to leave the key to the browser. */
  run: (e: KeyboardEvent) => void | false;
  /** Listed in the cheat sheet but handled elsewhere (a field's own keys). */
  displayOnly?: boolean;
  /** Left out of the cheat sheet. */
  hidden?: boolean;
}

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Combo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(spec: string): Combo {
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return {
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key,
  };
}

/** Keys typed with Shift on most layouts — their own shift state is ignored. */
const SHIFTED = new Set(["?", "+", "_", "{", "}", "|", ":", '"', "<", ">", "~"]);
/** The unshifted key some layouts and synthetic events report instead. */
const BASE_OF: Record<string, string> = { "?": "/", "+": "=", "_": "-", ":": ";", "<": ",", ">": "." };

function matches(e: KeyboardEvent, c: Combo): boolean {
  const key = e.key.toLowerCase();
  if (key !== c.key && !(SHIFTED.has(c.key) && e.shiftKey && key === BASE_OF[c.key])) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (mod !== c.mod) return false;
  if (e.altKey !== c.alt) return false;
  if (!SHIFTED.has(c.key) && e.shiftKey !== c.shift) return false;
  return true;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

const keysOf = (s: Shortcut) => (Array.isArray(s.keys) ? s.keys : [s.keys]);

/**
 * Register the app's shortcuts. Called once, with the list rebuilt every
 * render so the actions close over current state; the listener reads the
 * latest list through a ref.
 */
export function useShortcuts(shortcuts: Shortcut[]) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  const pending = useRef<{ prefix: string; at: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A field that already handled the key (the search field's own ESC,
      // a rename form's) keeps it.
      if (e.defaultPrevented) return;
      const typing = isTypingTarget(e.target);
      const now = Date.now();
      const prefix =
        pending.current && now - pending.current.at < 1500 ? pending.current.prefix : null;
      pending.current = null;
      const live = ref.current.filter(
        (s) => !s.displayOnly && (!typing || s.inFields) && (!s.when || s.when()),
      );

      // Second key of a chord.
      if (prefix) {
        for (const s of live) {
          for (const k of keysOf(s)) {
            const parts = k.split(" ");
            if (parts.length === 2 && parts[0] === prefix && matches(e, parseCombo(parts[1]!))) {
              e.preventDefault();
              s.run(e);
              return;
            }
          }
        }
      }

      // Plain combos.
      for (const s of live) {
        for (const k of keysOf(s)) {
          if (k.includes(" ")) continue;
          if (matches(e, parseCombo(k))) {
            if (s.run(e) !== false) {
              e.preventDefault();
              return;
            }
          }
        }
      }

      // First key of a chord — remembered for the next press.
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        for (const s of live) {
          for (const k of keysOf(s)) {
            const parts = k.split(" ");
            if (parts.length === 2 && matches(e, parseCombo(parts[0]!))) {
              pending.current = { prefix: parts[0]!, at: now };
              e.preventDefault();
              return;
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

const KEY_LABELS: Record<string, string> = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt",
  enter: "⏎",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
  ",": ",",
};

/** The keycaps for one combo or chord, for tooltips and the cheat sheet. */
export function keyCaps(spec: string): string[] {
  return spec.split(" ").flatMap((combo, i) => {
    const caps = combo
      .toLowerCase()
      .split("+")
      .map((p) => KEY_LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p));
    return i === 0 ? caps : ["then", ...caps];
  });
}

/** Keycaps as one string, e.g. "⌘⇧C", for a tooltip's `keys` prop. */
export function keyHint(spec: string): string {
  return keyCaps(spec)
    .map((c) => (c === "then" ? " then " : c))
    .join(IS_MAC ? "" : "+")
    .replace(/\+? then \+?/g, " then ");
}

export function Keys({ spec }: { spec: string }) {
  return (
    <span className="keys">
      {keyCaps(spec).map((cap, i) =>
        cap === "then" ? (
          <span key={i} className="keys-then">
            then
          </span>
        ) : (
          <kbd key={i}>{cap}</kbd>
        ),
      )}
    </span>
  );
}

/**
 * The cheat sheet on `?`: the registry, grouped, two columns. A dialog like
 * the others — focus trapped, ESC or a click outside closes.
 */
export function ShortcutSheet({
  shortcuts,
  onClose,
}: {
  shortcuts: Shortcut[];
  onClose: () => void;
}) {
  const trapRef = useFocusTrap(true);
  const groups = new Map<string, Shortcut[]>();
  for (const s of shortcuts) {
    if (s.hidden) continue;
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div className="dialog-backdrop" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        className="dialog shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h3>Keyboard shortcuts</h3>
          <button className="settings-close" aria-label="Close" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="shortcut-groups">
          {[...groups].map(([group, list]) => (
            <section key={group} className="shortcut-group">
              <h4>{group}</h4>
              {list.map((s) => (
                <div key={s.id} className="shortcut-row">
                  <span>{s.label}</span>
                  <span className="shortcut-keys">
                    {keysOf(s).map((k, i) => (
                      <span key={k} className="shortcut-alt">
                        {i > 0 && <span className="keys-or">or</span>}
                        <Keys spec={k} />
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
