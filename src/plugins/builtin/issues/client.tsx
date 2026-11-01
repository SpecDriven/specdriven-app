// GitHub issue tracking's browser half (specs/app/github-issues.feature.md):
// the Issues tab, its sidebar and pane, the `g i` shortcut, the palette's
// search and "New GitHub issue", and the store's lifecycle. The tab is on
// offer only while the data repo's code repo is a GitHub one: the store
// learns that from the first list it loads, and the tab registers and
// unregisters as the store's repository comes and goes — a data folder
// without one has no Issues tab, whatever the switch says. App.tsx knows
// none of this; it renders the registered tab.

import { Bug } from "lucide-react";
import type { Context, Disposer, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { IssuesPane, IssuesSidebar } from "../../../frontend/IssuesPane";
import {
  issues,
  issuesKey,
  issuesState,
  issuesTitle,
  searchIssues,
  setIssuesReadOnly,
} from "../../../frontend/issues";
import { manifest } from "./manifest";
import { issuesPath, parseIssuesRoute, type IssuesRoute } from "./route";

interface IssuesConfig {
  /** Demo mode: the tab reads the app's own repo and offers no writes. */
  demo: boolean;
}

const tabOf = (config: IssuesConfig): TabPlugin<IssuesRoute> => ({
  id: manifest.id,
  title: "Issues",
  icon: Bug,
  order: 50,
  shortcut: "g i",
  route: {
    match: parseIssuesRoute,
    path: issuesPath,
    key: issuesKey,
    title: (view) => issuesTitle(view, issuesState()),
    home: { kind: "list" },
  },
  Sidebar: ({ view, app, navigate }) => (
    <IssuesSidebar view={view} prompt={app.prompt} confirm={app.confirm} onNavigate={navigate} />
  ),
  Pane: ({ view, app, navigate }) => (
    <IssuesPane
      view={view}
      repoCrumb={app.repoCrumb}
      prompt={app.prompt}
      confirm={app.confirm}
      onNavigate={navigate}
      onOpenSettings={app.openSettings}
    />
  ),
  palette: {
    group: "Issues",
    // The Issues tab searches the loaded issues, by number, title and body.
    search: (query) =>
      searchIssues(query, issuesState()).map((hit) => ({
        id: `issues:${hit.number}`,
        label: hit.label,
        sub: hit.sub,
        href: hit.href,
        view: hit.view,
      })),
    // Not in the demo: its Issues tab reads the app's own repo and writes
    // nothing (src/frontend/issues.ts), so the palette offers no new issue.
    commands: ({ navigate }) =>
      config.demo
        ? []
        : [
            {
              id: "action:new-issue",
              group: "Actions",
              label: "New GitHub issue",
              text: "New GitHub issue",
              icon: <Bug size={14} />,
              run: () => navigate({ kind: "new" }, { push: true }),
            },
          ],
  },
  subscribe: issues.subscribe,
});

const plugin: Plugin<Context, IssuesConfig> = {
  name: manifest.id,
  inject: ["tabs"],
  Config: { parse: (raw) => ({ demo: Boolean((raw as Partial<IssuesConfig> | undefined)?.demo) }) },
  async apply(ctx, config) {
    setIssuesReadOnly(config.demo);
    const tab = tabOf(config) as TabPlugin;
    const registry = ctx.need("tabs");
    // The tab follows the store's repository: there while the list answered
    // with a GitHub repo, gone when the data folder has none.
    let registered: Disposer | null = null;
    const follow = () => {
      const has = issuesState().repo !== null;
      if (has && !registered) registered = registry.add(tab);
      else if (!has && registered) {
        void registered();
        registered = null;
      }
    };
    ctx.effect(() => {
      const unsubscribe = issues.subscribe(follow);
      return () => {
        unsubscribe();
        if (registered) void registered();
        registered = null;
      };
    });
    // Switched off, or the data folder gone: forget everything.
    ctx.effect(() => () => issues.reset());
    ctx.on("data/changed", async () => {
      issues.reset();
      await issues.load();
    });
    // The reload tick refreshes the issues only while one of the module's
    // views is open, so an idle app does not spend GitHub's rate limit on
    // every tick.
    ctx.on("reload/tick", (open) => {
      if (open?.tab === manifest.id) void issues.refresh();
    });
    await issues.load();
    follow();
  },
};

export default plugin;
