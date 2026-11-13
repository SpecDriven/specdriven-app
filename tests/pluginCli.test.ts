// The developer loop (roadmap/plugin-architecture.md "Developer loop"):
// `specdriven plugin new` scaffolds a plugin the app accepts, `plugin build`
// bundles both halves into dist/ over the app's React, and `plugin link`
// puts the folder in this machine's profile — from where the loader mounts
// it like any other folder plugin. `plugin release` (specs/app/plugins
// .feature.md "A plugin is released as a versioned zip in its release
// folder") then builds it and adds its version to the release folder.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runPluginCli } from "../src/plugins/cli";
import { parsePackageManifest } from "../src/plugins/manifest";
import { RELEASE_DIR, RELEASES_FILE, RELEASES_KEPT, parseReleases } from "../src/plugins/marketplace";
import { unzip } from "../src/plugins/host/zip";
import { pluginStates, shell, stopWatching, syncPlugins } from "../src/plugins/host/loader";
import { matchApi } from "../src/server/api";
import { readState, statePath } from "../src/server/state";
import { readSettings } from "./helpers/settingsFile";
import { version as appVersion } from "../package.json";

let work: string;
let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const lines: string[] = [];
const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`! ${l}`) };

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "specdriven-cli-"));
  root = await mkdtemp(join(tmpdir(), "specdriven-cli-root-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-cli-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  lines.length = 0;
});

afterEach(async () => {
  stopWatching();
  await syncPlugins({ plugins: { enabled: [] } }, { sources: true, dataDir: null });
  await syncPlugins({});
  for (const dir of [work, root, home]) await rm(dir, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("plugin new, build and link take a plugin from nothing to a mounted tab", async () => {
  const dir = join(work, "demo-tab");
  expect(await runPluginCli(["new", "demo-tab", dir], io)).toBe(0);
  for (const file of ["package.json", "tsconfig.json", "README.md", ".gitignore", "src/host.ts", "src/client.tsx"]) {
    expect((await stat(join(dir, file))).isFile()).toBe(true);
  }
  const manifest = parsePackageManifest(JSON.parse(await readFile(join(dir, "package.json"), "utf8")), appVersion);
  expect(manifest).toMatchObject({
    id: "demo-tab",
    displayName: "Demo Tab",
    paths: ["/demo-tab"],
    host: "./dist/host.js",
    client: "./dist/client.js",
    src: { host: "./src/host.ts", client: "./src/client.tsx" },
  });

  expect(await runPluginCli(["build", dir], io)).toBe(0);
  const client = await readFile(join(dir, "dist", "client.js"), "utf8");
  expect(client).toContain("globalThis.__specdriven");
  expect(client).not.toMatch(/from\s*["']react/);
  expect(client).not.toContain("ReactSharedInternals");
  const host = (await import(pathToFileURL(join(dir, "dist", "host.js")).href)) as { default: { name: string; apply: unknown } };
  expect(host.default.name).toBe("demo-tab");
  expect(typeof host.default.apply).toBe("function");

  expect(await runPluginCli(["link", dir], io)).toBe(0);
  const settings = (await readSettings(statePath(root))) as { plugins: { sources: { path: string }[] } };
  expect(settings.plugins.sources).toEqual([{ path: dir }]);
  // Linking twice keeps one entry.
  expect(await runPluginCli(["link", dir], io)).toBe(0);
  expect(((await readState(root)) as { plugins?: { sources?: unknown } }).plugins?.sources).toEqual([{ path: dir }]);

  // The loader takes the path source from the settings, like the app does.
  const state = (await readState(root)) as Record<string, unknown>;
  await syncPlugins(state, { sources: true, dataDir: null });
  const demo = pluginStates().find((p) => p.id === "demo-tab")!;
  expect(demo).toMatchObject({ source: "path", dir, installed: true, enabled: true, active: true });
  expect(demo.error).toBeUndefined();
  expect(matchApi("GET", "/api/demo-tab")).not.toBeNull();
  expect(shell.matches("/demo-tab/x")).toBe(true);
});

test("plugin new refuses a bad id or a folder in use, and an unknown command shows the usage", async () => {
  expect(await runPluginCli(["new", "Bad Id", join(work, "x")], io)).toBe(2);
  expect(lines.at(-1)).toContain("is not a plugin id");
  await writeFile(join(work, "taken"), "");
  expect(await runPluginCli(["new", "taken", work], io)).toBe(1);
  expect(lines.at(-1)).toContain("is not empty");
  expect(await runPluginCli(["frobnicate"], io)).toBe(2);
  expect(lines.at(-1)).toContain("Usage:");
  expect(await runPluginCli(["--help"], io)).toBe(0);
  expect(await runPluginCli(["link", join(work, "missing")], io)).toBe(1);
  // A scoped id scaffolds into the unscoped folder name and keeps the scope in the manifest.
  expect(await runPluginCli(["new", "@acme/jira-tab", join(work, "jira")], io)).toBe(0);
  const pkg = JSON.parse(await readFile(join(work, "jira", "package.json"), "utf8")) as { specdriven: { id: string; paths: string[] } };
  expect(pkg.specdriven.id).toBe("@acme/jira-tab");
  expect(pkg.specdriven.paths).toEqual(["/jira-tab"]);
});

test("plugin release adds package.json's version to the release folder as a zip, and never writes one again", async () => {
  const dir = join(work, "demo-tab");
  expect(await runPluginCli(["new", "demo-tab", dir], io)).toBe(0);
  expect(await runPluginCli(["release", dir, "--notes", "First release"], io)).toBe(0);

  // The zip holds what runs: the manifest, the built halves, the README — no sources, no maps.
  const zip = await readFile(join(dir, "release", "demo-tab-0.1.0.zip"));
  const entries = unzip(new Uint8Array(zip));
  expect(entries.map((e) => e.path)).toEqual(["README.md", "dist/client.js", "dist/host.js", "package.json"]);
  expect(new TextDecoder().decode(entries.find((e) => e.path === "package.json")!.data)).toBe(
    await readFile(join(dir, "package.json"), "utf8"),
  );
  // releases.json lists it with the zip's checksum and what the version needs of the app.
  const list = JSON.parse(await readFile(join(dir, "release", "releases.json"), "utf8"));
  expect(list.plugin).toBe("demo-tab");
  const [released] = parseReleases(list, "demo-tab");
  expect(released).toMatchObject({
    version: "0.1.0",
    file: "demo-tab-0.1.0.zip",
    sha256: createHash("sha256").update(zip).digest("hex"),
    size: zip.length,
    api: "1",
    minAppVersion: appVersion,
    notes: "First release",
  });
  expect(released!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(lines.some((l) => l.startsWith("Released demo-tab 0.1.0: "))).toBe(true);

  // The same version again is refused: the zip is the one that was released.
  expect(await runPluginCli(["release", dir], io)).toBe(1);
  expect(lines.at(-1)).toContain("demo-tab 0.1.0 is released already");
  expect(Buffer.from(await readFile(join(dir, "release", "demo-tab-0.1.0.zip"))).equals(zip)).toBe(true);

  // The next version goes on top; what the list held that this app does not know stays.
  const bump = async (version: string) => {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  };
  await writeFile(join(dir, "release", "releases.json"), JSON.stringify({ ...list, channel: "stable" }));
  await bump("0.2.0");
  expect(await runPluginCli(["release", dir], io)).toBe(0);
  const two = JSON.parse(await readFile(join(dir, "release", "releases.json"), "utf8"));
  expect(two.channel).toBe("stable");
  expect(parseReleases(two, "demo-tab").map((r) => r.version)).toEqual(["0.2.0", "0.1.0"]);
  expect(parseReleases(two, "demo-tab")[0]!.notes).toBeUndefined();

  // --keep drops the oldest versions past it, zip and row.
  await bump("0.3.0");
  expect(await runPluginCli(["release", dir, "--keep", "2"], io)).toBe(0);
  expect(lines.some((l) => l.includes("no longer kept: 0.1.0"))).toBe(true);
  const three = JSON.parse(await readFile(join(dir, "release", "releases.json"), "utf8"));
  expect(parseReleases(three, "demo-tab").map((r) => r.version)).toEqual(["0.3.0", "0.2.0"]);
  expect(await stat(join(dir, "release", "demo-tab-0.1.0.zip")).catch(() => null)).toBeNull();
  expect((await stat(join(dir, "release", "demo-tab-0.2.0.zip"))).isFile()).toBe(true);

  expect(await runPluginCli(["release", dir, "--keep", "many"], io)).toBe(2);
  expect(await runPluginCli(["release", dir, "--force"], io)).toBe(2);
  expect(lines.at(-1)).toContain('Unknown option "--force"');
});

test("plugin release keeps the newest ten versions when --keep does not say otherwise", async () => {
  // Shipped prebuilt — no src to build — so each release is only the zip.
  const dir = join(work, "prebuilt");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "host.js"), "export default { name: 'prebuilt', apply() {} };\n");
  const pkg = (version: string) =>
    JSON.stringify({ name: "prebuilt", version, specdriven: { id: "prebuilt", api: "1", host: "./dist/host.js" } });
  const listed = async () =>
    parseReleases(JSON.parse(await readFile(join(dir, RELEASE_DIR, RELEASES_FILE), "utf8")), "prebuilt").map((r) => r.version);

  for (let n = 1; n <= RELEASES_KEPT + 1; n++) {
    await writeFile(join(dir, "package.json"), pkg(`1.${n}.0`));
    expect(await runPluginCli(["release", dir], io)).toBe(0);
  }
  // Eleven released, ten kept: the oldest went, zip and row, newest first.
  const versions = await listed();
  expect(versions).toHaveLength(RELEASES_KEPT);
  expect(versions[0]).toBe(`1.${RELEASES_KEPT + 1}.0`);
  expect(versions.at(-1)).toBe("1.2.0");
  expect(await stat(join(dir, RELEASE_DIR, "prebuilt-1.1.0.zip")).catch(() => null)).toBeNull();
  expect((await stat(join(dir, RELEASE_DIR, "prebuilt-1.2.0.zip"))).isFile()).toBe(true);

  // --keep 0 keeps every version.
  await writeFile(join(dir, "package.json"), pkg("2.0.0"));
  expect(await runPluginCli(["release", dir, "--keep", "0"], io)).toBe(0);
  expect(await listed()).toHaveLength(RELEASES_KEPT + 1);
});
