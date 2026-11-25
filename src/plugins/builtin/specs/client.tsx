// Specs' browser half (specs/app/plugins.feature.md "Specs is a built-in
// plugin"): the tab, registered while the plugin is on in the open folder,
// so it stands in the tab bar and on the rail where the profile's order
// puts it and goes when the plugin is switched off. The feature tree and the
// editor are still built inside App.tsx, which hands them to this tab
// through src/frontend/specs/host.ts; the tab renders them.

import { FileText } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { SPECS_PLUGIN } from "../../profile";
import { specsHost } from "../../../frontend/specs/host";
import { manifest } from "./manifest";

/** The Specs tab's id, which is the plugin's. */
export const SPECS_TAB = SPECS_PLUGIN;

export const specsTab: TabPlugin<null> = {
  id: SPECS_TAB,
  title: "Specs",
  icon: FileText,
  order: 0,
  shortcut: "g s",
  // The tab bar turns the sidebar to the tree; a row opens a feature.
  opensOnSelect: false,
  route: {
    match: () => null,
    path: () => "/",
    key: () => SPECS_TAB,
    title: () => "Specs",
    home: null,
  },
  // The tree, as App last built it.
  Sidebar: () => <>{specsHost()?.sidebar ?? null}</>,
  Pane: () => null,
};

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["tabs"],
  apply(ctx) {
    ctx.effect(() => ctx.need("tabs").add(specsTab as TabPlugin));
  },
};

export default plugin;
