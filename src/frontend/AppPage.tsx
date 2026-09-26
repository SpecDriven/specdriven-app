// The app's own pages — Settings and Plugins (specs/user-info-settings.
// feature.md "open Settings", "open Plugins") — take the whole editor pane
// rather than a dialog: a header with the page's name and the way out, a
// list of the page's sections on the left that scrolls to one and follows
// the scroll, and the sections themselves in one readable column. Each
// section is a titled group of label-left, control-right rows.

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { Tooltip } from "./Tooltip";

export interface PageSectionRef {
  id: string;
  title: string;
}

export function AppPageLayout({
  title,
  sections,
  tabs,
  actions,
  aside,
  className,
  onClose,
  children,
}: {
  title: string;
  /** Extra classes on the page — `wide` gives the content column more room. */
  className?: string;
  /** The sections in page order, for the nav; hidden ones left out. */
  sections: PageSectionRef[];
  /**
   * Show one section at a time: the nav becomes a tab list selecting
   * `active` rather than scrolling to it, and the page renders only that
   * section's content.
   */
  tabs?: { active: string; onSelect(id: string): void };
  /** Extra header controls, left of the ✕. */
  actions?: ReactNode;
  /** Under the section nav — a link to the other app page, say. */
  aside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null);

  // Scroll-spy: the section whose heading last passed the top of the
  // scrolling body is the current one; at the bottom, the last one is,
  // however short it is.
  const ids = sections.map((s) => s.id).join(" ");
  const spy = useCallback(() => {
    const body = bodyRef.current;
    if (!body || tabs) return;
    const list = ids ? ids.split(" ") : [];
    // Only a body that scrolls has a bottom to reach — one still loading its
    // content would otherwise start on the last section.
    const scrolls = body.scrollHeight > body.clientHeight + 2;
    if (scrolls && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
      setActive(list[list.length - 1] ?? null);
      return;
    }
    const top = body.getBoundingClientRect().top;
    let current = list[0] ?? null;
    for (const id of list) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top - top <= 32) current = id;
    }
    setActive(current);
  }, [ids, tabs]);
  useEffect(spy, [spy]);

  // A new tab starts at its top, not where the last one was scrolled to.
  const activeTab = tabs?.active;
  useEffect(() => {
    if (activeTab !== undefined) bodyRef.current?.scrollTo?.({ top: 0 });
  }, [activeTab]);
  const current = tabs ? tabs.active : active;

  /** Arrow keys move between tabs, the way a tab list is expected to. */
  const tabKey = (e: KeyboardEvent, index: number) => {
    if (!tabs) return;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = sections[(index + step + sections.length) % sections.length];
    if (!next) return;
    tabs.onSelect(next.id);
    document.getElementById(`${next.id}-tab`)?.focus();
  };

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActive(id);
  };

  return (
    <div className={`app-page${className ? ` ${className}` : ""}`} role="region" aria-label={title}>
      <header className="editor-bar page-header">
        <Breadcrumbs items={[]} tail={<h1 className="crumb current plain app-page-title">{title}</h1>} />
        <div className="editor-actions page-actions">
          {actions}
          <Tooltip label="Close" keys="esc">
            <button type="button" className="ibtn" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
              <X size={15} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="app-page-body" ref={bodyRef} onScroll={spy}>
        <div className="app-page-columns">
          <nav className="app-page-nav" aria-label={`${title} sections`}>
            {tabs ? (
              <div role="tablist" aria-label={title} aria-orientation="vertical" className="app-page-tabs">
                {sections.map((s, i) => (
                  <button
                    key={s.id}
                    id={`${s.id}-tab`}
                    type="button"
                    role="tab"
                    aria-selected={current === s.id}
                    aria-controls={s.id}
                    tabIndex={current === s.id ? 0 : -1}
                    className={`app-page-nav-item${current === s.id ? " active" : ""}`}
                    onClick={() => tabs.onSelect(s.id)}
                    onKeyDown={(e) => tabKey(e, i)}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            ) : (
              sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`app-page-nav-item${current === s.id ? " active" : ""}`}
                  aria-current={current === s.id ? "true" : undefined}
                  onClick={() => jump(s.id)}
                >
                  {s.title}
                </button>
              ))
            )}
            {aside && <div className="app-page-nav-aside">{aside}</div>}
          </nav>
          <div className="app-page-content">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** One titled group of rows on an app page. */
export function PageSection({
  id,
  title,
  hint,
  className,
  panel,
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  className?: string;
  /** The section is the tab panel of an AppPageLayout with `tabs`. */
  panel?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="page-section"
      role={panel ? "tabpanel" : undefined}
      aria-labelledby={panel ? `${id}-tab` : `${id}-title`}
    >
      <div className="page-section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {hint && <p className="page-section-hint">{hint}</p>}
      </div>
      <div className={`settings-group${className ? ` ${className}` : ""}`}>{children}</div>
    </section>
  );
}
