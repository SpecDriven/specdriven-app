// One row for every sidebar list (specs/app/plugins.feature.md "A tab's rows
// use the sidebar row"): the slots the Specs tree's rows laid out —
// [leading glyph] [label] [trailing meta] [⋯] — on one padding scale, with
// the selected fill and the hover on the row itself so the ⋯ sits inside
// it. A roadmap page's assignee, a task's done mark, an entry's kind, a
// plan's progress ring, an issue's number each take a slot rather than a
// shape of their own. `meta` adds a second line (the notebook's author and
// day). The row is a `treeitem` for the list's keyboard model
// (src/frontend/sidebarList.ts), its ⋯ reachable through `data-menu`.

import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Menu, type MenuItem } from "./Menu";
import { Tooltip } from "./Tooltip";

export function SidebarRow({
  href,
  active,
  level = 1,
  menuKey,
  title,
  leading,
  label,
  trailing,
  meta,
  className,
  rowProps,
  linkProps,
  onOpen,
  menu,
}: {
  href: string;
  active: boolean;
  /** The row's depth in the tree: 1 at the top, 2 under a folder. */
  level?: number;
  /** The key Shift+F10 hands the list's menu opener for this row. */
  menuKey?: string;
  title?: string;
  leading?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  /** A second, quieter line under the label. */
  meta?: ReactNode;
  className?: string;
  /** Drag-and-drop handlers and the like on the row. */
  rowProps?: HTMLAttributes<HTMLDivElement>;
  /** Drag handlers and the like on the link. */
  linkProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
  onOpen: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** The row's ⋯ menu; none on the read-only site. */
  menu?: { label: string; open: boolean; onToggle: () => void; onClose: () => void; items: MenuItem[] };
}) {
  return (
    <div
      className={`page-row${active ? " active" : ""}${meta !== undefined ? " entry-row" : ""}${
        className ? ` ${className}` : ""
      }`}
      {...rowProps}
    >
      <a
        href={href}
        className="page-entry"
        role="treeitem"
        aria-level={level}
        aria-current={active ? "page" : undefined}
        data-menu={menuKey}
        title={title}
        onClick={onOpen}
        {...linkProps}
      >
        {leading !== undefined && (
          <span className="row-leading" aria-hidden="true">
            {leading}
          </span>
        )}
        <span className="row-label">{label}</span>
        {trailing !== undefined && <span className="row-trailing">{trailing}</span>}
        {meta !== undefined && <span className="row-meta">{meta}</span>}
      </a>
      {menu && (
        <span className="tree-row-menu">
          <Tooltip label="More actions">
            <button
              type="button"
              className="tree-menu-btn"
              aria-label={menu.label}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              onClick={menu.onToggle}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Menu
            open={menu.open}
            onClose={menu.onClose}
            label={menu.label}
            className="tree-menu"
            containerSelector=".tree-row-menu"
            items={menu.items}
          />
        </span>
      )}
    </div>
  );
}
