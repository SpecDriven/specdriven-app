// The plugin loaders (specs/app/plugins.feature.md): the host mounts a
// built-in plugin when its switch is on and unwinds it when the switch goes
// off — its routes with it — and the browser loader does the same for the
// tab, following what the server reports.

import { afterEach, expect, test } from "bun:test";
import { handleApi, matchApi } from "../src/server/api";
import { host, pluginStates, sessionParts, shell, sync, syncPlugins } from "../src/plugins/host/loader";
import { builtinManifests, profileManifests } from "../src/plugins/builtin/manifests";
import { isSearchScope } from "../src/server/search";
import { buildSessionPrompt } from "../src/server/agent";
import {
  dropPlugin,
  hasLegacyKeys,
  legacyFields,
  migrateProfile,
  readProfile,
  withPlugin,
  writeProfile,
} from "../src/plugins/profile";
import { version as appVersion } from "../package.json";
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
  // The profile's entries first — the notebook, on unless switched off — then
  // the built-ins it leaves off, in load order.
  const row = (id: string, enabled: boolean) => {
    const m = builtinManifests.find((x) => x.id === id)!;
    return {
      id,
      displayName: m.displayName,
      description: m.description,
      version: appVersion,
      builtin: true,
      source: "builtin" as const,
      installed: true,
      trusted: true,
      enabled,
      active: enabled,
    };
  };
  expect(pluginStates()).toEqual([
    row("notebook", true),
    row("self-fix", true),
    row("agent-claude", true),
    row("agent-codex", true),
    row("agent-pi", true),
    row("roadmap", false),
    row("tasks", false),
    row("issues", false),
    row("tests", false),
  ]);
  expect(pluginStates().map((p) => [p.displayName, p.description])).toEqual([
    ["Engineering notebook", "A shared, dated log of observations and decisions"],
    ["Fix this app", "Describe a bug; a coding agent fixes the app's own source, and the app rebuilds and restarts into the fix"],
    ["Claude agent", "Claude Code in the coding agent pane, with its sign-in and proxy settings"],
    ["Codex agent", "OpenAI's Codex CLI in the coding agent pane, with permission cards for commands and file changes"],
    ["Pi agent", "pi.dev's coding agent in the coding agent pane — minimal, and it runs its own tools"],
    ["Roadmap", "Markdown roadmap pages on their own tab"],
    ["Tasks", "Tasks to assign, tick off and put on the calendar"],
    ["GitHub issues", "The code repo's GitHub issues on their own tab"],
    ["Test management", "Test cases, plans and runs on their own tab"],
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

// The profile (specs/app/plugins.feature.md "The profile lists enabled
// plugins in tab order"): the open folder's list when the settings have it;
// a settings file from before plugins is read as the matching list.
test("a settings file from before plugins is read as the matching profile", () => {
  // Nothing at all: no plugin — Specs alone.
  expect(readProfile({}, builtinManifests)).toEqual({ enabled: [], migrated: false });
  // The legacy switches, in load order whatever order the file had them in.
  expect(
    readProfile({ testing: true, notebook: false, roadmap: true, models: "yes" }, builtinManifests),
  ).toEqual({ enabled: ["roadmap", "tests", "self-fix", "agent-claude", "agent-codex", "agent-pi"], migrated: true });
  // The list, once there, is the whole truth: order kept, legacy keys ignored,
  // an id nothing provides kept for Settings to report, junk dropped.
  const state: Record<string, unknown> = {
    plugins: { enabled: ["tests", "notebook", "acme-jira", "tests", 7, ""] },
    testing: false,
    roadmap: true,
  };
  expect(readProfile(state, builtinManifests)).toEqual({
    enabled: ["tests", "notebook", "acme-jira"],
    migrated: false,
  });
  // What `GET /api/state` still reports for one release.
  expect(legacyFields(["tests", "notebook"], builtinManifests)).toEqual({
    roadmap: false,
    tasks: false,
    notebook: true,
    issues: false,
    testing: true,
  });
  // Writing the profile stores it for the open folder, drops the legacy
  // switches and keeps the section's other keys.
  const file: Record<string, unknown> = {
    dataRepo: "/x",
    testing: true,
    notebook: false,
    plugins: { sources: [{ path: "/dev/jira" }] },
  };
  expect(hasLegacyKeys(file, builtinManifests)).toBe(true);
  writeProfile(file, ["tests", "roadmap"], builtinManifests);
  expect(file).toEqual({
    dataRepo: "/x",
    plugins: { sources: [{ path: "/dev/jira" }], repos: { "/x": { enabled: ["tests", "roadmap"] } } },
  });
  expect(hasLegacyKeys(file, builtinManifests)).toBe(false);
  // A switch edits the list: on appends, off removes, either is idempotent.
  expect(withPlugin(["notebook"], "tests", true)).toEqual(["notebook", "tests"]);
  expect(withPlugin(["notebook", "tests"], "tests", true)).toEqual(["notebook", "tests"]);
  expect(withPlugin(["notebook", "tests"], "notebook", false)).toEqual(["tests"]);
});

test("the profile's order is the tab order, and an id nothing provides is reported", async () => {
  await syncPlugins({ plugins: { enabled: ["tests", "acme-jira", "notebook"] } });
  expect(pluginStates().map((p) => [p.id, p.enabled, p.active, p.installed])).toEqual([
    ["tests", true, true, true],
    ["acme-jira", true, false, false],
    ["notebook", true, true, true],
    ["roadmap", false, false, true],
    ["tasks", false, false, true],
    ["issues", false, false, true],
    ["self-fix", false, false, true],
    ["agent-claude", false, false, true],
    ["agent-codex", false, false, true],
    ["agent-pi", false, false, true],
  ]);
  expect(pluginStates()[1]!.error).toMatch(/No installed plugin has this id/);
  expect(matchApi("GET", "/api/tests")).not.toBeNull();
  expect(matchApi("GET", "/api/notebook")).not.toBeNull();

  // The browser follows the same order for the tabs, and a reorder alone —
  // no mount, no unmount — moves them.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ pages: [], cases: [], plans: [], executions: [] })) as unknown as typeof fetch;
  const quiet = console.error;
  console.error = () => {};
  try {
    await syncClientPlugins(pluginStates());
    expect(tabs.list().map((t) => t.id)).toEqual(["tests", "notebook"]);
    await syncPlugins({ plugins: { enabled: ["notebook", "tests"] } });
    await syncClientPlugins(pluginStates());
    expect(tabs.list().map((t) => t.id)).toEqual(["notebook", "tests"]);
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
  }
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

// Each data folder keeps its own plugins (specs/app/plugins.feature.md):
// one folder may show Specs alone and another every plugin; a folder with
// no list yet shows Specs alone.
test("each data folder keeps its own profile; a new one shows Specs alone", () => {
  // A file this app wrote: it carries `repos` from the moment it names a folder.
  const file: Record<string, unknown> = { dataRepo: "/a", plugins: { seen: ["hello"], repos: {} } };
  expect(readProfile(file, builtinManifests)).toEqual({ enabled: [], migrated: false });
  writeProfile(file, ["roadmap", "tasks"], builtinManifests);
  file.dataRepo = "/b";
  expect(readProfile(file, builtinManifests).enabled).toEqual([]);
  writeProfile(file, ["tests"], builtinManifests);
  file.dataRepo = "/a";
  expect(readProfile(file, builtinManifests).enabled).toEqual(["roadmap", "tasks"]);
  expect(file.plugins).toEqual({
    seen: ["hello"],
    repos: { "/a": { enabled: ["roadmap", "tasks"] }, "/b": { enabled: ["tests"] } },
  });
  // An uninstalled plugin leaves every folder's list.
  dropPlugin(file, "tests", builtinManifests);
  expect((file.plugins as { repos: unknown }).repos).toEqual({
    "/a": { enabled: ["roadmap", "tasks"] },
    "/b": { enabled: [] },
  });
});

// An older file — one device-wide list, or the legacy switches — keeps
// showing what it showed in every folder it knows; folders picked later
// start with Specs alone.
test("an older device-wide list is copied to the folders the file knows", () => {
  const file: Record<string, unknown> = {
    dataRepo: "/a",
    recentDataRepos: ["/a", "/b"],
    plugins: { enabled: ["tests", "roadmap"], repos: { "/b": { enabled: ["issues"] } }, seen: [] },
  };
  expect(migrateProfile(file, builtinManifests)).toBe(true);
  expect(file.plugins).toEqual({
    seen: [],
    repos: { "/a": { enabled: ["tests", "roadmap"] }, "/b": { enabled: ["issues"] } },
  });
  expect(migrateProfile(file, builtinManifests)).toBe(false);
  file.dataRepo = "/c";
  expect(readProfile(file, builtinManifests).enabled).toEqual([]);

  const legacy: Record<string, unknown> = { dataRepo: "/a", recentDataRepos: ["/b"], testing: true };
  expect(migrateProfile(legacy, builtinManifests)).toBe(true);
  expect(legacy).toEqual({
    dataRepo: "/a",
    recentDataRepos: ["/b"],
    plugins: { repos: { "/a": { enabled: ["notebook", "tests", "self-fix", "agent-claude", "agent-codex", "agent-pi"] }, "/b": { enabled: ["notebook", "tests", "self-fix", "agent-claude", "agent-codex", "agent-pi"] } } },
  });
  // No folder known yet: the list stays device-wide, the switches still go.
  const early: Record<string, unknown> = { roadmap: true };
  expect(migrateProfile(early, builtinManifests)).toBe(true);
  expect(early).toEqual({ plugins: { enabled: ["roadmap", "notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"] } });
});

// An older file naming folders but holding no list and none of the switches
// showed the manifests' defaults (the Notebook), so its folders keep them. A
// file with `repos`, even empty, was written by this app and is not older.
test("an older file with folders but no list gives them the defaults; one with repos does not", () => {
  const older: Record<string, unknown> = { dataRepo: "/a", recentDataRepos: ["/a", "/b"], plugins: { seen: ["hello"] } };
  expect(readProfile(older, builtinManifests)).toEqual({ enabled: ["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"], migrated: true });
  expect(migrateProfile(older, builtinManifests)).toBe(true);
  expect(older.plugins).toEqual({
    seen: ["hello"],
    repos: { "/a": { enabled: ["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"] }, "/b": { enabled: ["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi"] } },
  });
  older.dataRepo = "/c";
  expect(readProfile(older, builtinManifests).enabled).toEqual([]);

  const current: Record<string, unknown> = { dataRepo: "/a", plugins: { repos: {} } };
  expect(readProfile(current, builtinManifests)).toEqual({ enabled: [], migrated: false });
  expect(migrateProfile(current, builtinManifests)).toBe(false);
  // No folder known yet: a fresh install, with nothing to carry over.
  expect(migrateProfile({}, builtinManifests)).toBe(false);
});

// The Event Models left the tree for the marketplace (the `models` plugin
// of SpecDriven/plugins): the old switch still reads as the plugin's id, and
// Settings → Plugins names it and says to install it.
test("the retired Models switch lists the plugin, which reports as not installed", async () => {
  expect(readProfile({ models: true }, profileManifests)).toEqual({
    enabled: ["notebook", "self-fix", "agent-claude", "agent-codex", "agent-pi", "models"],
    migrated: true,
  });
  // Not a built-in's switch: the file holds no older list of built-ins.
  expect(readProfile({ models: true }, builtinManifests).enabled).toEqual([]);
  await syncPlugins({ models: true });
  const row = pluginStates().find((p) => p.id === "models")!;
  expect(row).toMatchObject({ displayName: "Event models", installed: false, enabled: true, active: false });
  expect(row.error).toMatch(/install it from the marketplace/);
  expect(matchApi("GET", "/api/models")).toBeNull();
});

// What a plugin with files of its own asks of the core: a search scope, a
// part of the code gen session's prompt, a reserved folder and word of the
// features the specs-folder migration moved.
test("a plugin's search scope, session part and migration hooks come and go with it", async () => {
  const moves: [string, string][] = [];
  const scope = host.plugin({
    name: "fixture",
    inject: ["search", "sessions", "sync"],
    apply(ctx) {
      ctx.effect(() =>
        ctx.need("search").add("fixture", {
          kind: "thing",
          files: async () => [],
          document: () => null,
        }),
      );
      ctx.effect(() =>
        ctx.need("sessions").add("fixture", async (_dir, { refs, specFiles }) => ({
          sections: refs.map((ref) => ({
            heading: `Thing: ${ref}`,
            noun: { one: "Thing", many: "Things" },
            lines: [`with ${specFiles.length} spec(s)`],
          })),
          features: [],
        })),
      );
      ctx.effect(() => ctx.need("sync").reserve("things"));
      ctx.effect(() =>
        ctx.need("sync").moved(async (_dir, moved) => {
          moves.push(...moved);
        }),
      );
    },
  });
  await scope.ready;
  expect(isSearchScope("fixture")).toBe(true);
  expect(sync.reserved()).toContain("things");
  expect(sessionParts.entries().map(([id]) => id)).toContain("fixture");
  const contribute = sessionParts.entries().find(([id]) => id === "fixture")![1];
  const { sections } = await contribute("/data", { refs: ["t1"], specFiles: [] });
  expect(buildSessionPrompt("s", [], undefined, sections)).toBe(
    "SpecDriven code gen session: s\n\nImplement the following Thing.\n" +
      "Work in the current directory and exit when done.\n\n## Thing: t1\n\nwith 0 spec(s)\n",
  );
  await sync.runMoved("/data", new Map([["a.feature.md", "specs/a.feature.md"]]));
  expect(moves).toEqual([["a.feature.md", "specs/a.feature.md"]]);

  await scope.dispose();
  expect(isSearchScope("fixture")).toBe(false);
  expect(sync.reserved()).not.toContain("things");
  expect(sessionParts.entries().map(([id]) => id)).not.toContain("fixture");
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
