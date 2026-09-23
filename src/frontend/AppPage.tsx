// The app's own pages — Settings and Plugins (specs/user-info-settings.
// feature.md "open Settings", "open Plugins") — take the whole editor pane
// rather than a dialog: a header with the page's name and the way out, a
// list of the page's sections on the left that scrolls to one and follows
// the scroll, and the sections themselves in one readable column. Each
// section is a titled group of label-left, control-right rows.

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { Tooltip } from "./Tooltip";

export interface PageSectionRef {
  id: string;
  title: string;
}

export function AppPageLayout({
  title,
  sections,
  actions,
  aside,
  onClose,
  children,
}: {
  title: string;
  /** The sections in page order, for the nav; hidden ones left out. */
  sections: PageSectionRef[];
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
    if (!body) return;
    const list = ids ? ids.split(" ") : [];
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
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
  }, [ids]);
  useEffect(spy, [spy]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActive(id);
  };

  return (
    <div className="app-page" role="region" aria-label={title}>
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
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`app-page-nav-item${active === s.id ? " active" : ""}`}
                aria-current={active === s.id ? "true" : undefined}
                onClick={() => jump(s.id)}
              >
                {s.title}
              </button>
            ))}
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
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="page-section" aria-labelledby={`${id}-title`}>
      <div className="page-section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {hint && <p className="page-section-hint">{hint}</p>}
      </div>
      <div className={`settings-group${className ? ` ${className}` : ""}`}>{children}</div>
    </section>
  );
}
