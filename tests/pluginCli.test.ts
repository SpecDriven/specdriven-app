// The developer loop (roadmap/plugin-architecture.md "Developer loop"):
// `specdriven plugin new` scaffolds a plugin the app accepts, `plugin build`
// bundles both halves into dist/ over the app's React, and `plugin link`
// puts the folder in this machine's profile — from where the loader mounts
// it like any other folder plugin.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runPluginCli } from "../src/plugins/cli";
import { parsePackageManifest } from "../src/plugins/manifest";
import { pluginStates, shell, stopWatching, syncPlugins } from "../src/plugins/host/loader";
import { matchApi } from "../src/server/api";
import { readState, statePath } from "../src/server/state";
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
  const settings = JSON.parse(await readFile(statePath(root), "utf8")) as { plugins: { sources: { path: string }[] } };
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
