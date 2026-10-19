// Fix this app's browser half (specs/app/self-healing.feature.md): the tab,
// its sidebar of fixes, the pane, the `g x` shortcut and the palette's
// "Fix this app…". Not on offer in the demo, whose server refuses every
// route of the module.

import { Wrench } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { SelfFixPane, SelfFixSidebar } from "../../../frontend/SelfFixPane";
import { selfFix, selfFixKey, selfFixTitle } from "../../../frontend/selfFix";
import { manifest } from "./manifest";
import { parseSelfFixRoute, selfFixPath, type SelfFixRoute } from "./route";

interface SelfFixConfig {
  demo: boolean;
}

const tab: TabPlugin<SelfFixRoute> = {
  id: manifest.id,
  title: "Fix this app",
  icon: Wrench,
  order: 90,
  shortcut: "g x",
  route: {
    match: parseSelfFixRoute,
    path: selfFixPath,
    key: selfFixKey,
    title: selfFixTitle,
    home: { kind: "new" },
  },
  Sidebar: ({ view, navigate }) => <SelfFixSidebar view={view} onNavigate={navigate} />,
  Pane: ({ view, app, navigate }) => (
    <SelfFixPane view={view} repoCrumb={app.repoCrumb} confirm={app.confirm} onNavigate={navigate} onOpenSettings={app.openSettings} />
  ),
  palette: {
    group: "Fix this app",
    commands: ({ navigate }) => [
      {
        id: "action:fix-this-app",
        group: "Actions",
        label: "Fix this app…",
        text: "Fix this app",
        icon: <Wrench size={14} />,
        run: () => navigate({ kind: "new" }, { push: true }),
      },
    ],
  },
  subscribe: selfFix.subscribe,
};

const plugin: Plugin<Context, SelfFixConfig> = {
  name: manifest.id,
  inject: ["tabs"],
  Config: { parse: (raw) => ({ demo: Boolean((raw as Partial<SelfFixConfig> | undefined)?.demo) }) },
  async apply(ctx, config) {
    if (config.demo) return;
    ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
    ctx.effect(() => () => selfFix.reset());
    await selfFix.load();
  },
};

export default plugin;
