// The marketplace (specs/app/plugins.feature.md "The marketplace is a git
// repository with an index", "A plugin from the marketplace is installed
// with consent"): a marketplace repository is cloned into a temporary home
// through the app's git engine and its index listed, with a broken
// marketplace reported on its own row; a plugin is staged and described
// before anything is installed, refused with nothing left behind when the
// app cannot run it, installed pinned to the ref the index names on
// confirmation — its tab in the profile and its routes answering at once —
// updated to the ref the index names now, and removed with its folder.
// The demo installs its own at start and lets a visitor browse, no more.

import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi } from "../src/server/api";
import { setGitEngine, type GitEngine } from "../src/server/git";
import { readState, writeState } from "../src/server/state";
import { pluginStates, rescanPlugins, stopWatching, syncPlugins } from "../src/plugins/host/loader";
import { setBuildDisabled } from "../src/plugins/host/build";
import { DEMO_MARKETPLACE_PLUGINS, installDemoPlugins } from "../src/server/demo";
import { marketplacesHome, pluginsHome } from "../src/plugins/host/sources";
import {
  INSTALL_RECORD_FILE,
  indexRowRefusal,
  marketplaceEntries,
  marketplaceNameFor,
  parseMarketplaceIndex,
  subdirectorySource,
} from "../src/plugins/marketplace";

let root: string;
let home: string;
let work: string;
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-market-root-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-market-home-"));
  work = await mkdtemp(join(tmpdir(), "specdriven-market-work-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  delete process.env.DEMO_MODE;
  // Marketplace plugins ship dist/: the loader in node mode, as the desktop app runs it.
  setBuildDisabled(true);
  setGitEngine("cli");
});

afterEach(async () => {
  stopWatching();
  await syncPlugins({ plugins: { enabled: [] } }, { sources: true, dataDir: null });
  await syncPlugins({});
  setBuildDisabled(false);
  setGitEngine(null);
  for (const dir of [root, home, work]) await rm(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ---- fixtures ------------------------------------------------------------------

const git = (dir: string, ...args: string[]) =>
  $`git -C ${dir} -c user.name=Fixture -c user.email=fixture@example.com -c commit.gpgsign=false ${args}`.quiet();

/** A prebuilt plugin folder: a manifest naming dist/, a host route answering its version. */
async function pluginFolder(dir: string, id: string, version: string, manifest: Record<string, unknown> = {}) {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: id,
      version,
      type: "module",
      specdriven: {
        id,
        api: "1",
        displayName: `The ${id} plugin`,
        description: `${id} on its own tab`,
        host: "./dist/host.js",
        client: "./dist/client.js",
        paths: [`/${id}`],
        permissions: ["data:read"],
        ...manifest,
      },
    }),
  );
  await writeFile(
    join(dir, "dist", "host.js"),
    `export default { name: ${JSON.stringify(id)}, inject: ["routes"], apply(ctx) {
      ctx.effect(() => ctx.need("routes").add("GET", ${JSON.stringify(`/api/${id}`)}, () =>
        Response.json({ version: ${JSON.stringify(version)} })));
    } };`,
  );
  await writeFile(join(dir, "dist", "client.js"), `export default { name: ${JSON.stringify(id)}, apply() {} };`);
}

/** A plugin as its own git repository, tagged v<version>. */
async function pluginRepo(dir: string, id: string, version: string, manifest: Record<string, unknown> = {}) {
  await mkdir(dir, { recursive: true });
  const fresh = !(await stat(join(dir, ".git")).catch(() => null));
  if (fresh) await $`git init -q -b main ${dir}`.quiet();
  await pluginFolder(dir, id, version, manifest);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", `v${version}`);
  await git(dir, "tag", `v${version}`);
}

interface IndexRow {
  name: string;
  source: string;
  ref?: string;
  description?: string;
  version?: string;
  category?: string;
  api?: string;
}

/** A marketplace repository: marketplace.json plus subdirectory plugins. */
async function marketplaceRepo(dir: string, rows: IndexRow[], subdirs: Record<string, { version: string; manifest?: Record<string, unknown> }> = {}) {
  await mkdir(dir, { recursive: true });
  const fresh = !(await stat(join(dir, ".git")).catch(() => null));
  if (fresh) await $`git init -q -b main ${dir}`.quiet();
  for (const [name, { version, manifest }] of Object.entries(subdirs)) {
    await pluginFolder(join(dir, "plugins", name), name, version, manifest);
  }
  await writeFile(
    join(dir, "marketplace.json"),
    JSON.stringify({ name: "Local", owner: { name: "Fixture", url: "https://example.com" }, plugins: rows }, null, 2),
  );
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "index");
}

/** The settings file names the marketplaces; the loader runs as api.ts runs it outside the demo. */
async function boot(marketplaces: { name: string; source: string }[]) {
  await writeState({ plugins: { enabled: [], marketplaces } } as never, root);
  await syncPlugins((await readState(root)) as Record<string, unknown>, {
    sources: true,
    dataDir: null,
    persist: (s) => writeState(s as never, root),
    readState: async () => (await readState(root)) as Record<string, unknown>,
  });
}

const api = (method: string, path: string, body?: unknown) =>
  handleApi(
    new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }),
  );
const json = async (res: Response | null) => ({ status: res!.status, body: (await res!.json()) as Record<string, any> });
const profile = async () => ((await readState(root)) as { plugins: { enabled: string[]; seen?: string[] } }).plugins;
const row = (id: string) => pluginStates().find((p) => p.id === id);
const installedFolders = async () => (await readdir(pluginsHome()).catch(() => [])).filter((n) => !n.startsWith("."));

// ---- the index -------------------------------------------------------------------

test("marketplace.json is read as an index, and refused when it is not one", () => {
  const index = parseMarketplaceIndex({
    name: "specdriven",
    owner: { name: "SpecDriven", url: "https://github.com/SpecDriven" },
    plugins: [
      { name: "jira-tab", source: "https://github.com/x/y", ref: "v0.3.1", description: "Jira", version: "0.3.1", category: "tabs", api: "1" },
      { name: "linear-tab", source: "./plugins/linear-tab" },
    ],
  });
  expect(index.name).toBe("specdriven");
  expect(index.owner).toEqual({ name: "SpecDriven", url: "https://github.com/SpecDriven" });
  expect(index.plugins[0]).toEqual({ name: "jira-tab", source: "https://github.com/x/y", ref: "v0.3.1", description: "Jira", version: "0.3.1", category: "tabs", api: "1" });
  expect(index.plugins[1]).toEqual({ name: "linear-tab", source: "./plugins/linear-tab", description: "" });

  expect(() => parseMarketplaceIndex([])).toThrow("not an object");
  expect(() => parseMarketplaceIndex({ plugins: [] })).toThrow("names no marketplace");
  expect(() => parseMarketplaceIndex({ name: "m" })).toThrow('"plugins"');
  expect(() => parseMarketplaceIndex({ name: "m", plugins: [{ source: "x" }] })).toThrow("has no name");
  expect(() => parseMarketplaceIndex({ name: "m", plugins: [{ name: "Bad Name", source: "x" }] })).toThrow("not a plugin id");
  expect(() => parseMarketplaceIndex({ name: "m", plugins: [{ name: "a" }] })).toThrow("no source");
  expect(() => parseMarketplaceIndex({ name: "m", plugins: [{ name: "a", source: "./../out" }] })).toThrow("leaves the marketplace");
  expect(() => parseMarketplaceIndex({ name: "m", plugins: [{ name: "a", source: "x" }, { name: "a", source: "y" }] })).toThrow("twice");
});

test("a source is a git url or a subdirectory, and an index row's api is checked before any fetch", () => {
  expect(subdirectorySource("https://github.com/x/y")).toBeNull();
  expect(subdirectorySource("git@github.com:x/y.git")).toBeNull();
  expect(subdirectorySource("./plugins/x")).toBe("plugins/x");
  expect(subdirectorySource("./plugins//x/")).toBe("plugins/x");
  expect(() => subdirectorySource("./plugins/../../x")).toThrow("leaves the marketplace");
  expect(indexRowRefusal({ name: "a", source: "x", description: "" })).toBeNull();
  expect(indexRowRefusal({ name: "a", source: "x", description: "", api: "1" })).toBeNull();
  expect(indexRowRefusal({ name: "a", source: "x", description: "", api: "2" })).toMatch(/needs plugin api 2; this app speaks api 1/);
  expect(indexRowRefusal({ name: "a", source: "x", description: "", api: "soon" })).toMatch(/not a version/);
});

test("the settings name the marketplaces; absent, the SpecDriven index; empty, none", () => {
  expect(marketplaceEntries({})).toEqual([{ name: "specdriven", source: "https://github.com/SpecDriven/plugins" }]);
  expect(marketplaceEntries({ marketplaces: [] })).toEqual([]);
  expect(marketplaceEntries({ marketplaces: [{ name: "a", source: "https://x/a" }, { name: "Bad!", source: "x" }, { name: "a", source: "dup" }, "nope"] })).toEqual([
    { name: "a", source: "https://x/a" },
  ]);
  expect(marketplaceNameFor("https://github.com/SpecDriven/plugins")).toBe("plugins");
  expect(marketplaceNameFor("git@github.com:SpecDriven/Plugins.git")).toBe("plugins");
  expect(marketplaceNameFor("/Users/me/dev/My Market/")).toBe("my-market");
  expect(marketplaceNameFor("///")).toBeNull();
});

// ---- browsing ----------------------------------------------------------------------

test("each marketplace is cloned through the git engine and its index listed; a broken one is reported on its own row", async () => {
  const good = join(work, "good");
  await marketplaceRepo(good, [{ name: "hello", source: "./plugins/hello", description: "Says hello", version: "1.0.0", category: "tabs" }], { hello: { version: "1.0.0" } });
  const broken = join(work, "broken");
  await mkdir(broken);
  await $`git init -q -b main ${broken}`.quiet();
  await writeFile(join(broken, "marketplace.json"), "{ not json");
  await git(broken, "add", "-A");
  await git(broken, "commit", "-q", "-m", "broken");
  await boot([
    { name: "good", source: good },
    { name: "broken", source: broken },
    { name: "missing", source: join(work, "nowhere") },
  ]);

  const { status, body } = await json(await api("GET", "/api/plugins/marketplaces"));
  expect(status).toBe(200);
  const by = Object.fromEntries(body.marketplaces.map((m: any) => [m.name, m]));
  expect(by.good.index).toMatchObject({ name: "Local", owner: { name: "Fixture" } });
  expect(by.good.index.plugins).toEqual([{ name: "hello", source: "./plugins/hello", description: "Says hello", version: "1.0.0", category: "tabs" }]);
  expect(by.broken.error).toMatch(/does not parse/);
  expect(by.broken.index).toBeUndefined();
  expect(by.missing.error).toMatch(/Could not clone/);
  // Cached under the home, by name.
  expect(await stat(join(marketplacesHome(), "good", ".git")).then(() => true)).toBe(true);

  // A marketplace whose index was pushed after the clone is pulled on Browse.
  const late = join(work, "late");
  await mkdir(late);
  await $`git init -q -b main ${late}`.quiet();
  await writeFile(join(late, "README.md"), "soon\n");
  await git(late, "add", "-A");
  await git(late, "commit", "-q", "-m", "empty");
  await writeState({ plugins: { enabled: [], marketplaces: [{ name: "late", source: late }] } } as never, root);
  expect((await json(await api("GET", "/api/plugins/marketplaces"))).body.marketplaces[0].error).toMatch(/no marketplace.json/);
  await marketplaceRepo(late, [{ name: "hello", source: "./plugins/hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  expect((await json(await api("GET", "/api/plugins/marketplaces"))).body.marketplaces[0].index.plugins).toHaveLength(1);
  await writeState({ plugins: { enabled: [], marketplaces: [{ name: "good", source: good }, { name: "broken", source: broken }] } } as never, root);

  // Refresh pulls: a row added upstream shows up.
  await marketplaceRepo(good, [
    { name: "hello", source: "./plugins/hello", version: "1.0.0" },
    { name: "later", source: "./plugins/later", version: "0.1.0" },
  ], { hello: { version: "1.0.0" }, later: { version: "0.1.0" } });
  const cached = await json(await api("GET", "/api/plugins/marketplaces"));
  expect(cached.body.marketplaces.find((m: any) => m.name === "good").index.plugins).toHaveLength(1);
  const refreshed = await json(await api("GET", "/api/plugins/marketplaces?refresh=1"));
  expect(refreshed.body.marketplaces.find((m: any) => m.name === "good").index.plugins.map((p: any) => p.name)).toEqual(["hello", "later"]);
});

// ---- installing ----------------------------------------------------------------------

test("a subdirectory plugin is staged and described first, and installed only on confirmation", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", description: "Says hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  await boot([{ name: "local", source: market }]);

  // The consent step: the manifest's name, version, description and permissions.
  const staged = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "stage" }));
  expect(staged.status).toBe(200);
  expect(staged.body.preview).toMatchObject({
    id: "hello",
    displayName: "The hello plugin",
    description: "hello on its own tab",
    version: "1.0.0",
    permissions: ["data:read"],
    marketplace: "local",
    name: "hello",
  });
  expect(staged.body.preview.commit).toMatch(/^[0-9a-f]{40}$/);
  // Nothing installed yet: no folder under the plugins home, nothing in the profile.
  expect(await installedFolders()).toEqual([]);
  expect((await profile()).enabled).toEqual([]);
  expect(matchApi("GET", "/api/hello")).toBeNull();

  // Cancel throws the staged copy away.
  await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "cancel" });
  expect(await readdir(join(pluginsHome(), ".staging")).catch(() => [])).toEqual([]);

  // Confirm (staging again on its own): the folder, its record, the profile, the route.
  const done = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm" }));
  expect(done.status).toBe(200);
  expect(done.body.id).toBe("hello");
  expect(done.body.plugin).toMatchObject({ id: "hello", enabled: true, active: true, source: "home", install: { marketplace: "local", name: "hello", version: "1.0.0" } });
  expect(await installedFolders()).toEqual(["hello"]);
  const record = JSON.parse(await readFile(join(pluginsHome(), "hello", INSTALL_RECORD_FILE), "utf8"));
  expect(record).toMatchObject({ marketplace: "local", name: "hello", source: "./plugins/hello", version: "1.0.0" });
  expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  expect((await profile()).enabled).toEqual(["hello"]);
  expect(await (await api("GET", "/api/hello"))!.json()).toEqual({ version: "1.0.0" });

  // Installing again is refused; Update is for that.
  const again = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "stage" }));
  expect(again.status).toBe(400);
  expect(again.body.error).toMatch(/already installed/);
});

test("a plugin the app cannot run is refused with the reason and nothing is left behind", async () => {
  const market = join(work, "market");
  await marketplaceRepo(
    market,
    [
      { name: "future", source: "./plugins/future" },
      { name: "newer", source: "./plugins/newer" },
      { name: "claimed", source: "./plugins/claimed", api: "2" },
      { name: "ghost", source: "./plugins/ghost" },
      { name: "tests", source: "./plugins/tests" },
    ],
    {
      future: { version: "1.0.0", manifest: { api: "2" } },
      newer: { version: "1.0.0", manifest: { minAppVersion: "99.0.0" } },
      claimed: { version: "1.0.0" },
      tests: { version: "1.0.0" },
    },
  );
  await boot([{ name: "local", source: market }]);

  const refusal = async (name: string) => {
    const { status, body } = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name, step: "stage" }));
    expect(status).toBe(400);
    return body.error as string;
  };
  expect(await refusal("future")).toMatch(/needs plugin api 2; this app speaks api 1/);
  expect(await refusal("newer")).toMatch(/needs SpecDriven 99\.0\.0 or newer/);
  expect(await refusal("claimed")).toMatch(/needs plugin api 2/);
  expect(await refusal("ghost")).toMatch(/has no package.json/);
  expect(await refusal("tests")).toMatch(/belongs to a built-in plugin/);
  expect(await refusal("nope")).toMatch(/lists no plugin named "nope"/);
  expect(await installedFolders()).toEqual([]);
  expect(await readdir(join(pluginsHome(), ".staging")).catch(() => [])).toEqual([]);
  expect((await profile()).enabled).toEqual([]);
  // A confirmation without a staged copy stages itself and is refused the same way.
  const confirmed = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "future", step: "confirm" }));
  expect(confirmed.status).toBe(400);
  expect(await installedFolders()).toEqual([]);
});

for (const engine of ["cli", "js"] as GitEngine[]) {
  test(`a git-url plugin is installed pinned to the ref the index names, updated to the ref it names now, and removed (${engine} engine)`, async () => {
    const repo = join(work, "remote-plugin");
    await pluginRepo(repo, "remote", "1.0.0");
    const market = join(work, "market");
    await marketplaceRepo(market, [{ name: "remote", source: repo, ref: "v1.0.0", version: "1.0.0" }]);
    await boot([{ name: "local", source: market }]);
    setGitEngine(engine);

    const done = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "remote", step: "confirm" }));
    expect(done.status).toBe(200);
    expect(done.body.plugin).toMatchObject({ id: "remote", enabled: true, active: true, install: { marketplace: "local", name: "remote", ref: "v1.0.0", version: "1.0.0" } });
    expect(await (await api("GET", "/api/remote"))!.json()).toEqual({ version: "1.0.0" });
    const v1 = (await git(repo, "rev-parse", "v1.0.0")).stdout.toString().trim();
    expect(done.body.plugin.install.commit).toBe(v1);
    expect((await profile()).enabled).toEqual(["remote"]);

    // Upstream moves on and the index names the new ref: Update fetches it and remounts.
    await pluginRepo(repo, "remote", "1.1.0");
    await marketplaceRepo(market, [{ name: "remote", source: repo, ref: "v1.1.0", version: "1.1.0" }]);
    const updated = await json(await api("POST", "/api/plugins/remote/update"));
    expect(updated.status).toBe(200);
    const v2 = (await git(repo, "rev-parse", "v1.1.0")).stdout.toString().trim();
    expect(updated.body.install).toMatchObject({ ref: "v1.1.0", version: "1.1.0", commit: v2 });
    expect(updated.body.plugin).toMatchObject({ id: "remote", enabled: true, active: true, version: "1.1.0" });
    expect(await (await api("GET", "/api/remote"))!.json()).toEqual({ version: "1.1.0" });

    // An update whose manifest the app refuses is put back where it was.
    await pluginRepo(repo, "remote", "2.0.0", { api: "2" });
    await marketplaceRepo(market, [{ name: "remote", source: repo, ref: "v2.0.0", version: "2.0.0" }]);
    const refused = await json(await api("POST", "/api/plugins/remote/update"));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/needs plugin api 2/);
    expect((await git(join(pluginsHome(), "remote"), "rev-parse", "HEAD")).stdout.toString().trim()).toBe(v2);
    expect(await (await api("GET", "/api/remote"))!.json()).toEqual({ version: "1.1.0" });

    // Remove: off, unwound, folder gone, and forgotten so a reinstall goes on again.
    const removed = await json(await api("DELETE", "/api/plugins/remote"));
    expect(removed.status).toBe(200);
    expect(await installedFolders()).toEqual([]);
    expect(matchApi("GET", "/api/remote")).toBeNull();
    expect(row("remote")).toBeUndefined();
    expect((await profile()).enabled).toEqual([]);
    expect((await profile()).seen ?? []).toEqual([]);
  });
}

test("Remove is for marketplace installs; a linked folder is unlinked instead, and an unknown id is 404", async () => {
  const linked = join(work, "linked");
  await pluginFolder(linked, "linked", "1.0.0");
  await writeState({ plugins: { enabled: [], sources: [{ path: linked }], marketplaces: [] } } as never, root);
  await syncPlugins((await readState(root)) as Record<string, unknown>, {
    sources: true,
    dataDir: null,
    persist: (s) => writeState(s as never, root),
    readState: async () => (await readState(root)) as Record<string, unknown>,
  });
  expect(row("linked")).toMatchObject({ source: "path", enabled: true });
  const refused = await json(await api("DELETE", "/api/plugins/linked"));
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/linked folder; unlink it/);
  expect(await stat(join(linked, "package.json")).then(() => true)).toBe(true);
  expect((await json(await api("DELETE", "/api/plugins/nope"))).status).toBe(404);
  const update = await json(await api("POST", "/api/plugins/linked/update"));
  expect(update.status).toBe(400);
  expect(update.body.error).toMatch(/not installed from a marketplace/);
});

test("the settings carry the marketplaces, and GET /api/state lists them", async () => {
  await boot([]);
  expect((await json(await api("GET", "/api/state"))).body.pluginMarketplaces).toEqual([]);
  const bad = await json(await api("PUT", "/api/state", { plugins: { marketplaces: [{ name: "No Spaces", source: "x" }] } }));
  expect(bad.status).toBe(400);
  const ok = await json(await api("PUT", "/api/state", { plugins: { marketplaces: [{ name: "one", source: "https://example.com/one" }, { name: "one", source: "dup" }] } }));
  expect(ok.status).toBe(200);
  expect(ok.body.pluginMarketplaces).toEqual([{ name: "one", source: "https://example.com/one" }]);
  // No key at all reads as the default index.
  await writeState({ plugins: { enabled: [] } } as never, root);
  expect((await json(await api("GET", "/api/state"))).body.pluginMarketplaces).toEqual([
    { name: "specdriven", source: "https://github.com/SpecDriven/plugins" },
  ]);
});

test("the hosted demo browses the marketplaces, never refreshed, and changes nothing", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  await boot([{ name: "local", source: market }]);
  process.env.DEMO_MODE = "1";
  const listed = await json(await api("GET", "/api/plugins/marketplaces"));
  expect(listed.status).toBe(200);
  expect(listed.body.marketplaces[0].index.plugins.map((p: any) => p.name)).toEqual(["hello"]);
  // A row added upstream stays away: a visitor's Refresh does not pull.
  await marketplaceRepo(market, [
    { name: "hello", source: "./plugins/hello", version: "1.0.0" },
    { name: "later", source: "./plugins/later", version: "0.1.0" },
  ], { hello: { version: "1.0.0" }, later: { version: "0.1.0" } });
  const refreshed = await json(await api("GET", "/api/plugins/marketplaces?refresh=1"));
  expect(refreshed.body.marketplaces[0].index.plugins).toHaveLength(1);

  for (const [method, path] of [
    ["POST", "/api/plugins/install"],
    ["POST", "/api/plugins/x/update"],
    ["DELETE", "/api/plugins/x"],
  ] as const) {
    const { status, body } = await json(await api(method, path, method === "POST" ? {} : undefined));
    expect(status).toBe(403);
    expect(body.error).toMatch(/demo/);
  }
});

test("the hosted demo installs the Event Models from the marketplace at start and lists them on", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, [{ name: "models", source: "./plugins/models", version: "1.0.0" }], { models: { version: "1.0.0" } });
  process.env.DEMO_MODE = "1";
  await writeState(
    { plugins: { enabled: DEMO_MARKETPLACE_PLUGINS.map((p) => p.id), marketplaces: [{ name: "specdriven", source: market }] } } as never,
    root,
  );
  // Listed before the install lands: reported, not mounted.
  let state = await json(await api("GET", "/api/state"));
  expect(state.body.plugins.find((p: any) => p.id === "models")).toMatchObject({ enabled: true, active: false });

  await installDemoPlugins([{ name: "specdriven", source: market }]);
  state = await json(await api("GET", "/api/state"));
  expect(state.body.plugins.find((p: any) => p.id === "models")).toMatchObject({
    enabled: true,
    active: true,
    install: { marketplace: "specdriven", name: "models", version: "1.0.0" },
  });
  expect((await json(await api("GET", "/api/models"))).body).toEqual({ version: "1.0.0" });

  // A restart finds it installed and fetches nothing.
  await rm(market, { recursive: true, force: true });
  await installDemoPlugins([{ name: "specdriven", source: market }]);
  expect(await installedFolders()).toEqual(["models"]);
});
