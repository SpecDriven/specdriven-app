import { ChevronRight } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

/**
 * The page header's trail (specs/ui/ui.feature.md "Design system"): data
 * folder › folder › … › the page. Every segment but the last is a link or a
 * button; the last is whatever the page makes of it — a name that renames
 * on click — passed as `tail`. Without a `tail` the trail ends on its last
 * item: the scenario editor's line stops at the feature, the way back, and
 * keeps the scenario's name for the heading above the editor
 * (specs/editor/spec-editor.feature.md "Adding Scanarios").
 */
export interface Crumb {
  label: ReactNode;
  /** A real link (right-click → copy works); `onClick` still intercepts. */
  href?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  title?: string;
}

export function Breadcrumbs({ items, tail }: { items: Crumb[]; tail?: ReactNode }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={i}>
            {c.href ? (
              <a href={c.href} className="crumb" title={c.title} onClick={c.onClick}>
                {c.label}
              </a>
            ) : c.onClick ? (
              <button type="button" className="crumb" title={c.title} onClick={c.onClick}>
                {c.label}
              </button>
            ) : (
              <span className="crumb plain">{c.label}</span>
            )}
            {(tail !== undefined || i < items.length - 1) && (
              <ChevronRight size={12} className="crumb-sep" aria-hidden="true" />
            )}
          </li>
        ))}
        {tail !== undefined && (
          <li className="crumb-tail" aria-current="page">
            {tail}
          </li>
        )}
      </ol>
    </nav>
  );
}
