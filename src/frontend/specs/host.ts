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

export interface SpecsHost {
  /** The tree: the Specs tab's sidebar panel. */
  sidebar: ReactNode;
}

let current: SpecsHost | null = null;

/** App's render: what the Specs tab reads until the next render. */
export function provideSpecsHost(host: SpecsHost): void {
  current = host;
}

/** The host App last provided, or null before App's first render. */
export function specsHost(): SpecsHost | null {
  return current;
}
