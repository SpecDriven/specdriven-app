// The plugin loaders (specs/app/plugins.feature.md): the host mounts a
// built-in plugin when its switch is on and unwinds it when the switch goes
// off — its routes with it — and the browser loader does the same for the
// tab, following what the server reports.

import { afterEach, expect, test } from "bun:test";
import { handleApi, matchApi } from "../src/server/api";
import { pluginStates, shell, sync, syncPlugins } from "../src/plugins/host/loader";
import { pluginWanted } from "../src/plugins/manifest";
import { manifest as testsManifest } from "../src/plugins/builtin/tests/manifest";
import { client, matchPluginRoute, syncClientPlugins, tabs } from "../src/plugins/client/loader";
import { tabReachable, type TabPlugin } from "../src/plugins/client/tabs";
import { pageSettings } from "../src/frontend/pages/pages";

afterEach(async () => {
  await syncPlugins({ testing: false, issues: false, models: false, roadmap: false, tasks: false });
  await syncClientPlugins([]);
});

test("the Tests switch mounts the plugin's routes and unmounts them again", async () => {
  await syncPlugins({ testing: false });
  expect(matchApi("GET", "/api/tests")).toBeNull();
  expect(await handleApi(new Request("http://x/api/tests"))).toBeNull();
  expect(pluginStates()).toEqual([
    // The special folders come first; the notebook is on unless switched off.
    {
      id: "roadmap",
      displayName: "Roadmap",
      description: "Markdown roadmap pages on their own tab",
      builtin: true,
      enabled: false,
    },
    {
      id: "tasks",
      displayName: "Tasks",
      description: "Tasks to assign, tick off and put on the calendar",
      builtin: true,
      enabled: false,
    },
    {
      id: "notebook",
      displayName: "Engineering notebook",
      description: "A shared, dated log of observations and decisions",
      builtin: true,
      enabled: true,
    },
    {
      id: "issues",
      displayName: "GitHub issues",
      description: "The code repo's GitHub issues on their own tab",
      builtin: true,
      enabled: false,
    },
    {
      id: "models",
      displayName: "Event models",
      description: "Event Models drawn on a canvas, sliced into specs",
      builtin: true,
      enabled: false,
    },
    {
      id: "tests",
      displayName: "Test management",
      description: "Test cases, plans and runs on their own tab",
      builtin: true,
      enabled: false,
    },
  ]);

  await syncPlugins({ testing: true });
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect(matchApi("PUT", "/api/tests/executions/e1/results/c%2F1")!.params).toEqual({
    id: "e1",
    caseId: "c/1",
  });
  expect(pluginStates().find((p) => p.id === "tests")!.enabled).toBe(true);
  // Core routes still come first, and are untouched by the mount.
  expect(matchApi("GET", "/api/state")).not.toBeNull();
  expect(matchApi("POST", "/api/tests/open-in-idea")).not.toBeNull();

  await syncPlugins({ testing: false });
  expect(matchApi("GET", "/api/tests")).toBeNull();
  expect(matchApi("POST", "/api/tests/open-in-idea")).not.toBeNull();
  expect(pluginStates().find((p) => p.id === "tests")!.enabled).toBe(false);
});

test("a switch that is absent means the manifest's default", () => {
  expect(pluginWanted(testsManifest, {})).toBe(false);
  expect(pluginWanted(testsManifest, { testing: true })).toBe(true);
  expect(pluginWanted(testsManifest, { testing: "yes" })).toBe(false);
  expect(pluginWanted({ ...testsManifest, switch: undefined }, {})).toBe(true);
});

test("the plugin's urls serve the app shell whether it is on or off", () => {
  expect(shell.prefixes()).toContain("/tests");
  expect(shell.matches("/tests")).toBe(true);
  expect(shell.matches("/tests/plans/p1")).toBe(true);
  expect(shell.matches("/testsy")).toBe(false);
  expect(shell.matches("/features/x")).toBe(false);
});

test("a sync hook runs on the tick and stops when disposed", async () => {
  const seen: string[] = [];
  const off = sync.drift(async (dir) => {
    seen.push(dir);
    return "hooked";
  });
  expect(await sync.run("/data")).toEqual(["hooked"]);
  off();
  expect(await sync.run("/data")).toEqual([]);
  expect(seen).toEqual(["/data"]);
});

test("the browser loader registers the tab while the server says it is on", async () => {
  // The store's load is a fetch the test has no server for; the plugin
  // mounts all the same and reports the error in the store.
  const quiet = console.error;
  console.error = () => {};
  try {
    await syncClientPlugins([{ id: "tests", enabled: false }]);
    expect(tabs.list()).toEqual([]);
    expect(matchPluginRoute("/tests/cases")).toBeNull();

    await syncClientPlugins([{ id: "tests", enabled: true }]);
    expect(tabs.list().map((t) => t.id)).toEqual(["tests"]);
    const hit = matchPluginRoute("/tests/cases/c1");
    expect(hit?.tab.id).toBe("tests");
    expect(hit?.view).toEqual({ kind: "case", id: "c1" });
    expect(hit && hit.tab.route.path(hit.view)).toBe("/tests/cases/c1");
    expect(matchPluginRoute("/features/x")).toBeNull();

    await syncClientPlugins([]);
    expect(tabs.list()).toEqual([]);
  } finally {
    console.error = quiet;
  }
});

test("the Issues tab registers only while the store knows a GitHub repo", async () => {
  // The plugin's first list load is a fetch this test answers by hand: a
  // data folder whose code repo is not on GitHub has no tab, and one whose
  // code repo is gets it — with the tab following the store either way.
  const realFetch = globalThis.fetch;
  let answer: { status: number; body: unknown } = {
    status: 404,
    body: { error: "No GitHub code repo" },
  };
  globalThis.fetch = (async () => Response.json(answer.body, { status: answer.status })) as unknown as typeof fetch;
  try {
    await syncClientPlugins([{ id: "issues", enabled: true }]);
    expect(tabs.list().map((t) => t.id)).toEqual([]);
    expect(matchPluginRoute("/issues/12")).toBeNull();

    // The data folder changes to one with a GitHub code repo.
    answer = {
      status: 200,
      body: { repo: { owner: "acme", name: "app", url: "https://github.com/acme/app" }, state: "open", issues: [] },
    };
    await client.serial("data/changed");
    expect(tabs.list().map((t) => t.id)).toEqual(["issues"]);
    expect(matchPluginRoute("/issues/12")?.view).toEqual({ kind: "issue", number: 12 });

    // And back to one without: the tab goes, the plugin stays mounted.
    answer = { status: 404, body: { error: "No GitHub code repo" } };
    await client.serial("data/changed");
    expect(tabs.list()).toEqual([]);

    await syncClientPlugins([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the Models switch mounts the canvas's routes and the folder's drift pass", async () => {
  await syncPlugins({ models: false });
  expect(matchApi("GET", "/api/models")).toBeNull();
  expect(matchApi("POST", "/api/models/m%2Fa.model.json/slices/s1/feature")).toBeNull();
  expect(shell.matches("/models/shop/cart")).toBe(true);

  await syncPlugins({ models: true });
  expect(matchApi("GET", "/api/models")).not.toBeNull();
  expect(matchApi("GET", "/api/models/models%2Fcart.model.json/export")!.params).toEqual({
    file: "models/cart.model.json",
  });
  expect(matchApi("POST", "/api/models/m%2Fa.model.json/slices/s1/feature")!.params).toEqual({
    file: "m/a.model.json",
    slice: "s1",
  });

  await syncPlugins({ models: false });
  expect(matchApi("PUT", "/api/models/models%2Fcart.model.json")).toBeNull();
});

test("the Models tab opens its first model, and a feature page crumbs back to it", async () => {
  // The listing is the one fetch the plugin makes on mount; answered here.
  const realFetch = globalThis.fetch;
  let listed: unknown[] = [];
  globalThis.fetch = (async () => Response.json({ models: listed })) as unknown as typeof fetch;
  try {
    await syncClientPlugins([{ id: "models", enabled: true }]);
    const tab = tabs.get("models")!;
    expect(tab).toBeDefined();
    // An empty folder: the bare url resolves to nothing, so it goes home and
    // the tab has no rail icon or chord.
    expect(tabReachable(tab)).toBe(false);
    const bare = matchPluginRoute("/models")!;
    expect(bare.view).toEqual({ fileName: null });
    expect(tab.route.resolve!(bare.view)).toBeNull();

    listed = [
      {
        fileName: "models/cart.model.json",
        name: "Cart",
        links: [{ slice: "Add item", feature: "specs/cart.feature.md" }],
      },
    ];
    await client.serial("data/changed");
    expect(tabReachable(tab)).toBe(true);
    expect(tab.route.resolve!(bare.view)).toEqual({ fileName: "models/cart.model.json" });
    expect(tab.route.title({ fileName: "models/cart.model.json" })).toBe("Cart");

    const crumbs = tab.featureCrumbs!("specs/cart.feature.md");
    expect(crumbs.map((c) => [c.title, tab.route.path(c.view)])).toEqual([
      ["Open the Event Model “Cart” — slice “Add item”", "/models/cart"],
    ]);
    expect(tab.featureCrumbs!("specs/other.feature.md")).toEqual([]);
    expect(tab.session!({ fileName: "models/cart.model.json" })).toEqual({
      models: ["models/cart.model.json"],
      labels: ["the model “Cart”"],
    });

    await syncClientPlugins([]);
    expect(tabs.get("models")).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The special folders (src/plugins/builtin/pages): three plugins from one
// factory, each with its own switch — the notebook's on unless turned off —
// and its own routes.
test("each special folder's switch mounts its own routes", async () => {
  await syncPlugins({ roadmap: false, tasks: false, notebook: false });
  for (const folder of ["roadmap", "tasks", "notebook"]) {
    expect(matchApi("GET", `/api/${folder}`)).toBeNull();
    expect(shell.matches(`/${folder}/x`)).toBe(true);
  }
  expect(matchApi("POST", "/api/tasks/tasks%2Fship.md/estimate")).toBeNull();

  await syncPlugins({ tasks: true });
  expect(matchApi("GET", "/api/roadmap")).toBeNull();
  expect(matchApi("GET", "/api/tasks/tasks%2Fship.md")!.params).toEqual({ file: "tasks/ship.md" });
  expect(matchApi("POST", "/api/tasks/tasks%2Fship.md/estimate")).not.toBeNull();
  // An absent notebook key means on.
  expect(matchApi("GET", "/api/notebook")).not.toBeNull();
  // Only the notebook has the entry routes; only tasks have the estimate.
  expect(matchApi("PUT", "/api/notebook/notebook%2Fa.md/kind")).not.toBeNull();
  expect(matchApi("PUT", "/api/tasks/tasks%2Fa.md/kind")).toBeNull();
  expect(matchApi("POST", "/api/notebook/notebook%2Fa.md/estimate")).toBeNull();

  await syncPlugins({ roadmap: true, tasks: false, notebook: false });
  expect(matchApi("DELETE", "/api/roadmap/roadmap%2Fpricing.md")).not.toBeNull();
  expect(matchApi("GET", "/api/tasks")).toBeNull();
  expect(matchApi("GET", "/api/notebook")).toBeNull();
});

test("a special folder's tab opens its first page, and is a list to pick from", async () => {
  // Each folder's listing is the one fetch its plugin makes on mount.
  const realFetch = globalThis.fetch;
  let listed: Record<string, unknown[]> = { tasks: [], notebook: [] };
  globalThis.fetch = (async (url: string) =>
    Response.json({ pages: listed[String(url).split("/").pop()!] ?? [] })) as unknown as typeof fetch;
  try {
    await syncClientPlugins(
      [
        { id: "tasks", enabled: true },
        { id: "notebook", enabled: true },
      ],
      { demo: false, settings: { googleCalendar: true, canRunAgentPane: false } },
    );
    expect(tabs.list().map((t) => [t.id, t.shortcut])).toEqual([
      ["tasks", "g t"],
      ["notebook", "g n"],
    ]);
    const tasksTab = tabs.get("tasks") as TabPlugin<{ fileName: string | null }>;
    // The tab bar only turns the sidebar; a row, the rail or `g t` opens a page.
    expect(tasksTab.opensOnSelect).toBe(false);
    // An empty folder: the bare url resolves to nothing, so it goes home.
    expect(tabReachable(tasksTab as TabPlugin)).toBe(false);
    expect(matchPluginRoute("/tasks")!.view).toEqual({ fileName: null });
    // Another folder's url is not this tab's.
    expect(matchPluginRoute("/notebook/2026-09-12-a")?.tab.id).toBe("notebook");

    listed = {
      tasks: [{ fileName: "tasks/ship-v2.md", name: "Ship v2" }],
      notebook: [],
    };
    await client.serial("data/changed");
    expect(tabReachable(tasksTab as TabPlugin)).toBe(true);
    expect(tasksTab.route.resolve!({ fileName: null })).toEqual({ fileName: "tasks/ship-v2.md" });
    expect(tasksTab.route.title({ fileName: "tasks/ship-v2.md" })).toBe("Ship v2");
    // A page the listing does not hold yet is titled from its file name.
    expect(tasksTab.route.title({ fileName: "tasks/cut-the-build.md" })).toBe("Cut The Build");
    // What the palette's Recent list remembers it by.
    expect(tasksTab.recent!({ fileName: "tasks/ship-v2.md" })).toBe("Ship v2");
    expect(tasksTab.recent!({ fileName: null })).toBeNull();
    // A stale link is not worth remembering.
    expect(tasksTab.recent!({ fileName: "tasks/nope.md" })).toBeNull();

    // "New notebook entry" is the notebook's palette command, and only its.
    const host = { prompt: async () => null, promptWithChoice: async () => null, confirm: async () => false, navigate: () => {} };
    expect(tabs.get("notebook")!.palette!.commands!(host).map((c) => c.id)).toEqual([
      "action:new-notebook-entry",
    ]);
    expect(tasksTab.palette!.commands).toBeUndefined();

    // The Google Calendar switch reaches the tasks' header as it flips.
    expect(pageSettings.get().googleCalendar).toBe(true);
    client.emit("settings/changed", { googleCalendar: false });
    expect(pageSettings.get().googleCalendar).toBe(false);

    await syncClientPlugins([]);
    expect(tabs.list()).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
