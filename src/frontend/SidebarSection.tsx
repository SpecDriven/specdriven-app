// The sidebar's section head (specs/app/plugins.feature.md "A tab's sidebar
// uses the section head"): one chassis for every tab — the Specs tree's
// `FEATURES` head with its Filter chip and icon actions, and the same for a
// plugin's list, so "new" is offered the same way everywhere and no tab
// spends a row on buttons of its own. The label may be a link (the Tests
// overview, all issues); the filter slot takes a `chip` and its Menu, which
// hangs from the head's right edge (`.filter-anchor`); the actions are
// `ibtn`s with tooltips (SectionAction). Children sit under the head in the
// section's own stack — the active filter chips, a notice.

import type { MouseEventHandler, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export function SidebarSection({
  label,
  filter,
  actions,
  children,
}: {
  label: ReactNode;
  /** The filter chip and its menu, right of the label. */
  filter?: ReactNode;
  /** The head's icon actions, at the right edge. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="section">
      <div className="section-head">
        {label}
        <span className="filter-anchor">{filter}</span>
        {actions && <span className="head-actions">{actions}</span>}
      </div>
      {children}
    </div>
  );
}

/** One head action: a quiet icon button whose tooltip names it and its key. */
export function SectionAction({
  label,
  keys,
  icon,
  onClick,
  disabled,
  className,
}: {
  label: string;
  keys?: string;
  icon: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip label={label} keys={keys}>
      <button
        type="button"
        className={`ibtn${className ? ` ${className}` : ""}`}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
