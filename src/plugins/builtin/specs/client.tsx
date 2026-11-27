// Specs' browser half (specs/app/plugins.feature.md "Specs is a built-in
// plugin"): the tab, registered while the plugin is on in the open folder,
// so it stands in the tab bar and on the rail where the profile's order
// puts it and goes when the plugin is switched off. Its views are the
// features' urls (./route.ts). The feature tree, the feature page and the
// editor are still built inside App.tsx, which hands them to this tab
// through src/frontend/specs/host.ts; the tab renders them, and opens a
// feature through it. The palette's search and Recent entries, and the
// window title, it reads from the stores in src/frontend/specs/.

import { FileText } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { SPECS_PLUGIN } from "../../profile";
import { specsHost } from "../../../frontend/specs/host";
import { openFeatureTitle } from "../../../frontend/specs/openFeature";
import { recentSpec, searchSpecs } from "../../../frontend/specs/palette";
import { titleFromFileName } from "../../../server/parser";
import { manifest } from "./manifest";
import { matchSpecsRoute, specsPath, type SpecsView } from "./route";

/** The Specs tab's id, which is the plugin's. */
export const SPECS_TAB = SPECS_PLUGIN;

export const specsTab: TabPlugin<SpecsView> = {
  id: SPECS_TAB,
  title: "Specs",
  icon: FileText,
  order: 0,
  shortcut: "g s",
  // The tab bar turns the sidebar to the tree; a row opens a feature.
  opensOnSelect: false,
  route: {
    match: matchSpecsRoute,
    path: specsPath,
    // The feature alone: opening one of its scenarios keeps the pane.
    key: (view) => view.feature,
    title: (view) => openFeatureTitle() ?? titleFromFileName(view.feature),
    // The tab's door is the folder's README, App's home.
    home: null,
  },
  // A feature is read before it shows, and a link that misses says so.
  open: (view, opts) => {
    const host = specsHost();
    if (!host) return false;
    host.open(view, opts);
    return true;
  },
  // The open feature goes with a coding agent message.
  current: (view) => view.feature,
  // `c` makes a feature from the tree, and a scenario on a feature's page.
  create: {
    label: "New feature",
    run: () => specsHost()?.createFeature(),
    inView: () => specsHost()?.createInView ?? null,
  },
  // The palette searches the spec files from this tab, and from any tab
  // with no search of its own (specs/search.feature.md).
  palette: {
    group: "Features",
    fallback: true,
    search: searchSpecs,
  },
  recent: recentSpec,
  // The imports into a spec folder, while their switches are on.
  get shortcuts() {
    return specsHost()?.shortcuts ?? [];
  },
  Sidebar: () => <>{specsHost()?.sidebar ?? null}</>,
  Pane: () => <>{specsHost()?.pane ?? null}</>,
};

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["tabs"],
  apply(ctx) {
    ctx.effect(() => ctx.need("tabs").add(specsTab as TabPlugin));
  },
};

export default plugin;
