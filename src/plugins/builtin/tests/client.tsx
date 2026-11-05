// The test management module's browser half (specs/app/tests.feature.md):
// the Tests tab, its sidebar and pane, the `g e` shortcut, the palette's
// search and commands, and the store's lifecycle — loaded on mount, refreshed
// on the reload tick, reloaded when the data folder changes, emptied on
// dispose. App.tsx knows none of this; it renders the registered tab.

import { FlaskConical } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { TestsPane, TestsSidebar, newCaseFlow, newPlanFlow } from "../../../frontend/TestsPane";
import { searchTests, testing, testingState, testsKey, testsTitle } from "../../../frontend/testing";
import { manifest } from "./manifest";
import { parseTestsRoute, testsPath, type TestsRoute } from "./route";

const tab: TabPlugin<TestsRoute> = {
  id: manifest.id,
  title: "Tests",
  icon: FlaskConical,
  order: 60,
  shortcut: "g e",
  route: {
    match: parseTestsRoute,
    path: testsPath,
    key: testsKey,
    title: (view) => testsTitle(view, testingState()),
    home: { kind: "plans" },
  },
  // `c` on the tab makes a case (specs/app/plugins.feature.md).
  create: { label: "New case", run: (app, navigate) => void newCaseFlow(app.prompt, navigate) },
  Sidebar: ({ view, app, navigate }) => (
    <TestsSidebar view={view} prompt={app.prompt} confirm={app.confirm} onNavigate={navigate} readOnly={app.readOnly} />
  ),
  Pane: ({ view, app, navigate }) => (
    <TestsPane
      view={view}
      features={app.features}
      members={app.members}
      assignments={app.assignments}
      repoCrumb={app.repoCrumb}
      autosaveSeconds={app.autosaveSeconds}
      prompt={app.prompt}
      confirm={app.confirm}
      onNavigate={navigate}
    />
  ),
  palette: {
    group: "Tests",
    // The Tests tab searches the module's own store: the server's full-text
    // index knows only markdown (src/frontend/testing.ts searchTests).
    search: (query) =>
      searchTests(query, testingState()).map((hit) => ({
        id: `tests:${hit.kind}:${hit.id}`,
        label: hit.label,
        sub: hit.sub,
        href: hit.href,
        view: hit.view,
      })),
    commands: ({ prompt, navigate }) => [
      {
        id: "action:new-plan",
        group: "Actions",
        label: "New test plan",
        text: "New test plan",
        icon: <FlaskConical size={14} />,
        run: () => void newPlanFlow(prompt, navigate),
      },
      {
        id: "action:new-case",
        group: "Actions",
        label: "New test case",
        text: "New test case",
        icon: <FlaskConical size={14} />,
        run: () => void newCaseFlow(prompt, navigate),
      },
    ],
  },
  subscribe: testing.subscribe,
};

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["tabs"],
  async apply(ctx) {
    ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
    // Switched off, or the data folder gone: forget everything.
    ctx.effect(() => () => testing.reset());
    ctx.on("data/changed", async () => {
      testing.reset();
      await testing.load();
    });
    // The reload tick's refresh is skipped while an editor holds an unsaved
    // draft (the store checks).
    ctx.on("reload/tick", () => void testing.refresh());
    // The plans are there before any deep link that names one resolves.
    await testing.load();
  },
};

export default plugin;
