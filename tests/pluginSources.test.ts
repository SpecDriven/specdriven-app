// Plugins from folders (specs/app/plugins.feature.md "A plugin loads from a
// local folder"): a fixture plugin in a temporary home is found, built by
// the app, mounted — its routes and url prefix with it — and its browser
// half served immutable at its revision; an edit rebuilds it under a new
// revision; a folder that goes is unwound; a manifest the app refuses, a
// repo plugin not yet trusted and a half that throws are each reported on
// their own row and keep the others running.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi } from "../src/server/api";
import {
  clientUrl,
  pluginStates,
  rebuildPlugin,
  shell,
  stopWatching,
  syncPlugins,
} from "../src/plugins/host/loader";
import { setBuildDisabled } from "../src/plugins/host/build";
import { pluginsHome, repoPluginsDir } from "../src/plugins/host/sources";
import { compareVersions, parsePackageManifest } from "../src/plugins/manifest";
import { clientLoadErrors, syncClientPlugins, tabs } from "../src/plugins/client/loader";
import { pathToFileURL } from "node:url";

let home: string;
let repo: string;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-plugins-home-"));
  repo = await mkdtemp(join(tmpdir(), "specdriven-plugins-repo-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  stopWatching();
  // Every filesystem plugin goes: a sync with sources on and none found.
  await syncPlugins({ plugins: { enabled: [] } }, { sources: true, dataDir: null });
  await syncPlugins({});
  await syncClientPlugins([]);
  setBuildDisabled(false);
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

interface FixtureOptions {
  greeting?: string;
  manifest?: Record<string, unknown>;
  /** The host half's apply throws with this message. */
  throws?: string;
}

/** A TypeScript plugin with both halves, the browser one using JSX over react. */
async function fixture(dir: string, id: string, opts: FixtureOptions = {}): Promise<string> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: id,
      version: "0.1.0",
      type: "module",
      specdriven: {
        id,
        api: "1",
        displayName: `The ${id} plugin`,
        description: `${id} on its own tab`,
        src: { host: "./src/host.ts", client: "./src/client.tsx" },
        paths: [`/${id}`],
        permissions: ["data:read"],
        ...opts.manifest,
      },
    }),
  );
  await writeFile(
    join(dir, "src", "host.ts"),
    `export default {
      name: ${JSON.stringify(id)},
      inject: ["routes"],
      apply(ctx: any) {
        ${opts.throws ? `throw new Error(${JSON.stringify(opts.throws)});` : ""}
        ctx.effect(() => ctx.need("routes").add("GET", ${JSON.stringify(`/api/${id}`)}, () =>
          Response.json({ greeting: ${JSON.stringify(opts.greeting ?? "hello")} })));
      },
    };`,
  );
  await writeFile(
    join(dir, "src", "client.tsx"),
    `import { useState } from "react";
    function Pane() { const [n] = useState(1); return <div>{n}</div>; }
    export default {
      name: ${JSON.stringify(id)},
      inject: ["tabs"],
      apply(ctx: any) {
        ctx.effect(() => ctx.need("tabs").add({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(id)},
          icon: Pane, order: 100, route: { match: (p: string) => p === ${JSON.stringify(`/${id}`)} ? {} : null,
          path: () => ${JSON.stringify(`/${id}`)}, key: () => ${JSON.stringify(id)}, title: () => ${JSON.stringify(id)}, home: {} },
          Sidebar: Pane, Pane }));
      },
    };`,
  );
  return dir;
}

const get = (path: string, headers: Record<string, string> = {}) =>
  handleApi(new Request(`http://localhost${path}`, { headers }));

const row = (id: string) => pluginStates().find((p) => p.id === id);

test("a plugin folder under ~/.specdriven/plugins is found, built, mounted and served", async () => {
  await fixture(join(pluginsHome(), "hello"), "hello");
  const state: Record<string, unknown> = {};
  let persisted: unknown = null;
  await syncPlugins(state, {
    sources: true,
    dataDir: null,
    persist: async (s) => {
      persisted = structuredClone(s);
    },
  });

  // Found for the first time: on, at the end of the tab order, and stored.
  const profile = state.plugins as { enabled: string[]; seen: string[] };
  expect(profile.enabled).toEqual(["notebook", "hello"]);
  expect(profile.seen).toEqual(["hello"]);
  expect(persisted).toEqual(state);

  // The host half is mounted: its route answers, its url prefix serves the shell.
  expect(matchApi("GET", "/api/hello")).not.toBeNull();
  expect(await (await get("/api/hello"))!.json()).toEqual({ greeting: "hello" });
  expect(shell.matches("/hello")).toBe(true);
  expect(shell.matches("/hello/anything")).toBe(true);

  const hello = row("hello")!;
  expect(hello).toMatchObject({
    displayName: "The hello plugin",
    description: "hello on its own tab",
    version: "0.1.0",
    builtin: false,
    source: "home",
    dir: join(pluginsHome(), "hello"),
    installed: true,
    trusted: true,
    enabled: true,
    active: true,
    permissions: ["data:read"],
  });
  expect(hello.error).toBeUndefined();
  expect(hello.rev).toMatch(/^[0-9a-f]{16}$/);
  expect(hello.client).toBe(clientUrl("hello", hello.rev!));

  // The browser half: served immutable at its revision, checked otherwise.
  const res = (await get(hello.client!))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("etag")).toBe(`"${hello.rev}"`);
  const code = await res.text();
  // Built over the app's React: the shim reads the page global, and no bare
  // specifier or bundled React is left.
  expect(code).toContain('globalThis.__specdriven?.modules?.["react"]');
  expect(code).toContain('globalThis.__specdriven?.modules?.["react/jsx-runtime"]');
  expect(code).not.toMatch(/from\s*["']react/);
  expect(code).not.toContain("ReactSharedInternals");
  expect((await get("/plugins/hello/client.js"))!.headers.get("cache-control")).toBe("no-cache");
  expect((await get("/plugins/hello/client.js?rev=stale"))!.headers.get("cache-control")).toBe("no-cache");
  expect((await get(hello.client!, { "if-none-match": `"${hello.rev}"` }))!.status).toBe(304);
  expect((await get("/plugins/nope/client.js"))!.status).toBe(404);
  expect((await get("/plugins/%2E%2E%2Fhello/client.js"))!.status).toBe(404);
});

test("an edit rebuilds the plugin under a new revision and remounts it", async () => {
  const dir = await fixture(join(pluginsHome(), "hello"), "hello");
  const state: Record<string, unknown> = {};
  await syncPlugins(state, { sources: true, dataDir: null });
  const before = row("hello")!;

  await fixture(dir, "hello", { greeting: "again" });
  await rebuildPlugin("hello");
  const after = row("hello")!;
  expect(after.rev).not.toBe(before.rev);
  expect(after.active).toBe(true);
  expect(await (await get("/api/hello"))!.json()).toEqual({ greeting: "again" });
  // The old url is no longer the current build: served, but not for good.
  expect((await get(before.client!))!.headers.get("cache-control")).toBe("no-cache");
  expect((await get(after.client!))!.headers.get("cache-control")).toContain("immutable");

  // An edit that breaks the build keeps the old mount and shows the error.
  await writeFile(join(dir, "src", "host.ts"), "export default { name: 'hello', apply( {");
  await rebuildPlugin("hello");
  expect(row("hello")!.error).toContain("build failed");
  expect(row("hello")!.active).toBe(true);
  expect(await (await get("/api/hello"))!.json()).toEqual({ greeting: "again" });
});

test.skipIf(process.platform === "linux")("the app watches a plugin under development and rebuilds it as it is edited", async () => {
  const dir = await fixture(join(pluginsHome(), "hello"), "hello");
  await syncPlugins({}, { sources: true, dataDir: null });
  const before = row("hello")!.rev;
  await new Promise((r) => setTimeout(r, 150));
  await fixture(dir, "hello", { greeting: "watched" });
  const deadline = Date.now() + 5000;
  while (row("hello")!.rev === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(row("hello")!.rev).not.toBe(before);
  expect(await (await get("/api/hello"))!.json()).toEqual({ greeting: "watched" });
});

test("switching a folder plugin off unwinds its routes, and on mounts it again", async () => {
  await fixture(join(pluginsHome(), "hello"), "hello");
  const opts = { sources: true, dataDir: null };
  await syncPlugins({}, opts);
  expect(matchApi("GET", "/api/hello")).not.toBeNull();

  // Seen before and switched off: stays off, still installed, still served.
  await syncPlugins({ plugins: { enabled: [], seen: ["hello"] } }, opts);
  expect(matchApi("GET", "/api/hello")).toBeNull();
  expect(row("hello")).toMatchObject({ installed: true, enabled: false, active: false });
  expect(shell.matches("/hello")).toBe(true);

  await syncPlugins({ plugins: { enabled: ["hello"], seen: ["hello"] } }, opts);
  expect(matchApi("GET", "/api/hello")).not.toBeNull();
  expect(row("hello")).toMatchObject({ enabled: true, active: true });
});

test("a plugin whose folder goes away is unwound and reported", async () => {
  const dir = await fixture(join(pluginsHome(), "hello"), "hello");
  const state: Record<string, unknown> = {};
  const opts = { sources: true, dataDir: null };
  await syncPlugins(state, opts);
  await rm(dir, { recursive: true, force: true });
  await syncPlugins(state, opts);
  expect(matchApi("GET", "/api/hello")).toBeNull();
  expect(shell.matches("/hello")).toBe(false);
  expect(row("hello")).toMatchObject({
    installed: false,
    error: "No installed plugin has this id; it is listed in the profile and ignored.",
  });
});

test("a manifest the app cannot accept is refused with the reason, and loads nothing", async () => {
  await fixture(join(pluginsHome(), "future"), "future", { manifest: { api: "2" } });
  await fixture(join(pluginsHome(), "newer"), "newer", { manifest: { minAppVersion: "99.0.0" } });
  await fixture(join(pluginsHome(), "off"), "off", { manifest: { defaultEnabled: false } });
  await fixture(join(pluginsHome(), "twin"), "tests");
  await mkdir(join(pluginsHome(), "notaplugin"), { recursive: true });
  await writeFile(join(pluginsHome(), "broken", "package.json").replace("/broken/", "/"), "");
  const state: Record<string, unknown> = {};
  await syncPlugins(state, { sources: true, dataDir: null });
  expect((state.plugins as { enabled: string[] }).enabled).toEqual(["notebook"]);
  expect(row("future")).toMatchObject({ enabled: false, active: false });
  expect(row("future")!.error).toBe("the plugin needs plugin api 2; this app speaks api 1");
  expect(row("newer")!.error).toMatch(/needs SpecDriven 99\.0\.0 or newer/);
  // Off by its own choice: installed and remembered, not on.
  expect(row("off")).toMatchObject({ installed: true, enabled: false });
  expect((state.plugins as { seen: string[] }).seen).toEqual(["off"]);
  // A built-in's id is taken.
  expect(row("tests")).toMatchObject({ builtin: true, source: "builtin" });
  expect(pluginStates().filter((p) => p.id === "tests")).toHaveLength(1);
  expect(matchApi("GET", "/api/future")).toBeNull();
  expect(matchApi("GET", "/api/newer")).toBeNull();
  expect(row("notaplugin")).toBeUndefined();

  // The parser's own refusals.
  const bad = (specdriven: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (() => parsePackageManifest({ name: "x", version: "1.0.0", specdriven, ...extra }, "0.5.0")) as () => unknown;
  expect(() => parsePackageManifest({ name: "x" }, "0.5.0")).toThrow('no "specdriven" section');
  expect(bad({ id: "Bad Id", api: "1", host: "./dist/host.js" })).toThrow("is not a plugin id");
  expect(bad({ id: "x", host: "./dist/host.js" })).toThrow('no "api" version');
  expect(bad({ id: "x", api: "1", host: "../outside.js" })).toThrow("must stay inside the package");
  expect(bad({ id: "x", api: "1", client: "/abs/client.js" })).toThrow("must stay inside the package");
  expect(bad({ id: "x", api: "1" })).toThrow("neither a host nor a client half");
  expect(parsePackageManifest({ name: "@acme/jira-tab", version: "2.0.0", specdriven: { api: "1.3", src: { client: "./src/client.tsx" } } }, "0.5.0")).toMatchObject({
    id: "@acme/jira-tab",
    displayName: "@acme/jira-tab",
    version: "2.0.0",
    defaultEnabled: true,
  });
  expect(compareVersions("0.1.84", "0.2.0")).toBeLessThan(0);
  expect(compareVersions("v1.10.0", "1.9.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
});

test("a plugin under the data repo asks for trust before its first load", async () => {
  const dir = await fixture(join(repoPluginsDir(repo), "team"), "team");
  const state: Record<string, unknown> = {};
  const opts = { sources: true, dataDir: repo };
  await syncPlugins(state, opts);
  expect(row("team")).toMatchObject({ source: "repo", dir, installed: true, trusted: false, enabled: false, active: false });
  expect((state.plugins as { enabled: string[] } | undefined)?.enabled ?? ["notebook"]).toEqual(["notebook"]);
  expect(matchApi("GET", "/api/team")).toBeNull();

  // Trusted by its folder: found "for the first time" now, on and mounted.
  state.plugins = { enabled: ["notebook"], trusted: [dir] };
  await syncPlugins(state, opts);
  expect(row("team")).toMatchObject({ trusted: true, enabled: true, active: true });
  expect((state.plugins as { enabled: string[] }).enabled).toEqual(["notebook", "team"]);
  expect(await (await get("/api/team"))!.json()).toEqual({ greeting: "hello" });
});

test("a plugin that fails to load fails alone", async () => {
  await fixture(join(pluginsHome(), "hello"), "hello");
  await fixture(join(pluginsHome(), "broken"), "broken", { throws: "boom at apply" });
  const state: Record<string, unknown> = {};
  await syncPlugins(state, { sources: true, dataDir: null });
  expect(row("hello")).toMatchObject({ active: true });
  expect(row("broken")).toMatchObject({ enabled: true, active: false, error: "boom at apply" });
  expect(matchApi("GET", "/api/hello")).not.toBeNull();
  expect(matchApi("GET", "/api/broken")).toBeNull();
  // The built-ins are untouched.
  expect(row("notebook")).toMatchObject({ active: true });
});

test("a runtime that cannot build loads dist/ only, and refuses a bundle with its own React", async () => {
  setBuildDisabled(true);
  // Sources only: nothing to load, and the way out is named.
  await fixture(join(pluginsHome(), "srconly"), "srconly");
  // Prebuilt halves, as `specdriven plugin build` writes them.
  const built = join(pluginsHome(), "built");
  await mkdir(join(built, "dist"), { recursive: true });
  await writeFile(
    join(built, "package.json"),
    JSON.stringify({ name: "built", version: "3.0.0", specdriven: { id: "built", api: "1", host: "./dist/host.js", client: "./dist/client.js" } }),
  );
  await writeFile(
    join(built, "dist", "host.js"),
    `export default { name: "built", inject: ["routes"], apply(ctx) { ctx.effect(() => ctx.need("routes").add("GET", "/api/built", () => Response.json({ ok: true }))); } };`,
  );
  await writeFile(join(built, "dist", "client.js"), `const m = globalThis.__specdriven.modules["react"]; export default { name: "built", apply() {} };`);
  // A bundle that brought React along.
  const selfish = join(pluginsHome(), "selfish");
  await mkdir(join(selfish, "dist"), { recursive: true });
  await writeFile(join(selfish, "package.json"), JSON.stringify({ name: "selfish", version: "1.0.0", specdriven: { id: "selfish", api: "1", client: "./dist/client.js" } }));
  await writeFile(join(selfish, "dist", "client.js"), `var ReactSharedInternals = {}; export default { name: "selfish", apply() {} };`);
  // A bundle that still names react.
  const bare = join(pluginsHome(), "bare");
  await mkdir(join(bare, "dist"), { recursive: true });
  await writeFile(join(bare, "package.json"), JSON.stringify({ name: "bare", version: "1.0.0", specdriven: { id: "bare", api: "1", client: "./dist/client.js" } }));
  await writeFile(join(bare, "dist", "client.js"), `import { useState } from "react";\nexport default { name: "bare", apply() {} };`);

  const state: Record<string, unknown> = {};
  await syncPlugins(state, { sources: true, dataDir: null });
  expect(row("srconly")!.error).toBe("no prebuilt dist/ to load; build this plugin with `specdriven plugin build`");
  expect(row("built")).toMatchObject({ version: "3.0.0", active: true });
  expect(await (await get("/api/built"))!.json()).toEqual({ ok: true });
  expect((await get(row("built")!.client!))!.status).toBe(200);
  expect(row("selfish")!.error).toMatch(/carries its own React/);
  expect(row("selfish")!.client).toBeUndefined();
  expect(row("bare")!.error).toMatch(/imports react by name/);
});

test("the browser loader imports a served bundle and remounts it at a new revision", async () => {
  // A bundle at a url the loader imports — a file here, the bundle route in
  // the browser — one file per revision, as the route's `?rev=` is.
  const bundle = async (rev: string, title: string) => {
    const file = join(home, `ext-${rev}.js`);
    await writeFile(
      file,
      `export default { name: "ext", inject: ["tabs"], apply(ctx) { ctx.effect(() => ctx.need("tabs").add({ id: "ext", title: ${JSON.stringify(title)}, icon: () => null, order: 1, route: { match: () => null, path: () => "/ext", key: () => "ext", title: () => "ext", home: {} }, Sidebar: () => null, Pane: () => null })); } };`,
    );
    return pathToFileURL(file).href;
  };
  const one = await bundle("r1", "one");
  const two = await bundle("r2", "two");
  await syncClientPlugins([{ id: "ext", enabled: true, active: true, client: one, rev: "r1" }]);
  expect(tabs.get("ext")?.title).toBe("one");
  // The same revision stays mounted; a new one is imported afresh.
  await syncClientPlugins([{ id: "ext", enabled: true, active: true, client: one, rev: "r1" }]);
  expect(tabs.get("ext")?.title).toBe("one");
  await syncClientPlugins([{ id: "ext", enabled: true, active: true, client: two, rev: "r2" }]);
  expect(tabs.get("ext")?.title).toBe("two");
  // The host half failed: the browser mounts nothing for it.
  await syncClientPlugins([{ id: "ext", enabled: true, active: false, client: two, rev: "r2" }]);
  expect(tabs.get("ext")).toBeUndefined();
  // A bundle that is not a plugin is reported for Settings → Plugins.
  const junk = join(home, "junk.js");
  await writeFile(junk, "export const nothing = 1;");
  await syncClientPlugins([{ id: "ext", enabled: true, active: true, client: pathToFileURL(junk).href, rev: "r3" }]);
  expect(tabs.get("ext")).toBeUndefined();
  expect(clientLoadErrors.snapshot().get("ext")).toContain("default export is not a plugin");
});
