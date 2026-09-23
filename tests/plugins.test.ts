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

afterEach(async () => {
  await syncPlugins({ testing: false, issues: false });
  await syncClientPlugins([]);
});

test("the Tests switch mounts the plugin's routes and unmounts them again", async () => {
  await syncPlugins({ testing: false });
  expect(matchApi("GET", "/api/tests")).toBeNull();
  expect(await handleApi(new Request("http://x/api/tests"))).toBeNull();
  expect(pluginStates()).toEqual([
    {
      id: "issues",
      displayName: "GitHub issues",
      description: "The code repo's GitHub issues on their own tab",
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
  globalThis.fetch = (async () => Response.json(answer.body, { status: answer.status })) as typeof fetch;
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
