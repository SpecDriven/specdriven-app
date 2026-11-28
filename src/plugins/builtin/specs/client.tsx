// Specs' browser half (specs/app/plugins.feature.md "Specs is a built-in
// plugin"): the tab, registered while the plugin is on in the open folder,
// so it stands in the tab bar and on the rail where the profile's order
// puts it and goes when the plugin is switched off. Its views are the
// features' urls (./route.ts). Its pane — the feature's page, a scenario's
// editor or page — and its dialogs are components of src/frontend/specs/
// that read the stores there. The feature tree is still built inside
// App.tsx, and the handlers still live there: App hands both to this tab
// through src/frontend/specs/host.ts, and the tab opens a feature through
// it.

import { FileText } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { SPECS_PLUGIN } from "../../profile";
import { specsHost } from "../../../frontend/specs/host";
import { openFeatureTitle } from "../../../frontend/specs/openFeature";
import { recentSpec, searchSpecs } from "../../../frontend/specs/palette";
import { SpecsDialogs } from "../../../frontend/specs/SpecsDialogs";
import { SpecsPane } from "../../../frontend/specs/SpecsPane";
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
  // The pane goes to another tab's view, an app page or home: the editor
  // pane's last save goes out and the feature is no longer open.
  leave: () => specsHost()?.leave(),
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
  Pane: ({ app }) => <SpecsPane app={app} />,
  // The merge conflict, publish and import dialogs.
  Overlay: ({ app }) => {
    const actions = specsHost()?.actions;
    return actions ? <SpecsDialogs app={app} actions={actions} /> : null;
  },
};

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["tabs"],
  apply(ctx) {
    ctx.effect(() => ctx.need("tabs").add(specsTab as TabPlugin));
    // Switched off: the tab is gone from the registry, so no one will ask it
    // to leave — it lets go of its open feature itself, the editor pane's
    // last save going out first.
    ctx.effect(() => () => specsHost()?.leave());
    // A data folder switch: the open scenario's and the description's last
    // saves land in the folder they were typed in, as every tab's do.
    ctx.on("data/leaving", async () => {
      await specsHost()?.land();
    });
    // The reload tick: the open feature as the folder now has it. Answered
    // as a promise, so Sync's progress lasts until it is read.
    ctx.on("reload/tick", () => specsHost()?.refresh());
  },
};

export default plugin;
