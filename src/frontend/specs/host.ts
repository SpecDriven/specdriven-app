// What App.tsx hands the Specs tab (src/plugins/builtin/specs/client.tsx)
// while the tree, the feature page and the editor are still built inside App:
// the elements to render and the handlers that act on App's state. App
// publishes a fresh host on every render, before its children render, so the
// tab's Sidebar and Pane — rendered as App's children — always read this
// render's elements, and the tab's palette, create and shortcut hooks read
// this render's handlers when they run.
//
// Not part of the plugin SDK: a seam for moving the Specs tab out of App.tsx
// a piece at a time (specs/app/plugins.feature.md "Specs is a built-in
// plugin"). Each later move takes a field off it.

import type { ReactNode } from "react";
import type { OpenViewOptions, PaletteHit, RecentItem } from "../../plugins/client/tabs";
import type { SpecsView } from "../../plugins/builtin/specs/route";

export interface SpecsHost {
  /** The tree: the Specs tab's sidebar panel. */
  sidebar: ReactNode;
  /** The open feature's page, its scenario's page or the editor. */
  pane: ReactNode;
  /** The window title's page part — the feature, and the scenario open in the pane — or null while it loads. */
  title: string | null;
  /** Open a feature, or a scenario's page when the view names one. */
  open(view: SpecsView, opts: OpenViewOptions): void;
  /** The palette's features and scenarios for a query (specs/search.feature.md). */
  search(query: string, signal: AbortSignal): Promise<PaletteHit<SpecsView>[]>;
  /** How the palette's Recent list shows a feature or a scenario that was open. */
  recent(view: SpecsView): RecentItem<SpecsView> | null;
  /** `c` from the tree: a new feature, in the folder selected. */
  createFeature(): void;
  /** `c` on an open feature: a new scenario. */
  createInView: { label: string; run: (() => void) | null } | null;
}

const NO_HOST: SpecsHost = {
  sidebar: null,
  pane: null,
  title: null,
  open: () => {},
  search: async () => [],
  recent: () => null,
  createFeature: () => {},
  createInView: null,
};

let current: SpecsHost = NO_HOST;
let provided = false;

/**
 * App's render: what the Specs tab reads until the next render. The handlers
 * go first, before any early return of App's (its loading screen) — a link
 * opened at start needs `open` before the tree or the pane are built — and
 * the elements follow at the end of the render.
 */
export function provideSpecsHost(host: Partial<SpecsHost>): void {
  current = { ...current, ...host };
  provided = true;
}

/** The host App last provided, or null before App's first render. */
export function specsHost(): SpecsHost | null {
  return provided ? current : null;
}
