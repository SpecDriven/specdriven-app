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
import { applyStartupState, autoInstalledOnStart, handleApi, matchApi, reloader, syncedOnStart } from "../src/server/api";
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
  setPermanentMarketplacesForTests,
  subdirectorySource,
} from "../src/plugins/marketplace";
import { initMarketplace, marketplaceOwnerFor } from "../src/plugins/host/marketplace";

let root: string;
let home: string;
let work: string;
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-market-root-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-market-home-"));
  work = await mkdtemp(join(tmpdir(), "specdriven-market-work-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
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

test("the settings name the marketplaces, and the SpecDriven index is always among them", () => {
  setPermanentMarketplacesForTests(null);
  try {
    const specdriven = { name: "specdriven", source: "https://github.com/SpecDriven/plugins" };
    expect(marketplaceEntries({})).toEqual([specdriven]);
    expect(marketplaceEntries({ marketplaces: [] })).toEqual([specdriven]);
    expect(marketplaceEntries({ marketplaces: [{ name: "a", source: "https://x/a" }, { name: "Bad!", source: "x" }, { name: "a", source: "dup" }, "nope"] })).toEqual([
      specdriven,
      { name: "a", source: "https://x/a" },
    ]);
    // Listed under another name, it is not listed twice and keeps its place.
    const renamed = { name: "public", source: "https://github.com/specdriven/plugins.git" };
    expect(marketplaceEntries({ marketplaces: [{ name: "a", source: "https://x/a" }, renamed] })).toEqual([
      { name: "a", source: "https://x/a" },
      renamed,
    ]);
    // A row that took its name for another url gives the name up.
    expect(marketplaceEntries({ marketplaces: [{ name: "specdriven", source: "https://x/mine" }] })).toEqual([
      specdriven,
      { name: "specdriven-2", source: "https://x/mine" },
    ]);
  } finally {
    setPermanentMarketplacesForTests([]);
  }
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

test("Refresh clones a marketplace afresh when its history was rewritten upstream, and one that cannot be reached keeps its copy", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  await boot([{ name: "local", source: market }]);
  expect((await json(await api("GET", "/api/plugins/marketplaces"))).body.marketplaces[0].index.plugins).toHaveLength(1);

  // The upstream history is rewritten: the cache can no longer be pulled,
  // so Refresh clones it afresh.
  await rm(join(market, ".git"), { recursive: true, force: true });
  await marketplaceRepo(market, [
    { name: "hello", source: "./plugins/hello", version: "1.0.0" },
    { name: "later", source: "./plugins/later", version: "0.1.0" },
  ], { hello: { version: "1.0.0" }, later: { version: "0.1.0" } });
  // A hosted worker pulls but never clones afresh: it reports the failure
  // and keeps its copy.
  process.env.SPECDRIVEN_HOSTED = "1";
  const hosted = (await json(await api("GET", "/api/plugins/marketplaces?refresh=1"))).body.marketplaces[0];
  expect(hosted.error).toMatch(/Could not refresh local/);
  expect(hosted.error).not.toMatch(/afresh/);
  expect(await readdir(marketplacesHome())).toEqual(["local"]);
  delete process.env.SPECDRIVEN_HOSTED;
  const recloned = (await json(await api("GET", "/api/plugins/marketplaces?refresh=1"))).body.marketplaces[0];
  expect(recloned.error).toBeUndefined();
  expect(recloned.index.plugins.map((p: any) => p.name)).toEqual(["hello", "later"]);
  // Refresh pulls again, and nothing is left beside the cache.
  const refreshed = (await json(await api("GET", "/api/plugins/marketplaces?refresh=1"))).body.marketplaces[0];
  expect(refreshed.error).toBeUndefined();
  expect(await readdir(marketplacesHome())).toEqual(["local"]);

  // A remote that cannot be reached is reported and leaves the old copy in place.
  await rm(market, { recursive: true, force: true });
  const failed = (await json(await api("GET", "/api/plugins/marketplaces?refresh=1"))).body.marketplaces[0];
  expect(failed.error).toMatch(/Could not refresh local: .*cloning it afresh failed: Could not clone/s);
  expect(await readdir(marketplacesHome())).toEqual(["local"]);
  expect((await json(await api("GET", "/api/plugins/marketplaces"))).body.marketplaces[0].index.plugins).toHaveLength(2);
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

  // Installing again names what it replaces, and a confirmation that does
  // not say so is refused.
  const again = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "stage" }));
  expect(again.status).toBe(200);
  expect(again.body.preview.replaces).toEqual({ id: "hello", version: "1.0.0", marketplace: "local", name: "hello" });
  const refused = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm" }));
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/already installed/);
  expect(await readdir(join(pluginsHome(), ".staging")).catch(() => [])).toEqual([]);
  expect(await (await api("GET", "/api/hello"))!.json()).toEqual({ version: "1.0.0" });
});

test("a plugin is reinstalled from a marketplace that was removed and added back under another name", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  await boot([{ name: "local", source: market }]);
  await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm" });
  expect(row("hello")).toMatchObject({ active: true, install: { marketplace: "local", version: "1.0.0" } });
  const first = JSON.parse(await readFile(join(pluginsHome(), "hello", INSTALL_RECORD_FILE), "utf8"));

  // The marketplace goes and comes back under another name, with a newer
  // plugin; the install record still names the old one, so Update cannot
  // find it, and Install sees the id installed already.
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.1.0" }], { hello: { version: "1.1.0" } });
  const state = (await readState(root)) as { plugins: Record<string, unknown> };
  await writeState({ ...state, plugins: { ...state.plugins, marketplaces: [{ name: "plugins", source: market }] } } as never, root);
  const update = await json(await api("POST", "/api/plugins/hello/update", {}));
  expect(update.status).toBe(400);
  expect(update.body.error).toMatch(/"local" is no longer configured/);

  // Reinstall: the same consent, naming what it replaces, then the swap.
  const staged = await json(await api("POST", "/api/plugins/install", { marketplace: "plugins", name: "hello", step: "stage" }));
  expect(staged.status).toBe(200);
  expect(staged.body.preview).toMatchObject({ id: "hello", version: "1.1.0", marketplace: "plugins", replaces: { id: "hello", version: "1.0.0", marketplace: "local", name: "hello" } });
  const done = await json(await api("POST", "/api/plugins/install", { marketplace: "plugins", name: "hello", step: "confirm", replace: true }));
  expect(done.status).toBe(200);
  expect(done.body).toMatchObject({ id: "hello", replaced: true, plugin: { id: "hello", enabled: true, active: true, install: { marketplace: "plugins", name: "hello", version: "1.1.0" } } });
  expect(await installedFolders()).toEqual(["hello"]);
  expect(await readdir(join(pluginsHome(), ".staging")).catch(() => [])).toEqual([]);
  const record = JSON.parse(await readFile(join(pluginsHome(), "hello", INSTALL_RECORD_FILE), "utf8"));
  expect(record).toMatchObject({ marketplace: "plugins", name: "hello", version: "1.1.0" });
  expect(record.commit).not.toBe(first.commit);
  expect((await profile()).enabled).toEqual(["hello"]);
  expect(await (await api("GET", "/api/hello"))!.json()).toEqual({ version: "1.1.0" });
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
});

// specs/app/plugins.feature.md "The SpecDriven marketplace cannot be removed".
test("the SpecDriven marketplace stays on the list whatever the settings say; the others can go", async () => {
  setPermanentMarketplacesForTests(null);
  try {
    const specdriven = { name: "specdriven", source: "https://github.com/SpecDriven/plugins" };
    // No key at all, and an empty list saved before it was permanent.
    await writeState({ plugins: { enabled: [] } } as never, root);
    expect((await json(await api("GET", "/api/state"))).body.pluginMarketplaces).toEqual([specdriven]);
    await writeState({ plugins: { enabled: [], marketplaces: [] } } as never, root);
    expect((await json(await api("GET", "/api/state"))).body.pluginMarketplaces).toEqual([specdriven]);
    const one = { name: "one", source: "https://example.com/one" };
    let res = await json(await api("PUT", "/api/state", { plugins: { marketplaces: [specdriven, one] } }));
    expect(res.body.pluginMarketplaces).toEqual([specdriven, one]);
    // Removing it is refused by putting it back; removing another one works.
    res = await json(await api("PUT", "/api/state", { plugins: { marketplaces: [one] } }));
    expect(res.status).toBe(200);
    expect(res.body.pluginMarketplaces).toEqual([specdriven, one]);
    res = await json(await api("PUT", "/api/state", { plugins: { marketplaces: [specdriven] } }));
    expect(res.body.pluginMarketplaces).toEqual([specdriven]);
    const stored = (await readState(root)) as { plugins?: { marketplaces?: unknown } };
    expect(stored.plugins?.marketplaces).toEqual([specdriven]);
  } finally {
    setPermanentMarketplacesForTests([]);
  }
});

// ---- initializing ----------------------------------------------------------------

/** A stand-in for the SpecDriven marketplace: what a new marketplace copies. */
async function templateMarketplace(dir: string) {
  await marketplaceRepo(dir, []);
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
  await writeFile(join(dir, "scripts", "check-index.ts"), "console.log('ok');\n");
  await writeFile(join(dir, ".gitignore"), ".idea\n");
  await writeFile(join(dir, "LICENSE"), "Apache\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "ci");
}

const treeOf = async (bare: string) =>
  (await $`git -C ${bare} ls-tree -r --name-only main`.text()).trim().split("\n").sort();

// specs/app/plugins.feature.md "An empty repository is initialized as a marketplace".
test("an empty repository is initialized as a marketplace: index, README and CI pushed to main", async () => {
  const template = join(work, "template");
  await templateMarketplace(template);
  setPermanentMarketplacesForTests([{ name: "specdriven", source: template }]);
  try {
    const bare = join(work, "acme-plugins.git");
    await $`git init -q --bare ${bare}`.quiet();
    await boot([]);

    const res = await json(await api("POST", "/api/plugins/marketplaces/init", { source: bare }));
    expect(res.status).toBe(200);
    expect(res.body.marketplace).toMatchObject({ name: "acme-plugins", source: bare, index: { name: "acme-plugins", plugins: [] } });

    expect(await treeOf(bare)).toEqual([
      ".github/workflows/ci.yml",
      ".gitignore",
      "README.md",
      "marketplace.json",
      "plugins/.gitkeep",
      "scripts/check-index.ts",
    ]);
    const index = parseMarketplaceIndex(JSON.parse(await $`git -C ${bare} show main:marketplace.json`.text()));
    expect(index).toMatchObject({ name: "acme-plugins", plugins: [] });
    expect(await $`git -C ${bare} show main:README.md`.text()).toContain(bare);
    expect(await $`git -C ${bare} log -1 --pretty=%s main`.text()).toBe("Initialize the acme-plugins marketplace\n");
    // The working clone is gone, and the settings are the page's to change.
    expect((await readdir(marketplacesHome()).catch(() => [])).filter((d) => d.endsWith(".init"))).toEqual([]);
    expect((await json(await api("GET", "/api/state"))).body.pluginMarketplaces).toEqual([{ name: "specdriven", source: template }]);

    // Added, it lists like any other marketplace.
    await api("PUT", "/api/state", { plugins: { marketplaces: [{ name: "acme-plugins", source: bare }] } });
    const listed = await json(await api("GET", "/api/plugins/marketplaces"));
    expect(listed.body.marketplaces.find((m: any) => m.name === "acme-plugins")).toMatchObject({ index: { name: "acme-plugins", plugins: [] } });
    // A url on the list already is refused.
    const again = await json(await api("POST", "/api/plugins/marketplaces/init", { source: bare }));
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already on the list/);
  } finally {
    setPermanentMarketplacesForTests([]);
  }
});

test("a repository with commits keeps them, and its own README", async () => {
  const template = join(work, "template");
  await templateMarketplace(template);
  const bare = join(work, "corp.git");
  await $`git init -q --bare -b main ${bare}`.quiet();
  const seed = join(work, "seed");
  await $`git clone -q ${bare} ${seed}`.quiet();
  await writeFile(join(seed, "README.md"), "# Ours\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "README");
  await git(seed, "push", "-q", "origin", "main");

  await initMarketplace(bare, { configured: [], templateDir: template });
  expect(await $`git -C ${bare} show main:README.md`.text()).toBe("# Ours\n");
  expect(await $`git -C ${bare} log --pretty=%s main`.text()).toBe("Initialize the corp marketplace\nREADME\n");
});

test("a repository that is a marketplace already, or cannot be pushed to, is refused with nothing left behind", async () => {
  const template = join(work, "template");
  await templateMarketplace(template);
  // Already a marketplace.
  await expect(initMarketplace(template, { configured: [], templateDir: template })).rejects.toThrow(
    /already has a marketplace.json/,
  );
  // A host that refuses the push: the commit never lands and nothing is kept.
  const bare = join(work, "locked.git");
  await $`git init -q --bare ${bare}`.quiet();
  const hook = join(bare, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho 'read-only for you' >&2\nexit 1\n");
  await $`chmod +x ${hook}`.quiet();
  await expect(initMarketplace(bare, { configured: [], templateDir: template })).rejects.toThrow(/Could not push to .*read-only for you/s);
  expect((await $`git -C ${bare} for-each-ref`.text()).trim()).toBe("");
  // A url that does not clone.
  await expect(initMarketplace(join(work, "nowhere.git"), { configured: [], templateDir: template })).rejects.toThrow(/Could not clone/);
  expect((await readdir(marketplacesHome()).catch(() => [])).filter((d) => d.endsWith(".init"))).toEqual([]);
});

test("a marketplace's owner is read from its url", () => {
  expect(marketplaceOwnerFor("https://github.com/acme/plugins")).toEqual({ name: "acme", url: "https://github.com/acme" });
  expect(marketplaceOwnerFor("git@github.com:acme/plugins.git")).toEqual({ name: "acme", url: "https://github.com/acme" });
  expect(marketplaceOwnerFor("https://git.acme.test/platform/plugins")).toEqual({ name: "platform" });
  expect(marketplaceOwnerFor("https://git.acme.test/plugins")).toBeUndefined();
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
    ["POST", "/api/plugins/marketplaces/init"],
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

// The start (src/server/api.ts applyStartupState, specs/app/plugins.feature.md
// "The marketplaces are refreshed on start when external plugins are
// installed"): with a marketplace plugin installed the cached index is
// pulled in the background, so Update is offered without a Refresh; with
// the built-ins alone the cache is left as it was.
async function startAfterUpstreamMoved(withExternal: boolean) {
  const noInstall = process.env.SPECDRIVEN_NO_AUTO_INSTALL;
  delete process.env.SPECDRIVEN_NO_AUTO_INSTALL;
  const market = join(work, "market");
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.0.0" }], { hello: { version: "1.0.0" } });
  await boot([{ name: "local", source: market }]);
  if (withExternal) {
    const done = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm" }));
    expect(done.status).toBe(200);
  } else {
    expect((await json(await api("GET", "/api/plugins/marketplaces"))).status).toBe(200);
  }
  const cached = async () =>
    JSON.parse(await readFile(join(marketplacesHome(), "local", "marketplace.json"), "utf8")).plugins[0].version;
  expect(await cached()).toBe("1.0.0");

  // Upstream moves on while the app is closed.
  await marketplaceRepo(market, [{ name: "hello", source: "./plugins/hello", version: "1.1.0" }], { hello: { version: "1.1.0" } });
  await writeState({ ...(await readState(root)), dataRepo: data, reloadFrequencySeconds: 0 }, root);
  try {
    await applyStartupState();
    await autoInstalledOnStart();
    expect(await cached()).toBe(withExternal ? "1.1.0" : "1.0.0");
    // The update dialog's question (specs/app/plugins.feature.md "Plugins
    // with an update are offered in a dialog at start").
    const offered = await json(await api("GET", "/api/plugins/updates"));
    expect(offered.status).toBe(200);
    expect(offered.body.updates).toEqual(
      withExternal ? [{ id: "hello", displayName: "The hello plugin", marketplace: "local", from: "1.0.0", to: "1.1.0" }] : [],
    );
    if (withExternal) {
      // Update as the dialog does it, and nothing is offered any more.
      expect((await json(await api("POST", "/api/plugins/hello/update", {}))).status).toBe(200);
      expect((await json(await api("GET", "/api/plugins/updates"))).body.updates).toEqual([]);
    }
    // Answered once, not asked again in this run.
    expect((await json(await api("POST", "/api/plugins/updates/dismiss", {}))).status).toBe(200);
    expect((await json(await api("GET", "/api/plugins/updates"))).body.updates).toEqual([]);
  } finally {
    await syncedOnStart();
    reloader.stop();
    if (noInstall === undefined) delete process.env.SPECDRIVEN_NO_AUTO_INSTALL;
    else process.env.SPECDRIVEN_NO_AUTO_INSTALL = noInstall;
  }
}

test("a start pulls the marketplaces when an external plugin is installed", () => startAfterUpstreamMoved(true));

test("a start leaves the marketplaces alone with the built-ins only", () => startAfterUpstreamMoved(false));
