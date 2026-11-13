// Released plugins on the host (specs/app/plugins.feature.md "A plugin is
// released as a versioned zip in its release folder", "Any released version
// of a plugin can be installed", "A plugin rolled back to an older version
// stays there until the user updates it", "A release whose checksum does
// not match is refused", "An app too old for the newest release installs
// the newest one it can run"): a marketplace whose plugin has a `release`
// folder lists its versions, installs the newest this app can run from its
// zip, installs or switches to any version asked for — an older one held,
// with no update offered, and put back without the network — and refuses a
// zip that is not what `releases.json` says, leaving nothing behind. A
// version that will not load ("A plugin that fails after an update offers
// its previous version") is rolled back, and loads, without a restart.

import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { readState, writeState } from "../src/server/state";
import { startupUpdates } from "../src/plugins/host/autoInstall";
import { setBuildDisabled } from "../src/plugins/host/build";
import { pluginStates, stopWatching, syncPlugins } from "../src/plugins/host/loader";
import { pluginsHome } from "../src/plugins/host/sources";
import { zipEntries } from "../src/plugins/host/zip";
import { INSTALL_RECORD_FILE, releaseFileName, type InstallRecord, type PluginRelease } from "../src/plugins/marketplace";

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
  root = await mkdtemp(join(tmpdir(), "specdriven-release-root-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-release-home-"));
  work = await mkdtemp(join(tmpdir(), "specdriven-release-work-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  // A release ships dist/: the loader in node mode, as the desktop app runs it.
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
const text = (s: string) => new TextEncoder().encode(s);

/** A plugin's files: a manifest naming dist/, a host route answering its version and where it came from. */
function pluginFiles(id: string, version: string, from: string, manifest: Record<string, unknown> = {}) {
  return [
    {
      path: "package.json",
      data: text(
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
            permissions: ["data:read"],
            ...manifest,
          },
        }),
      ),
    },
    {
      path: "dist/host.js",
      data: text(`export default { name: ${JSON.stringify(id)}, inject: ["routes"], apply(ctx) {
        ctx.effect(() => ctx.need("routes").add("GET", ${JSON.stringify(`/api/${id}`)}, () =>
          Response.json({ version: ${JSON.stringify(version)}, from: ${JSON.stringify(from)} })));
      } };`),
    },
    { path: "dist/client.js", data: text(`export default { name: ${JSON.stringify(id)}, apply() {} };`) },
  ];
}

interface Released {
  version: string;
  /** What the zip's own manifest adds (`minAppVersion`, …). */
  manifest?: Record<string, unknown>;
  /** Fields of the releases.json row, over what the zip gives. */
  entry?: Partial<PluginRelease>;
  /** The version the zip's manifest claims, when not the row's. */
  holds?: string;
  /** The zip's host half throws as it loads. */
  broken?: boolean;
}

/**
 * A marketplace repository whose plugins each have a source folder (at their
 * first listed version, answering "folder") and a `release` folder: one zip
 * per version (answering "zip") and releases.json.
 */
async function marketplaceRepo(dir: string, plugins: Record<string, Released[] | null>, releasesJson?: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  const fresh = !(await stat(join(dir, ".git")).catch(() => null));
  if (fresh) await $`git init -q -b main ${dir}`.quiet();
  const rows = [];
  for (const [name, releases] of Object.entries(plugins)) {
    const folder = join(dir, "plugins", name);
    const newest = releases?.[0]?.version ?? "1.0.0";
    for (const file of pluginFiles(name, newest, "folder")) {
      await mkdir(join(folder, file.path, ".."), { recursive: true });
      await writeFile(join(folder, file.path), file.data);
    }
    rows.push({ name, source: `./plugins/${name}`, description: `${name}`, version: newest, api: "1" });
    if (!releases) continue;
    await rm(join(folder, "release"), { recursive: true, force: true });
    await mkdir(join(folder, "release"), { recursive: true });
    const listed = [];
    for (const r of releases) {
      const zip = zipEntries(
        pluginFiles(name, r.holds ?? r.version, "zip", r.manifest).map((f) =>
          r.broken && f.path === "dist/host.js" ? { ...f, data: text('throw new Error("this version is broken");') } : f,
        ),
      );
      const file = releaseFileName(name, r.version);
      await writeFile(join(folder, "release", file), zip);
      listed.push({
        version: r.version,
        file,
        sha256: createHash("sha256").update(zip).digest("hex"),
        size: zip.length,
        date: "2026-11-13",
        api: "1",
        ...(typeof r.manifest?.minAppVersion === "string" ? { minAppVersion: r.manifest.minAppVersion } : {}),
        ...r.entry,
      });
    }
    await writeFile(
      join(folder, "release", "releases.json"),
      releasesJson?.[name] ?? JSON.stringify({ plugin: name, releases: listed }, null, 2),
    );
  }
  await writeFile(join(dir, "marketplace.json"), JSON.stringify({ name: "Local", plugins: rows }, null, 2));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "index");
}

/** The settings file names the marketplace; the loader runs as api.ts runs it outside the demo. */
async function boot(market: string) {
  await writeState({ plugins: { enabled: [], marketplaces: [{ name: "local", source: market }] } } as never, root);
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
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
  );
const json = async (res: Response | null) => ({ status: res!.status, body: (await res!.json()) as Record<string, any> });
const install = async (name: string, version?: string) => {
  const staged = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name, step: "stage", version }));
  if (staged.status !== 200) return staged;
  return json(await api("POST", "/api/plugins/install", { marketplace: "local", name, step: "confirm", version }));
};
const update = async (id: string, body?: unknown) => json(await api("POST", `/api/plugins/${id}/update`, body));
const answers = async (id: string) => (await json(await api("GET", `/api/${id}`))).body;
const record = async (id: string) => JSON.parse(await readFile(join(pluginsHome(), id, INSTALL_RECORD_FILE), "utf8")) as InstallRecord;
const leftovers = async () => ({
  installed: (await readdir(pluginsHome()).catch(() => [])).filter((n) => !n.startsWith(".")),
  staged: await readdir(join(pluginsHome(), ".staging")).catch(() => []),
});
const offered = async () => startupUpdates((await readState(root)) as Record<string, unknown>);

const versions: Released[] = [
  // Newest first, as releases.json keeps them; the newest needs an app that is not out.
  { version: "2.0.0", manifest: { minAppVersion: "999.0.0" } },
  { version: "1.2.0" },
  { version: "1.1.0" },
  { version: "1.0.0" },
];

// ---- listing ---------------------------------------------------------------------

test("the marketplace lists a plugin's released versions, newest first, with why this app cannot run one", async () => {
  const market = join(work, "market");
  await marketplaceRepo(
    market,
    {
      hello: [...versions].reverse(),
      plain: null,
      broken: [{ version: "1.0.0" }],
      gone: [{ version: "1.1.0", entry: { yanked: "loses settings" } }, { version: "1.0.0" }],
    },
    { broken: JSON.stringify({ releases: [{ version: "1.0.0", file: "../escape.zip", sha256: "0".repeat(64) }] }) },
  );
  await boot(market);

  const { body } = await json(await api("GET", "/api/plugins/marketplaces"));
  const rows = Object.fromEntries(body.marketplaces[0].index.plugins.map((p: any) => [p.name, p]));
  // Sorted by version whatever order the file has them in.
  expect(rows.hello.releases.map((r: PluginRelease) => r.version)).toEqual(["2.0.0", "1.2.0", "1.1.0", "1.0.0"]);
  expect(rows.hello.releases[0].refusal).toMatch(/version 2\.0\.0 needs SpecDriven 999\.0\.0 or newer/);
  expect(rows.hello.releases[1]).toMatchObject({ file: "hello-1.2.0.zip", date: "2026-11-13", api: "1" });
  expect(rows.hello.releases[1].refusal).toBeUndefined();
  expect(rows.hello.releases[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  // A plugin with no release folder is listed as before.
  expect(rows.plain.releases).toBeUndefined();
  expect(rows.plain.releasesError).toBeUndefined();
  // A releases.json the app cannot use is reported on its own row.
  expect(rows.broken.releases).toBeUndefined();
  expect(rows.broken.releasesError).toMatch(/release\/releases\.json: .*not a zip in the release folder/);
  expect(rows.gone.releases[0].refusal).toMatch(/version 1\.1\.0 was withdrawn: loses settings/);

  // Nothing of the broken one installs; the plain one installs from its folder.
  const refused = await install("broken");
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/releases\.json/);
  expect((await install("plain")).status).toBe(200);
  expect(await answers("plain")).toEqual({ version: "1.0.0", from: "folder" });
  // …and has no versions to pick from.
  expect((await update("plain", { version: "0.9.0" })).body.error).toMatch(/no released versions to pick from/);
  // A withdrawn version is passed over for the newest good one.
  expect((await install("gone")).status).toBe(200);
  expect(await answers("gone")).toEqual({ version: "1.0.0", from: "zip" });
});

// ---- installing ---------------------------------------------------------------------

test("Install unpacks the newest version this app can run from its zip", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: versions });
  await boot(market);

  const staged = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "stage" }));
  expect(staged.status).toBe(200);
  // 2.0.0 needs a newer app: the consent step shows the one that runs here.
  expect(staged.body.preview).toMatchObject({ id: "hello", version: "1.2.0", permissions: ["data:read"] });
  expect((await leftovers()).installed).toEqual([]);

  const confirmed = await json(await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm" }));
  expect(confirmed.status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.2.0", from: "zip" });
  const rec = await record("hello");
  expect(rec).toMatchObject({ marketplace: "local", name: "hello", version: "1.2.0" });
  expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(rec.held).toBeUndefined();
  expect(rec.previous).toBeUndefined();
  // Only what the zip holds, and the record: no release folder comes along.
  expect((await readdir(join(pluginsHome(), "hello"))).sort()).toEqual([INSTALL_RECORD_FILE, "dist", "package.json"].sort());
  // Nothing newer that runs here: no update is offered.
  expect(await offered()).toEqual([]);
});

test("any released version can be installed, and an older one is held with no update offered", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: versions });
  await boot(market);

  const staged = await json(
    await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "stage", version: "1.0.0" }),
  );
  expect(staged.body.preview).toMatchObject({ id: "hello", version: "1.0.0" });
  // Confirming another version than the one staged stages that one instead.
  const confirmed = await json(
    await api("POST", "/api/plugins/install", { marketplace: "local", name: "hello", step: "confirm", version: "1.1.0" }),
  );
  expect(confirmed.status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });
  expect(await record("hello")).toMatchObject({ version: "1.1.0", held: true });
  expect(await offered()).toEqual([]);

  // A version that is not released, or that this app cannot run, is refused with the reason.
  expect((await update("hello", { version: "3.0.0" })).body.error).toMatch(/hello has no released version 3\.0\.0/);
  expect((await update("hello", { version: "2.0.0" })).body.error).toMatch(/needs SpecDriven 999\.0\.0 or newer/);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });
});

// ---- switching ----------------------------------------------------------------------

test("a plugin rolled back is held at that version and remembers the one it replaced; Update moves it on", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: versions });
  await boot(market);
  expect((await install("hello")).status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.2.0", from: "zip" });

  const back = await update("hello", { version: "1.0.0" });
  expect(back.status).toBe(200);
  expect(back.body.install).toMatchObject({ version: "1.0.0", previous: "1.2.0", held: true });
  // Remounted at once: the older version answers.
  expect(await answers("hello")).toEqual({ version: "1.0.0", from: "zip" });
  expect(await record("hello")).toMatchObject({ version: "1.0.0", previous: "1.2.0", held: true });
  // Held: the start offers no update though 1.2.0 is newer.
  expect(await offered()).toEqual([]);

  // Update, with no version, goes to the newest this app runs and lets go of the hold.
  const forward = await update("hello");
  expect(forward.status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.2.0", from: "zip" });
  const rec = await record("hello");
  expect(rec).toMatchObject({ version: "1.2.0", previous: "1.0.0" });
  expect(rec.held).toBeUndefined();
});

test("a version this machine already has the zip of is put back without the network", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: versions });
  await boot(market);
  expect((await install("hello")).status).toBe(200);

  // The marketplace cannot be reached any more.
  await rm(market, { recursive: true, force: true });
  const back = await update("hello", { version: "1.1.0" });
  expect(back.status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });
  // An update to whatever is newest has to ask the marketplace, and says it could not.
  const forward = await update("hello");
  expect(forward.status).toBe(400);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });
});

test("a plugin on a version that was withdrawn is offered the newest good one at start, held or not", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: [{ version: "1.1.0" }, { version: "1.0.0" }] });
  await boot(market);
  expect((await install("hello")).status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });

  await marketplaceRepo(market, { hello: [{ version: "1.1.0", entry: { yanked: "loses settings" } }, { version: "1.0.0" }] });
  await api("GET", "/api/plugins/marketplaces?refresh=1");
  expect(await offered()).toEqual([
    { id: "hello", displayName: "The hello plugin", marketplace: "local", from: "1.1.0", to: "1.0.0" },
  ]);
  expect((await update("hello")).status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.0.0", from: "zip" });
  // Moved there by the update, not picked: it is not held.
  expect((await record("hello")).held).toBeUndefined();
  expect(await offered()).toEqual([]);
});

// ---- refusing -----------------------------------------------------------------------

test("a zip that is not what releases.json says is refused and nothing is left behind", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, {
    // The checksum listed is not the zip's.
    tampered: [{ version: "1.0.0", entry: { sha256: "a".repeat(64) } }],
    // The zip's manifest claims another version than its row.
    mislabelled: [{ version: "1.0.0", holds: "9.9.9" }],
    // The list names a zip that is not there.
    missing: [{ version: "1.0.0", entry: { file: "missing-0.0.1.zip" } }],
    hello: [{ version: "1.1.0" }, { version: "1.0.0" }],
  });
  await boot(market);

  const tampered = await install("tampered");
  expect(tampered.status).toBe(400);
  expect(tampered.body.error).toMatch(/tampered-1\.0\.0\.zip does not match its checksum in releases\.json; nothing was installed/);
  const mislabelled = await install("mislabelled");
  expect(mislabelled.status).toBe(400);
  expect(mislabelled.body.error).toMatch(/mislabelled-1\.0\.0\.zip holds version 9\.9\.9, not 1\.0\.0/);
  const missing = await install("missing");
  expect(missing.status).toBe(400);
  expect(missing.body.error).toMatch(/missing-0\.0\.1\.zip is not in the marketplace's release folder/);
  expect(await leftovers()).toEqual({ installed: [], staged: [] });

  // A switch to a bad zip leaves the installed version running.
  expect((await install("hello")).status).toBe(200);
  await writeFile(join(home, "marketplaces", "local", "plugins", "hello", "release", "hello-1.0.0.zip"), "not the zip");
  const back = await update("hello", { version: "1.0.0" });
  expect(back.status).toBe(400);
  expect(back.body.error).toMatch(/does not match its checksum/);
  expect(await answers("hello")).toEqual({ version: "1.1.0", from: "zip" });
  expect((await leftovers()).staged).toEqual([]);
});

test("a version that fails to load is rolled back to the one it replaced, which loads without a restart", async () => {
  const market = join(work, "market");
  await marketplaceRepo(market, { hello: [{ version: "1.0.0" }] });
  await boot(market);
  expect((await install("hello")).status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.0.0", from: "zip" });

  // 1.1.0 is released, and its host half throws as it loads.
  await marketplaceRepo(market, { hello: [{ version: "1.1.0", broken: true }, { version: "1.0.0" }] });
  const forward = await update("hello");
  expect(forward.status).toBe(200);
  expect(forward.body.install).toMatchObject({ version: "1.1.0", previous: "1.0.0" });
  const failed = pluginStates().find((p) => p.id === "hello")!;
  expect(failed).toMatchObject({ version: "1.1.0", active: false });
  expect(failed.error).toMatch(/loading the host half: this version is broken/);
  expect(await api("GET", "/api/hello")).toBeNull();

  // What "Roll back" asks for: the version the record remembers.
  const back = await update("hello", { version: (await record("hello")).previous });
  expect(back.status).toBe(200);
  expect(back.body.plugin).toMatchObject({ version: "1.0.0", active: true });
  expect(back.body.plugin.error).toBeUndefined();
  expect(await answers("hello")).toEqual({ version: "1.0.0", from: "zip" });
  expect(await record("hello")).toMatchObject({ version: "1.0.0", previous: "1.1.0", held: true });
  // Held off the broken version: the start does not offer it again.
  expect(await offered()).toEqual([]);

  // A fixed 1.1.1 is released: Update moves past the broken one and loads.
  await marketplaceRepo(market, { hello: [{ version: "1.1.1" }, { version: "1.1.0", broken: true }, { version: "1.0.0" }] });
  expect((await update("hello")).status).toBe(200);
  expect(await answers("hello")).toEqual({ version: "1.1.1", from: "zip" });
});
